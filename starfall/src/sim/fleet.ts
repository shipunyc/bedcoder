// ============================================================================
// 舰队:出击、逐跳移动、燃料扣除、遭遇战触发与战后结算。
// ============================================================================

import { resolveCombat, survivors } from './combat';
import {
  combatShips,
  fleetSize,
  FUEL_PER_SIZE,
  HOP_BASE_TIME,
  SHIPS,
  ZERO_SHIPS,
} from './data';
import { genId, log } from './economy';
import { mulberry32Step } from './rng';
import type { Fleet, GameState, PlayerSide, ShipCount, ShipType, StarSystem } from './types';

const SHIP_KEYS: ShipType[] = ['corvette', 'destroyer', 'cruiser', 'colony'];

/** 推进主 rng,返回一个整数种子(供战斗使用,保持确定性)。 */
function nextSeed(state: GameState): number {
  const r = mulberry32Step(state.rng);
  state.rng = r.next;
  return (r.value * 0xffffffff) | 0;
}

/** 舰队每跳耗时:8 秒 ÷ 最慢舰速度系数。 */
export function hopTime(ships: ShipCount): number {
  let slowest = 1.2;
  for (const k of SHIP_KEYS) {
    if (ships[k] > 0) slowest = Math.min(slowest, SHIPS[k].speed);
  }
  return HOP_BASE_TIME / slowest;
}

/** 单跳燃料消耗。 */
export function hopFuel(ships: ShipCount): number {
  return fleetSize(ships) * FUEL_PER_SIZE;
}

/** BFS 最短路径(按跳数),返回从 from 出发要依次抵达的星系(不含 from)。 */
export function shortestPath(state: GameState, from: number, to: number): number[] | null {
  if (from === to) return [];
  const prev = new Map<number, number>();
  const q = [from];
  const seen = new Set<number>([from]);
  while (q.length) {
    const cur = q.shift()!;
    for (const nb of state.systems[cur]!.neighbors) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      prev.set(nb, cur);
      if (nb === to) {
        const path: number[] = [];
        let c = to;
        while (c !== from) {
          path.unshift(c);
          c = prev.get(c)!;
        }
        return path;
      }
      q.push(nb);
    }
  }
  return null;
}

/** 星系对某方的防御力(炮台之和,线性 200×级)。 */
export function systemDefensePower(sys: StarSystem, owner: PlayerSide): number {
  let d = 0;
  for (const p of sys.planets) {
    if (p.owner === owner) d += 200 * p.buildings.defenseTurret;
  }
  return d;
}

function subShips(a: ShipCount, b: ShipCount): ShipCount {
  return {
    corvette: a.corvette - b.corvette,
    destroyer: a.destroyer - b.destroyer,
    cruiser: a.cruiser - b.cruiser,
    colony: a.colony - b.colony,
  };
}
function addShips(a: ShipCount, b: ShipCount): ShipCount {
  return {
    corvette: a.corvette + b.corvette,
    destroyer: a.destroyer + b.destroyer,
    cruiser: a.cruiser + b.cruiser,
    colony: a.colony + b.colony,
  };
}
function hasShips(g: ShipCount, need: ShipCount): boolean {
  return SHIP_KEYS.every((k) => g[k] >= need[k]);
}

export interface LaunchResult {
  ok: boolean;
  reason?: string;
}

/** 出击:从 from 星系派舰队前往 to。owner 由 from 星系归属推断。 */
export function launchFleet(
  state: GameState,
  from: number,
  to: number,
  ships: ShipCount
): LaunchResult {
  const sys = state.systems[from];
  if (!sys) return { ok: false, reason: '无效星系' };
  const owner = sys.owner;
  if (owner !== 'player' && owner !== 'ai') return { ok: false, reason: '非己方星系' };
  if (fleetSize(ships) <= 0) return { ok: false, reason: '未选择舰船' };
  if (!hasShips(sys.garrison, ships)) return { ok: false, reason: '驻军不足' };
  const path = shortestPath(state, from, to);
  if (!path || path.length === 0) return { ok: false, reason: '目标不可达' };
  const fuel = hopFuel(ships);
  if (state.resources[owner].fuel < fuel) return { ok: false, reason: '燃料不足' };

  state.resources[owner].fuel -= fuel;
  sys.garrison = subShips(sys.garrison, ships);

  const fleet: Fleet = {
    id: genId(state, 'fleet'),
    owner,
    ships: { ...ships },
    origin: from,
    currentSystem: from,
    route: path,
    hopElapsed: 0,
    hopDuration: hopTime(ships),
  };
  state.fleets.push(fleet);
  return { ok: true };
}

