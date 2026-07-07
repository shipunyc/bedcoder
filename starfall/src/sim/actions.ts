// ============================================================================
// 动作核心:建筑入队 / 造舰入队。玩家 dispatch 与 AI 共用,确保不作弊。
// ============================================================================

import {
  BUILDINGS,
  buildingCost,
  buildingTime,
  canAfford,
  MAX_BUILDING_SLOTS,
  SHIPS,
  subRes,
} from './data';
import { genId } from './economy';
import type { BuildingType, GameState, Planet, PlayerSide, ShipType, StarSystem } from './types';

export interface ActionResult {
  ok: boolean;
  reason?: string;
}

function findPlanet(
  state: GameState,
  systemId: number,
  planetId: string
): { sys: StarSystem; planet: Planet } | null {
  const sys = state.systems[systemId];
  if (!sys) return null;
  const planet = sys.planets.find((p) => p.id === planetId);
  if (!planet) return null;
  return { sys, planet };
}

/** 该行星当前已建成 + 在队列中的不同建筑种类数(用于 6 格上限)。 */
function usedSlots(planet: Planet): number {
  const set = new Set<BuildingType>();
  for (const t of Object.keys(planet.buildings) as BuildingType[]) {
    if (planet.buildings[t] > 0) set.add(t);
  }
  for (const q of planet.buildQueue) set.add(q.buildingType);
  return set.size;
}

/** 队列中该建筑的最终目标等级(考虑已排队的升级)。 */
function pendingLevel(planet: Planet, type: BuildingType): number {
  let lvl = planet.buildings[type];
  for (const q of planet.buildQueue) {
    if (q.buildingType === type) lvl = Math.max(lvl, q.targetLevel);
  }
  return lvl;
}

export function queueBuildingCore(
  state: GameState,
  systemId: number,
  planetId: string,
  type: BuildingType,
  side: PlayerSide
): ActionResult {
  const found = findPlanet(state, systemId, planetId);
  if (!found) return { ok: false, reason: '无效行星' };
  const { planet } = found;
  if (planet.owner !== side) return { ok: false, reason: '非己方行星' };

  const def = BUILDINGS[type];
  const curTarget = pendingLevel(planet, type);
  const nextLevel = curTarget + 1;
  if (nextLevel > def.maxLevel) return { ok: false, reason: '已达最高等级' };

  // 新建(当前 0 且队列无)需占用建筑格
  const isNew = planet.buildings[type] === 0 && !planet.buildQueue.some((q) => q.buildingType === type);
  if (isNew && usedSlots(planet) >= MAX_BUILDING_SLOTS) {
    return { ok: false, reason: '建筑格已满' };
  }

  const cost = buildingCost(type, nextLevel);
  if (!canAfford(state.resources[side], cost)) return { ok: false, reason: '资源不足' };

  state.resources[side] = subRes(state.resources[side], cost);
  const time = buildingTime(type, nextLevel);
  planet.buildQueue.push({
    id: genId(state, 'bt'),
    buildingType: type,
    targetLevel: nextLevel,
    remaining: time,
    total: time,
  });
  return { ok: true };
}

export function queueShipCore(
  state: GameState,
  systemId: number,
  planetId: string,
  ship: ShipType,
  count: number,
  side: PlayerSide
): ActionResult {
  const found = findPlanet(state, systemId, planetId);
  if (!found) return { ok: false, reason: '无效行星' };
  const { planet } = found;
  if (planet.owner !== side) return { ok: false, reason: '非己方行星' };
  if (planet.buildings.shipyard <= 0) return { ok: false, reason: '需要造船厂' };
  if (count <= 0) return { ok: false, reason: '数量无效' };

  const def = SHIPS[ship];
  let queued = 0;
  for (let i = 0; i < count; i++) {
    if (!canAfford(state.resources[side], def.cost)) break;
    state.resources[side] = subRes(state.resources[side], def.cost);
    planet.shipQueue.push({
      id: genId(state, 'st'),
      shipType: ship,
      remaining: def.buildTime,
      total: def.buildTime,
    });
    queued++;
  }
  if (queued === 0) return { ok: false, reason: '资源不足' };
  return { ok: true };
}

export function cancelBuildCore(
  state: GameState,
  systemId: number,
  planetId: string,
  taskId: string,
  side: PlayerSide
): ActionResult {
  const found = findPlanet(state, systemId, planetId);
  if (!found || found.planet.owner !== side) return { ok: false };
  const q = found.planet.buildQueue;
  const idx = q.findIndex((t) => t.id === taskId);
  if (idx >= 0) {
    // 退还造价
    const t = q[idx]!;
    const refund = buildingCost(t.buildingType, t.targetLevel);
    state.resources[side].metal += refund.metal;
    state.resources[side].crystal += refund.crystal;
    state.resources[side].fuel += refund.fuel;
    q.splice(idx, 1);
    return { ok: true };
  }
  return { ok: false };
}

export function cancelShipCore(
  state: GameState,
  systemId: number,
  planetId: string,
  taskId: string,
  side: PlayerSide
): ActionResult {
  const found = findPlanet(state, systemId, planetId);
  if (!found || found.planet.owner !== side) return { ok: false };
  const q = found.planet.shipQueue;
  const idx = q.findIndex((t) => t.id === taskId);
  if (idx >= 0) {
    const t = q[idx]!;
    const refund = SHIPS[t.shipType].cost;
    state.resources[side].metal += refund.metal;
    state.resources[side].crystal += refund.crystal;
    state.resources[side].fuel += refund.fuel;
    q.splice(idx, 1);
    return { ok: true };
  }
  return { ok: false };
}
