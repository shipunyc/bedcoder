// ============================================================================
// 《星渊》 sim 内核类型定义 —— 纯数据,无任何 DOM/React/渲染依赖。
// sim 是唯一真相:确定性、可回放。
// ============================================================================

export type Owner = 'player' | 'ai' | 'neutral';
export type PlayerSide = 'player' | 'ai';

export type ResourceKind = 'metal' | 'crystal' | 'fuel';

export interface Resources {
  metal: number;
  crystal: number;
  fuel: number;
}

export type PlanetType = 'rock' | 'gas' | 'ice';

export type BuildingType =
  | 'metalMine'
  | 'crystalExtractor'
  | 'fuelPlant'
  | 'shipyard'
  | 'defenseTurret';

export type ShipType = 'corvette' | 'destroyer' | 'cruiser' | 'colony';

export type Ring = 'core' | 'contested' | 'safe';

/** 舰船数量集合(每种舰种的艘数)。 */
export interface ShipCount {
  corvette: number;
  destroyer: number;
  cruiser: number;
  colony: number;
}

/** 行星建造/升级队列条目(串行处理)。 */
export interface BuildTask {
  id: string;
  buildingType: BuildingType;
  targetLevel: number; // 完成后达到的等级
  remaining: number; // 剩余秒
  total: number; // 总秒
}

/** 造舰队列条目。 */
export interface ShipTask {
  id: string;
  shipType: ShipType;
  remaining: number;
  total: number;
}

export interface Building {
  type: BuildingType;
  level: number; // 0 表示未建
}

export interface Planet {
  id: string;
  name: string;
  type: PlanetType;
  owner: Owner;
  buildings: Record<BuildingType, number>; // type -> level (0 = 未建)
  buildQueue: BuildTask[]; // 建筑串行队列
  shipQueue: ShipTask[]; // 造舰串行队列
}

export interface StarSystem {
  id: number;
  name: string;
  x: number;
  y: number;
  ring: Ring;
  owner: Owner;
  neighbors: number[];
  planets: Planet[];
  /** 该星系驻军池(归属 owner;中立为空)。 */
  garrison: ShipCount;
}

export interface Fleet {
  id: string;
  owner: PlayerSide;
  ships: ShipCount;
  origin: number; // 出发星系(撤退用)
  currentSystem: number; // 当前所在/刚经过的星系
  route: number[]; // 剩余要抵达的星系序列(含最终目的)
  hopElapsed: number;
  hopDuration: number;
}

// ---- 战斗 ----

export type CombatResult = 'attackerWin' | 'defenderWin' | 'attackerRetreat';

/** 单个 stack(某阵营某舰种的一堆)的编成快照。 */
export interface StackSnapshot {
  side: 'attacker' | 'defender';
  kind: ShipType | 'defense';
  count: number;
}

/** 单次开火事件(某 stack 打某 stack)。 */
export interface FireEvent {
  fromSide: 'attacker' | 'defender';
  fromKind: ShipType | 'defense';
  toSide: 'attacker' | 'defender';
  toKind: ShipType | 'defense';
  damage: number;
  killed: number; // 本次击毁艘数
  crit: boolean; // 是否触发克制加成
}

export interface RoundEvent {
  round: number;
  fires: FireEvent[];
  /** 本回合结束后双方各 stack 存活数量快照。 */
  attacker: StackSnapshot[];
  defender: StackSnapshot[];
}

export interface BattleReport {
  id: string;
  systemId: number;
  systemName: string;
  attackerOwner: PlayerSide;
  defenderOwner: Owner;
  initialAttacker: StackSnapshot[];
  initialDefender: StackSnapshot[];
  rounds: RoundEvent[];
  result: CombatResult;
  attackerLosses: ShipCount;
  defenderLosses: ShipCount;
  defenseDestroyed: boolean;
}

export interface LogEntry {
  id: string;
  time: number;
  kind: 'build' | 'ship' | 'battle' | 'capture' | 'colonize' | 'info' | 'warn';
  text: string;
  battleId?: string;
  side?: PlayerSide;
}

export interface SideStats {
  shipsBuilt: number;
  shipsLost: number;
  kills: number;
  systemsCaptured: number;
}

export type GameStatus = 'playing' | 'won' | 'lost';

export interface GameState {
  seed: number;
  rng: number; // mulberry32 当前状态
  time: number; // 已过秒数
  status: GameStatus;
  endReason: string;

  systems: StarSystem[];
  fleets: Fleet[];

  resources: Record<PlayerSide, Resources>;

  coreSystemId: number;
  playerHomeId: number;
  aiHomeId: number;

  /** 核心星系持有计时(秒),达到阈值获胜。 */
  coreHold: Record<PlayerSide, number>;
  /** 玩家"无力回天"倒计时累积(秒)。 */
  helplessTimer: number;

  aiCooldown: number; // AI 决策冷却
  aiRally: number | null; // AI 集结点星系

  log: LogEntry[];
  battles: Record<string, BattleReport>;
  stats: Record<PlayerSide, SideStats>;

  nextId: number; // 单调递增 id 计数(确定性)
}

// ---- 派发动作(render/ui 只发 action) ----

export type GameAction =
  | { type: 'queueBuilding'; systemId: number; planetId: string; building: BuildingType }
  | { type: 'queueShip'; systemId: number; planetId: string; ship: ShipType; count: number }
  | { type: 'launchFleet'; from: number; to: number; ships: ShipCount }
  | { type: 'cancelBuild'; systemId: number; planetId: string; taskId: string }
  | { type: 'cancelShip'; systemId: number; planetId: string; taskId: string };