function removeFleet(state: GameState, fleet: Fleet): void {
  const i = state.fleets.indexOf(fleet);
  if (i >= 0) state.fleets.splice(i, 1);
}

function mergeGarrison(sys: StarSystem, ships: ShipCount): void {
  sys.garrison = addShips(sys.garrison, ships);
}

function colonizeNeutralPlanets(state: GameState, sys: StarSystem, fleet: Fleet): void {
  if (fleet.ships.colony <= 0) return;
  const owner = fleet.owner;
  let available = fleet.ships.colony;
  for (const p of sys.planets) {
    if (available <= 0) break;
    if (p.owner === 'neutral') {
      p.owner = owner;
      p.buildings.metalMine = Math.max(p.buildings.metalMine, 1);
      available -= 1;
      if (owner === 'player') {
        log(state, { kind: 'colonize', side: 'player', text: `殖民 ${p.name}` });
      }
    }
  }
  fleet.ships.colony = available;
}

function captureSystem(state: GameState, sys: StarSystem, newOwner: PlayerSide): void {
  const old = sys.owner;
  sys.owner = newOwner;
  for (const p of sys.planets) {
    if (p.owner === old && old !== 'neutral') p.owner = newOwner;
  }
  sys.garrison = { ...ZERO_SHIPS };
  state.stats[newOwner].systemsCaptured += 1;
  if (newOwner === 'player' || old === 'player') {
    log(state, {
      kind: 'capture',
      side: newOwner,
      text:
        newOwner === 'player'
          ? `我方占领 ${sys.name} 星系`
          : `⚠ ${sys.name} 星系被敌方占领`,
    });
  }
}

function isHome(state: GameState, sysId: number): boolean {
  return sysId === state.playerHomeId || sysId === state.aiHomeId;
}

/** 处理舰队抵达某星系(可能触发战斗/占领/殖民/合流)。返回舰队是否仍在移动。 */
function processArrival(state: GameState, fleet: Fleet, sysId: number, isFinal: boolean): boolean {
  const sys = state.systems[sysId]!;
  fleet.currentSystem = sysId;
  const O = fleet.owner;

  // 友方星系:殖民顺带,终点则合流
  if (sys.owner === O) {
    colonizeNeutralPlanets(state, sys, fleet);
    if (isFinal) {
      mergeGarrison(sys, fleet.ships);
      removeFleet(state, fleet);
      return false;
    }
    return true;
  }

  const defenderOwner = sys.owner;
  const defPower = defenderOwner === 'neutral' ? 0 : systemDefensePower(sys, defenderOwner);
  const defenders = { ...sys.garrison };
  const hasDefenders = combatShips(defenders) > 0 || defPower > 0;

  if (!hasDefenders) {
    // 无守军:中立占据 / 敌方无防守易主(母星除外)
    if (defenderOwner !== 'neutral' && isHome(state, sysId)) {
      // 敌方母星无法夺取 → 撤退
      return retreat(state, fleet);
    }
    if (defenderOwner === 'neutral') {
      sys.owner = O;
    } else {
      captureSystem(state, sys, O);
    }
    colonizeNeutralPlanets(state, sys, fleet);
    if (isFinal) {
      mergeGarrison(sys, fleet.ships);
      removeFleet(state, fleet);
      return false;
    }
    return true;
  }

  // 有守军 → 战斗
  const enemySide: PlayerSide = defenderOwner === 'neutral' ? (O === 'player' ? 'ai' : 'player') : defenderOwner;
  const reportId = genId(state, 'battle');
  const report = resolveCombat(
    {
      systemId: sysId,
      systemName: sys.name,
      attackerOwner: O,
      defenderOwner,
      attacker: fleet.ships,
      defender: defenders,
      defensePower: defPower,
      seed: nextSeed(state),
    },
    reportId
  );
  state.battles[reportId] = report;

  const surv = survivors(report);
  // 击杀统计
  const attLost = totalCombat(report.attackerLosses);
  const defLost = totalCombat(report.defenderLosses);
  state.stats[O].kills += defLost;
  state.stats[O].shipsLost += attLost;
  if (defenderOwner !== 'neutral') {
    state.stats[enemySide].kills += attLost;
    state.stats[enemySide].shipsLost += defLost;
  }

  log(state, {
    kind: 'battle',
    side: O,
    battleId: reportId,
    text: `${sys.name} 爆发战斗:${
      report.result === 'attackerWin'
        ? (O === 'player' ? '我方胜' : '敌方胜')
        : report.result === 'defenderWin'
          ? (O === 'player' ? '我方败退' : '敌方败退')
          : '交战撤离'
    }`,
  });

  // 更新守军为防守方幸存
  sys.garrison = surv.defender;

  if (report.result === 'attackerWin') {
    fleet.ships = surv.attacker;
    if (isHome(state, sysId)) {
      // 母星不易主 → 攻方撤退
      return retreat(state, fleet);
    }
    captureSystem(state, sys, O);
    mergeGarrison(sys, fleet.ships);
    removeFleet(state, fleet);
    return false;
  } else {
    // 防守成功或撤退:攻方幸存撤回
    fleet.ships = surv.attacker;
    if (fleetSize(fleet.ships) <= 0) {
      removeFleet(state, fleet);
      return false;
    }
    return retreat(state, fleet);
  }
}

