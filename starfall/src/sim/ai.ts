// ============================================================================
// AI 对手:每 3 秒决策的状态机。经济 → 扩张 → 军事 → 进攻。
// 全程走与玩家相同的 action 接口,不作弊拿资源。
// ============================================================================

import { queueBuildingCore, queueShipCore } from './actions';
import {
  AI_DECISION_INTERVAL,
  buildingCost,
  canAfford,
  combatShips,
  fleetPower,
  SHIPS,
} from './data';
import { launchFleet, shortestPath, systemDefensePower } from './fleet';
import { mulberry32Step } from './rng';
import type {
  BuildingType,
  GameState,
  Planet,
  ShipCount,
  ShipType,
  StarSystem,
} from './types';

function aiRand(state: GameState): number {
  const r = mulberry32Step(state.rng);
  state.rng = r.next;
  return r.value;
}

const UPGRADE_CAP: Record<BuildingType, number> = {
  metalMine: 5,
  crystalExtractor: 4,
  fuelPlant: 4,
  shipyard: 3,
  defenseTurret: 3,
};
// 经济优先级:矿场 → 造船厂 → 防御 → 其他
const BUILD_PRIORITY: BuildingType[] = [
  'metalMine',
  'shipyard',
  'defenseTurret',
  'crystalExtractor',
  'fuelPlant',
];

function aiPlanets(state: GameState): { sys: StarSystem; planet: Planet }[] {
  const out: { sys: StarSystem; planet: Planet }[] = [];
  for (const sys of state.systems) {
    for (const p of sys.planets) {
      if (p.owner === 'ai') out.push({ sys, planet: p });
    }
  }
  return out;
}

function playerCombatMix(state: GameState): ShipCount {
  const mix: ShipCount = { corvette: 0, destroyer: 0, cruiser: 0, colony: 0 };
  for (const sys of state.systems) {
    if (sys.owner === 'player') {
      mix.corvette += sys.garrison.corvette;
      mix.destroyer += sys.garrison.destroyer;
      mix.cruiser += sys.garrison.cruiser;
    }
  }
  for (const f of state.fleets) {
    if (f.owner === 'player') {
      mix.corvette += f.ships.corvette;
      mix.destroyer += f.ships.destroyer;
      mix.cruiser += f.ships.cruiser;
    }
  }
  return mix;
}

/** 选择用于克制玩家主力的舰种。 */
function counterShip(mix: ShipCount): ShipType {
  const max = Math.max(mix.corvette, mix.destroyer, mix.cruiser);
  if (max <= 0) return 'corvette';
  if (mix.cruiser === max) return 'corvette'; // 护卫克巡洋
  if (mix.corvette === max) return 'destroyer'; // 驱逐克护卫
  return 'cruiser'; // 巡洋克驱逐
}

