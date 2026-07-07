// ============================================================================
// 经济 tick:资源产出、建筑队列、造舰队列(均串行、确定性)。
// ============================================================================

import { BUILDINGS, buildingOutput, planetBonus, SHIPS } from './data';
import type { GameState, LogEntry, PlayerSide, Resources, ShipType } from './types';

/** 造船厂等级 → 造舰速度倍率(每级 +20%)。 */
export function shipyardSpeed(level: number): number {
  if (level <= 0) return 0;
  return 1 + 0.2 * (level - 1);
}

/** 某方当前每秒资源产出(供 HUD 增量显示)。 */
export function computeIncome(state: GameState, side: PlayerSide): Resources {
  const inc: Resources = { metal: 0, crystal: 0, fuel: 0 };
  for (const sys of state.systems) {
    for (const p of sys.planets) {
      if (p.owner !== side) continue;
      inc.metal += buildingOutput('metalMine', p.buildings.metalMine) * planetBonus(p.type, 'metal');
      inc.crystal +=
        buildingOutput('crystalExtractor', p.buildings.crystalExtractor) *
        planetBonus(p.type, 'crystal');
      inc.fuel += buildingOutput('fuelPlant', p.buildings.fuelPlant) * planetBonus(p.type, 'fuel');
    }
  }
  return inc;
}

function pushLog(state: GameState, e: Omit<LogEntry, 'id' | 'time'>): void {
  state.log.unshift({ id: `log${state.nextId++}`, time: state.time, ...e });
  if (state.log.length > 120) state.log.length = 120;
}

export function economyTick(state: GameState, dt: number): void {
  // 1) 资源产出
  const inc: Record<PlayerSide, Resources> = {
    player: computeIncome(state, 'player'),
    ai: computeIncome(state, 'ai'),
  };
  for (const side of ['player', 'ai'] as PlayerSide[]) {
    const r = state.resources[side];
    r.metal += inc[side].metal * dt;
    r.crystal += inc[side].crystal * dt;
    r.fuel += inc[side].fuel * dt;
  }

  // 2) 建筑与造舰队列
  for (const sys of state.systems) {
    for (const p of sys.planets) {
      if (p.owner === 'neutral') continue;

      // 建筑队列(串行)
      const bt = p.buildQueue[0];
      if (bt) {
        bt.remaining -= dt;
        if (bt.remaining <= 0) {
          p.buildings[bt.buildingType] = bt.targetLevel;
          p.buildQueue.shift();
          if (p.owner === 'player') {
            pushLog(state, {
              kind: 'build',
              side: 'player',
              text: `${p.name} 的${BUILDINGS[bt.buildingType].name}完成建造(Lv${bt.targetLevel})`,
            });
          }
        }
      }

      // 造舰队列(串行,受造船厂等级加速)
      const st = p.shipQueue[0];
      if (st) {
        const speed = shipyardSpeed(p.buildings.shipyard) || 1;
        st.remaining -= dt * speed;
        if (st.remaining <= 0) {
          sys.garrison[st.shipType] += 1;
          state.stats[p.owner].shipsBuilt += 1;
          p.shipQueue.shift();
          if (p.owner === 'player') {
            pushLog(state, {
              kind: 'ship',
              side: 'player',
              text: `${sys.name} 建成 1 艘${SHIPS[st.shipType].name}`,
            });
          }
        }
      }
    }
  }
}

/** 供外部复用的日志推送。 */
export function log(state: GameState, e: Omit<LogEntry, 'id' | 'time'>): void {
  pushLog(state, e);
}

/** 生成确定性唯一 id。 */
export function genId(state: GameState, prefix: string): string {
  return `${prefix}${state.nextId++}`;
}

/** 计算造舰完成所需时间(考虑造船厂加速,用于 UI 进度估算)。 */
export function shipBuildTime(shipType: ShipType, shipyardLevel: number): number {
  const speed = shipyardSpeed(shipyardLevel) || 1;
  return SHIPS[shipType].buildTime / speed;
}