function totalCombat(s: ShipCount): number {
  return s.corvette + s.destroyer + s.cruiser + s.colony;
}

/** 让舰队撤回出发星系。 */
function retreat(state: GameState, fleet: Fleet): boolean {
  const back = shortestPath(state, fleet.currentSystem, fleet.origin);
  if (!back || back.length === 0) {
    // 已在原点或无路:就地合流(若友方)否则解散
    const sys = state.systems[fleet.currentSystem]!;
    if (sys.owner === fleet.owner) mergeGarrison(sys, fleet.ships);
    removeFleet(state, fleet);
    return false;
  }
  fleet.route = back;
  fleet.hopElapsed = 0;
  fleet.hopDuration = hopTime(fleet.ships);
  return true;
}

/** 每帧推进所有舰队。 */
export function fleetTick(state: GameState, dt: number): void {
  // 复制引用快照,处理期间可能移除
  const fleets = state.fleets.slice();
  for (const fleet of fleets) {
    if (!state.fleets.includes(fleet)) continue;
    if (fleet.route.length === 0) {
      // 异常:无路径的舰队,合流处理
      const sys = state.systems[fleet.currentSystem]!;
      if (sys.owner === fleet.owner) mergeGarrison(sys, fleet.ships);
      removeFleet(state, fleet);
      continue;
    }
    fleet.hopElapsed += dt;
    // 可能一帧跨多跳
    let guard = 0;
    while (fleet.route.length > 0 && fleet.hopElapsed >= fleet.hopDuration && guard < 8) {
      guard++;
      fleet.hopElapsed -= fleet.hopDuration;
      const arrived = fleet.route.shift()!;
      const isFinal = fleet.route.length === 0;
      const stillMoving = processArrival(state, fleet, arrived, isFinal);
      if (!stillMoving || !state.fleets.includes(fleet)) break;
      // 下一跳:扣燃料
      if (fleet.route.length > 0) {
        const fuel = hopFuel(fleet.ships);
        if (state.resources[fleet.owner].fuel < fuel) {
          // 燃料不足:就地停留(友方合流,否则原地)
          const sys = state.systems[fleet.currentSystem]!;
          if (sys.owner === fleet.owner) {
            mergeGarrison(sys, fleet.ships);
            removeFleet(state, fleet);
          } else {
            fleet.route = [];
          }
          break;
        }
        state.resources[fleet.owner].fuel -= fuel;
        fleet.hopDuration = hopTime(fleet.ships);
      }
    }
  }
}

/** UI 出击预估:从 from 到 to 的跳数、总耗时、总燃料。 */
export function estimateTravel(
  state: GameState,
  from: number,
  to: number,
  ships: ShipCount
): { hops: number; time: number; fuel: number } | null {
  const path = shortestPath(state, from, to);
  if (!path) return null;
  const hops = path.length;
  return { hops, time: hops * hopTime(ships), fuel: hops * hopFuel(ships) };
}
