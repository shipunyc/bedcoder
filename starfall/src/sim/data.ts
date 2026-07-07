// ============================================================================
// 游戏平衡数据:建筑、舰船、克制关系、经济系数。
// ============================================================================

import type {
  BuildingType,
  PlanetType,
  ResourceKind,
  Resources,
  ShipCount,
  ShipType,
} from './types';

export const ZERO_RES: Resources = { metal: 0, crystal: 0, fuel: 0 };
export const ZERO_SHIPS: ShipCount = { corvette: 0, destroyer: 0, cruiser: 0, colony: 0 };

export const SHIP_TYPES: ShipType[] = ['corvette', 'destroyer', 'cruiser', 'colony'];
export const BUILDING_TYPES: BuildingType[] = [
  'metalMine',
  'crystalExtractor',
  'fuelPlant',
  'shipyard',
  'defenseTurret',
];

export const RESOURCE_KINDS: ResourceKind[] = ['metal', 'crystal', 'fuel'];

// ---- 建筑定义 ----

export interface BuildingDef {
  type: BuildingType;
  name: string;
  icon: string;
  maxLevel: number;
  baseCost: Resources; // Lv1 造价
  baseTime: number; // Lv1 建造耗时(秒)
  costMul: number; // 每级造价倍率
  timeMul: number; // 每级耗时倍率
  outputMul: number; // 每级产出倍率
  /** Lv1 基础产出/效果值(含义随建筑而定)。 */
  baseValue: number;
  desc: string;
}

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  metalMine: {
    type: 'metalMine',
    name: '金属矿场',
    icon: '⛏',
    maxLevel: 5,
    baseCost: { metal: 60, crystal: 30, fuel: 0 },
    baseTime: 5,
    costMul: 1.6,
    timeMul: 1.6,
    outputMul: 1.3,
    baseValue: 8,
    desc: '开采金属。金属 +8/秒(Lv1)',
  },
  crystalExtractor: {
    type: 'crystalExtractor',
    name: '晶体萃取厂',
    icon: '◈',
    maxLevel: 5,
    baseCost: { metal: 70, crystal: 30, fuel: 0 },
    baseTime: 5,
    costMul: 1.6,
    timeMul: 1.6,
    outputMul: 1.3,
    baseValue: 5,
    desc: '萃取晶体。晶体 +5/秒(Lv1)',
  },
  fuelPlant: {
    type: 'fuelPlant',
    name: '燃料化工厂',
    icon: '⬢',
    maxLevel: 5,
    baseCost: { metal: 70, crystal: 40, fuel: 0 },
    baseTime: 5,
    costMul: 1.6,
    timeMul: 1.6,
    outputMul: 1.3,
    baseValue: 4,
    desc: '合成燃料。燃料 +4/秒(Lv1)',
  },
  shipyard: {
    type: 'shipyard',
    name: '造船厂',
    icon: '⚓',
    maxLevel: 5,
    baseCost: { metal: 120, crystal: 80, fuel: 20 },
    baseTime: 5,
    costMul: 1.6,
    timeMul: 1.6,
    outputMul: 1.3,
    baseValue: 0,
    desc: '解锁造舰;每级造舰速度 +20%',
  },
  defenseTurret: {
    type: 'defenseTurret',
    name: '防御炮台',
    icon: '⊕',
    maxLevel: 5,
    baseCost: { metal: 100, crystal: 60, fuel: 30 },
    baseTime: 5,
    costMul: 1.6,
    timeMul: 1.6,
    outputMul: 1.3,
    baseValue: 200,
    desc: '行星防御力 = 200 × 级(虚拟守军)',
  },
};

/** 建筑第 level 级的造价。 */
export function buildingCost(type: BuildingType, level: number): Resources {
  const d = BUILDINGS[type];
  const m = Math.pow(d.costMul, level - 1);
  return {
    metal: Math.round(d.baseCost.metal * m),
    crystal: Math.round(d.baseCost.crystal * m),
    fuel: Math.round(d.baseCost.fuel * m),
  };
}

/** 建筑第 level 级的建造耗时(秒)。 */
export function buildingTime(type: BuildingType, level: number): number {
  const d = BUILDINGS[type];
  return d.baseTime * Math.pow(d.timeMul, level - 1);
}

/** 采集类建筑第 level 级的产出值。 */
export function buildingOutput(type: BuildingType, level: number): number {
  const d = BUILDINGS[type];
  if (level <= 0) return 0;
  return d.baseValue * Math.pow(d.outputMul, level - 1);
}

// ---- 行星类型资源倾向 ----

export const PLANET_LABEL: Record<PlanetType, string> = {
  rock: '岩石行星',
  gas: '气态行星',
  ice: '冰晶行星',
};