export function aiTick(state: GameState, dt: number): void {
  if (state.status !== 'playing') return;
  state.aiCooldown -= dt;
  if (state.aiCooldown > 0) return;
  state.aiCooldown = AI_DECISION_INTERVAL;

  const planets = aiPlanets(state);
  if (planets.length === 0) return;

  // ---- 1) 经济:每个空闲队列的行星按优先级升级一项 ----
  let buildBudget = 3;
  for (const { sys, planet } of planets) {
    if (buildBudget <= 0) break;
    if (planet.buildQueue.length > 0) continue;
    for (const type of BUILD_PRIORITY) {
      const cur = planet.buildings[type];
      if (cur >= UPGRADE_CAP[type]) continue;
      const cost = buildingCost(type, cur + 1);
      if (!canAfford(state.resources.ai, cost)) continue;
      const r = queueBuildingCore(state, sys.id, planet.id, type, 'ai');
      if (r.ok) {
        buildBudget--;
        break;
      }
    }
  }

  // ---- 2) 军事 + 扩张:在有造船厂的行星造舰 ----
  const yards = planets.filter((x) => x.planet.buildings.shipyard > 0 && x.planet.shipQueue.length === 0);
  const mix = playerCombatMix(state);
  const wantShip = counterShip(mix);
  // 统计现有中立可扩张星系
  const neutralTargets = state.systems.filter((s) => s.owner === 'neutral');
  const aiColonyInFlight =
    state.fleets.some((f) => f.owner === 'ai' && f.ships.colony > 0) ||
    aiPlanets(state).some((x) => x.planet.shipQueue.some((q) => q.shipType === 'colony')) ||
    state.systems.some((s) => s.owner === 'ai' && s.garrison.colony > 0);

  for (const { sys, planet } of yards) {
    // 优先扩张:资源充裕且有中立目标时造殖民船
    if (!aiColonyInFlight && neutralTargets.length > 0 && canAfford(state.resources.ai, SHIPS.colony.cost)) {
      queueShipCore(state, sys.id, planet.id, 'colony', 1, 'ai');
      continue;
    }
    // 造军舰(按克制玩家的舰种)
    if (canAfford(state.resources.ai, SHIPS[wantShip].cost)) {
      queueShipCore(state, sys.id, planet.id, wantShip, 1, 'ai');
    } else if (canAfford(state.resources.ai, SHIPS.corvette.cost)) {
      queueShipCore(state, sys.id, planet.id, 'corvette', 1, 'ai');
    }
  }

  // ---- 3) 派殖民船去最近的中立星系 ----
  for (const sys of state.systems) {
    if (sys.owner !== 'ai' || sys.garrison.colony <= 0) continue;
    const target = nearestNeutral(state, sys.id);
    if (target != null) {
      const ships: ShipCount = { corvette: 0, destroyer: 0, cruiser: 0, colony: sys.garrison.colony };
      // 随行少量护卫
      const escort = Math.min(sys.garrison.corvette, 2);
      ships.corvette = escort;
      launchFleet(state, sys.id, target, ships);
    }
  }

  // ---- 4) 进攻:集结点战力足够则出击 ----
  aiOffense(state);
}

function nearestNeutral(state: GameState, from: number): number | null {
  let best: number | null = null;
  let bestLen = Infinity;
  for (const sys of state.systems) {
    if (sys.owner !== 'neutral') continue;
    const path = shortestPath(state, from, sys.id);
    if (path && path.length < bestLen) {
      bestLen = path.length;
      best = sys.id;
    }
  }
  return best;
}

function aiOffense(state: GameState): void {
  // 找 AI 战力最强的集结星系
  let rally: StarSystem | null = null;
  let rallyPower = 0;
  for (const sys of state.systems) {
    if (sys.owner !== 'ai') continue;
    if (combatShips(sys.garrison) <= 0) continue;
    const p = fleetPower(sys.garrison);
    if (p > rallyPower) {
      rallyPower = p;
      rally = sys;
    }
  }
  if (!rally || rallyPower <= 0) return;

  // 候选目标:玩家/中立星系(排除玩家母星,除非 10% 骚扰)
  const harass = aiRand(state) < 0.1;
  let bestTarget: StarSystem | null = null;
  let bestScore = Infinity; // 越近越优先
  for (const sys of state.systems) {
    const isPlayer = sys.owner === 'player';
    const isNeutral = sys.owner === 'neutral';
    if (!isPlayer && !isNeutral) continue;
    if (sys.id === state.playerHomeId && !harass) continue;
    const path = shortestPath(state, rally.id, sys.id);
    if (!path || path.length === 0) continue;
    // 目标估值(守军 + 防御)
    const defVal = fleetPower(sys.garrison) + systemDefensePower(sys, 'player') * 1.3;
    if (rallyPower > defVal * 1.3) {
      // 可攻:优先最近的前沿(争议区/玩家系)
      const priority = isPlayer ? path.length : path.length + 3;
      if (priority < bestScore) {
        bestScore = priority;
        bestTarget = sys;
      }
    }
  }

  if (bestTarget && rally) {
    // 派出大部分战舰(留 1 护卫看家)
    const g = rally.garrison;
    const send: ShipCount = {
      corvette: Math.max(0, g.corvette - 1),
      destroyer: g.destroyer,
      cruiser: g.cruiser,
      colony: 0,
    };
    if (send.corvette + send.destroyer + send.cruiser > 0) {
      launchFleet(state, rally.id, bestTarget.id, send);
      state.aiRally = rally.id;
    }
  }
}
