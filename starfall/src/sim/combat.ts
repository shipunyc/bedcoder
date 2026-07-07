// ============================================================================
// 战斗解算(确定性):输入双方编成 + 种子 → 瞬间算完全部回合 → BattleReport。
// 3D 观看器与文字战报共用同一份 RoundEvent 数组。
// ============================================================================

import { counters, SHIPS, SHIP_TYPES, ZERO_SHIPS } from './data';
import { SeededRandom } from './rng';
import type {
  BattleReport,
  CombatResult,
  FireEvent,
  PlayerSide,
  Owner,
  RoundEvent,
  ShipCount,
  ShipType,
  StackSnapshot,
} from './types';

const MAX_ROUNDS = 30;

interface Stack {
  side: 'attacker' | 'defender';
  kind: ShipType | 'defense';
  unitHp: number;
  firepower: number; // 每单位火力
  pool: number; // 剩余总耐久
  count: number; // 当前艘数(= ceil(pool/unitHp))
}

function makeShipStacks(side: 'attacker' | 'defender', ships: ShipCount): Stack[] {
  const stacks: Stack[] = [];
  for (const k of SHIP_TYPES) {
    const n = ships[k];
    if (n <= 0) continue;
    const def = SHIPS[k];
    stacks.push({
      side,
      kind: k,
      unitHp: def.hp,
      firepower: def.firepower,
      pool: def.hp * n,
      count: n,
    });
  }
  return stacks;
}

function makeDefenseStack(defensePower: number): Stack | null {
  if (defensePower <= 0) return null;
  return {
    side: 'defender',
    kind: 'defense',
    unitHp: defensePower * 2,
    firepower: defensePower * 0.3,
    pool: defensePower * 2,
    count: 1,
  };
}

function counterMult(from: ShipType | 'defense', to: ShipType | 'defense'): number {
  if (from === 'defense' || to === 'defense') return 1;
  return counters(from, to) ? 1.5 : 1;
}

function snapshot(stacks: Stack[], side: 'attacker' | 'defender'): StackSnapshot[] {
  return stacks
    .filter((s) => s.side === side && s.count > 0)
    .map((s) => ({ side, kind: s.kind, count: s.count }));
}

function combatAlive(stacks: Stack[], side: 'attacker' | 'defender'): boolean {
  return stacks.some((s) => s.side === side && s.count > 0 && s.firepower > 0);
}

/** 为一个开火 stack 选目标:优先被自己克制的敌方舰种,否则轮转分配。 */
function chooseTarget(
  attacker: Stack,
  enemies: Stack[],
  spreadIndex: number
): Stack | null {
  const live = enemies.filter((s) => s.count > 0);
  if (live.length === 0) return null;
  const countered = live.filter((s) => counterMult(attacker.kind, s.kind) > 1);
  if (countered.length > 0) {
    return countered[spreadIndex % countered.length]!;
  }
  return live[spreadIndex % live.length]!;
}

function toShipCount(rec: Partial<Record<ShipType, number>>): ShipCount {
  return {
    corvette: rec.corvette ?? 0,
    destroyer: rec.destroyer ?? 0,
    cruiser: rec.cruiser ?? 0,
    colony: rec.colony ?? 0,
  };
}

export interface CombatInput {
  systemId: number;
  systemName: string;
  attackerOwner: PlayerSide;
  defenderOwner: Owner;
  attacker: ShipCount;
  defender: ShipCount;
  defensePower: number;
  seed: number;
}