export const PLANET_ICON: Record<PlanetType, string> = {
  rock: '🜨',
  gas: '🜁',
  ice: '❄',
};

/** 行星类型对某资源的产出加成系数。 */
export function planetBonus(pt: PlanetType, res: ResourceKind): number {
  if (pt === 'rock' && res === 'metal') return 1.5;
  if (pt === 'ice' && res === 'crystal') return 1.5;
  if (pt === 'gas' && res === 'fuel') return 1.5;
  return 1;
}

// ---- 舰船定义 ----

export interface ShipDef {
  type: ShipType;
  name: string;
  icon: string;
  cost: Resources;
  hp: number;
  firepower: number;
  speed: number; // 速度系数:快1.2 中1.0 慢0.8
  buildTime: number;
  desc: string;
}

export const SHIPS: Record<ShipType, ShipDef> = {
  corvette: {
    type: 'corvette',
    name: '护卫舰',
    icon: '△',
    cost: { metal: 80, crystal: 40, fuel: 20 },
    hp: 300,
    firepower: 40,
    speed: 1.2,
    buildTime: 6,
    desc: '轻快敏捷,克制巡洋舰',
  },
  destroyer: {
    type: 'destroyer',
    name: '驱逐舰',
    icon: '◆',
    cost: { metal: 240, crystal: 140, fuel: 60 },
    hp: 700,
    firepower: 100,
    speed: 1.0,
    buildTime: 15,
    desc: '中坚力量,克制护卫舰',
  },
  cruiser: {
    type: 'cruiser',
    name: '巡洋舰',
    icon: '⬣',
    cost: { metal: 800, crystal: 500, fuel: 200 },
    hp: 1800,
    firepower: 250,
    speed: 0.8,
    buildTime: 40,
    desc: '主力战舰,克制驱逐舰',
  },
  colony: {
    type: 'colony',
    name: '殖民船',
    icon: '⬡',
    cost: { metal: 300, crystal: 200, fuel: 100 },
    hp: 500,
    firepower: 0,
    speed: 0.8,
    buildTime: 20,
    desc: '殖民中立行星,抵达即消耗',
  },
};

/**
 * 克制环:护卫→巡洋→驱逐→护卫(→ 为克制,伤害 ×1.5)。
 * counters[a][b] = true 表示 a 克制 b。
 */
export const COUNTERS: Partial<Record<ShipType, ShipType>> = {
  corvette: 'cruiser',
  cruiser: 'destroyer',
  destroyer: 'corvette',
};

export function counters(attacker: ShipType, defender: ShipType): boolean {
  return COUNTERS[attacker] === defender;
}

// ---- 通用工具 ----

export function addRes(a: Resources, b: Resources): Resources {
  return { metal: a.metal + b.metal, crystal: a.crystal + b.crystal, fuel: a.fuel + b.fuel };
}

export function canAfford(have: Resources, cost: Resources): boolean {
  return have.metal >= cost.metal && have.crystal >= cost.crystal && have.fuel >= cost.fuel;
}

export function subRes(have: Resources, cost: Resources): Resources {
  return {
    metal: have.metal - cost.metal,
    crystal: have.crystal - cost.crystal,
    fuel: have.fuel - cost.fuel,
  };
}

export function shipCountTotal(s: ShipCount): number {
  return s.corvette + s.destroyer + s.cruiser + s.colony;
}

export function combatShips(s: ShipCount): number {
  return s.corvette + s.destroyer + s.cruiser;
}

/** 舰队规模(用于燃料计算,含殖民船)。 */
export function fleetSize(s: ShipCount): number {
  return shipCountTotal(s);
}

/** 编成的粗略战力估值(供 AI 决策与出击预估)。 */
export function fleetPower(s: ShipCount): number {
  return (
    s.corvette * (SHIPS.corvette.hp * 0.3 + SHIPS.corvette.firepower) +
    s.destroyer * (SHIPS.destroyer.hp * 0.3 + SHIPS.destroyer.firepower) +
    s.cruiser * (SHIPS.cruiser.hp * 0.3 + SHIPS.cruiser.firepower)
  );
}

// ---- 胜负阈值 ----

export const CORE_HOLD_TARGET = 180; // 持有核心 3 分钟获胜
export const HELPLESS_TARGET = 60; // 无力回天判定 60 秒
export const HOP_BASE_TIME = 8; // 每跳基础耗时
export const FUEL_PER_SIZE = 2; // 每跳每艘船耗燃料
export const AI_DECISION_INTERVAL = 3; // AI 决策间隔
export const MAX_BUILDING_SLOTS = 6;
export const START_RESOURCES: Resources = { metal: 400, crystal: 250, fuel: 150 };