export function resolveCombat(input: CombatInput, reportId: string): BattleReport {
  const rnd = new SeededRandom(input.seed ^ 0x9e3779b9);
  const stacks: Stack[] = [
    ...makeShipStacks('attacker', input.attacker),
    ...makeShipStacks('defender', input.defender),
  ];
  const defenseStack = makeDefenseStack(input.defensePower);
  if (defenseStack) stacks.push(defenseStack);

  const initialAttacker = snapshot(stacks, 'attacker');
  const initialDefender = snapshot(stacks, 'defender');

  const rounds: RoundEvent[] = [];
  let result: CombatResult = 'attackerRetreat';

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (!combatAlive(stacks, 'attacker')) {
      result = 'defenderWin';
      break;
    }
    if (!combatAlive(stacks, 'defender')) {
      result = 'attackerWin';
      break;
    }

    const fires: FireEvent[] = [];
    // 以回合开始时的编成快照计算(同步开火),伤害累计后统一结算。
    const damageTo = new Map<Stack, number>();
    const firing = stacks.filter((s) => s.count > 0 && s.firepower > 0);
    let spread = 0;
    for (const s of firing) {
      const enemies = stacks.filter((e) => e.side !== s.side);
      const target = chooseTarget(s, enemies, spread++);
      if (!target) continue;
      const mult = counterMult(s.kind, target.kind);
      const jitter = rnd.range(0.9, 1.1);
      const dmg = s.firepower * s.count * mult * jitter;
      damageTo.set(target, (damageTo.get(target) ?? 0) + dmg);
      fires.push({
        fromSide: s.side,
        fromKind: s.kind,
        toSide: target.side,
        toKind: target.kind,
        damage: dmg,
        killed: 0, // 结算后回填
        crit: mult > 1,
      });
    }

    // 结算伤害与折损
    const killedByStack = new Map<Stack, number>();
    for (const [stack, dmg] of damageTo) {
      const before = stack.count;
      stack.pool = Math.max(0, stack.pool - dmg);
      stack.count = Math.max(0, Math.ceil(stack.pool / stack.unitHp - 1e-9));
      killedByStack.set(stack, before - stack.count);
    }
    // 回填每条 fire 的击毁数(按伤害占比近似分摊到该 stack 的总击毁)
    const dmgTotalPerStack = new Map<Stack, number>();
    for (const f of fires) {
      // 找到对应 target stack:同 side 同 kind 唯一
      const st = stacks.find((s) => s.side === f.toSide && s.kind === f.toKind);
      if (st) dmgTotalPerStack.set(st, (dmgTotalPerStack.get(st) ?? 0) + f.damage);
    }
    for (const f of fires) {
      const st = stacks.find((s) => s.side === f.toSide && s.kind === f.toKind);
      if (!st) continue;
      const totalKilled = killedByStack.get(st) ?? 0;
      const share = (dmgTotalPerStack.get(st) ?? 1) > 0 ? f.damage / (dmgTotalPerStack.get(st) ?? 1) : 0;
      f.killed = Math.round(totalKilled * share);
    }

    rounds.push({
      round,
      fires,
      attacker: snapshot(stacks, 'attacker'),
      defender: snapshot(stacks, 'defender'),
    });

    // 回合末判定
    if (!combatAlive(stacks, 'defender')) {
      result = 'attackerWin';
      break;
    }
    if (!combatAlive(stacks, 'attacker')) {
      result = 'defenderWin';
      break;
    }
  }

  // 损失统计
  const finalAtt = toShipCount(
    Object.fromEntries(
      stacks.filter((s) => s.side === 'attacker').map((s) => [s.kind, s.count])
    ) as Partial<Record<ShipType, number>>
  );
  const finalDef = toShipCount(
    Object.fromEntries(
      stacks.filter((s) => s.side === 'defender' && s.kind !== 'defense').map((s) => [s.kind, s.count])
    ) as Partial<Record<ShipType, number>>
  );
  const attackerLosses = subtractShips(input.attacker, finalAtt);
  const defenderLosses = subtractShips(input.defender, finalDef);
  const defenseStackFinal = stacks.find((s) => s.kind === 'defense');
  const defenseDestroyed = input.defensePower > 0 && (!defenseStackFinal || defenseStackFinal.count <= 0);

  return {
    id: reportId,
    systemId: input.systemId,
    systemName: input.systemName,
    attackerOwner: input.attackerOwner,
    defenderOwner: input.defenderOwner,
    initialAttacker,
    initialDefender,
    rounds,
    result,
    attackerLosses,
    defenderLosses,
    defenseDestroyed,
  };
}

function subtractShips(a: ShipCount, b: ShipCount): ShipCount {
  return {
    corvette: Math.max(0, a.corvette - b.corvette),
    destroyer: Math.max(0, a.destroyer - b.destroyer),
    cruiser: Math.max(0, a.cruiser - b.cruiser),
    colony: Math.max(0, a.colony - b.colony),
  };
}

/** 剩余舰队(战后回收给撤退方/胜方)。 */
export function survivors(report: BattleReport): { attacker: ShipCount; defender: ShipCount } {
  const attacker = subtractShips(reportInitial(report.initialAttacker), report.attackerLosses);
  const defender = subtractShips(reportInitial(report.initialDefender), report.defenderLosses);
  return { attacker, defender };
}

function reportInitial(snaps: StackSnapshot[]): ShipCount {
  const rec: Partial<Record<ShipType, number>> = {};
  for (const s of snaps) {
    if (s.kind === 'defense') continue;
    rec[s.kind] = s.count;
  }
  return { ...ZERO_SHIPS, ...rec };
}
