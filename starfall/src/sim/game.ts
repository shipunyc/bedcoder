// ============================================================================
// 总入口:createGame(seed) / tick(state, dt) / dispatch(state, action)。
// sim 是唯一真相:确定性、可回放。
// ============================================================================

import {
  cancelBuildCore,
  cancelShipCore,
  queueBuildingCore,
  queueShipCore,
} from './actions';
import { aiTick } from './ai';
import {
  canAfford,
  CORE_HOLD_TARGET,
  HELPLESS_TARGET,
  SHIPS,
  START_RESOURCES,
} from './data';
import { economyTick, log } from './economy';
import { fleetTick, launchFleet } from './fleet';
import { generateGalaxy } from './galaxy';
import type { GameAction, GameState, PlayerSide } from './types';

export function createGame(seed: number): GameState {
  const g = generateGalaxy(seed);
  const state: GameState = {
    seed,
    rng: g.rngState,
    time: 0,
    status: 'playing',
    endReason: '',
    systems: g.systems,
    fleets: [],
    resources: {
      player: { ...START_RESOURCES },
      ai: { ...START_RESOURCES },
    },
    coreSystemId: g.coreSystemId,
    playerHomeId: g.playerHomeId,
    aiHomeId: g.aiHomeId,
    coreHold: { player: 0, ai: 0 },
    helplessTimer: 0,
    aiCooldown: 2,
    aiRally: null,
    log: [],
    battles: {},
    stats: {
      player: { shipsBuilt: 0, shipsLost: 0, kills: 0, systemsCaptured: 0 },
      ai: { shipsBuilt: 0, shipsLost: 0, kills: 0, systemsCaptured: 0 },
    },
    nextId: 1,
  };
  log(state, { kind: 'info', text: '星渊纪元开启 —— 建立你的星际霸权。' });
  return state;
}

export function tick(state: GameState, dtRaw: number): void {
  if (state.status !== 'playing') return;
  const dt = Math.min(Math.max(dtRaw, 0), 0.5); // 防止长帧跳步
  state.time += dt;

  economyTick(state, dt);
  fleetTick(state, dt);
  aiTick(state, dt);
  evaluateVictory(state, dt);
}

export function dispatch(state: GameState, action: GameAction): { ok: boolean; reason?: string } {
  switch (action.type) {
    case 'queueBuilding':
      return queueBuildingCore(state, action.systemId, action.planetId, action.building, 'player');
    case 'queueShip':
      return queueShipCore(state, action.systemId, action.planetId, action.ship, action.count, 'player');
    case 'launchFleet':
      return launchFleet(state, action.from, action.to, action.ships);
    case 'cancelBuild':
      return cancelBuildCore(state, action.systemId, action.planetId, action.taskId, 'player');
    case 'cancelShip':
      return cancelShipCore(state, action.systemId, action.planetId, action.taskId, 'player');
    default:
      return { ok: false, reason: '未知动作' };
  }
}

function totalShips(state: GameState, side: PlayerSide): number {
  let n = 0;
  for (const sys of state.systems) {
    if (sys.owner === side) {
      const g = sys.garrison;
      n += g.corvette + g.destroyer + g.cruiser + g.colony;
    }
  }
  for (const f of state.fleets) {
    if (f.owner === side) {
      n += f.ships.corvette + f.ships.destroyer + f.ships.cruiser + f.ships.colony;
    }
  }
  return n;
}

function ownedSystems(state: GameState, side: PlayerSide): number {
  return state.systems.filter((s) => s.owner === side).length;
}

function evaluateVictory(state: GameState, dt: number): void {
  const core = state.systems[state.coreSystemId]!;

  // 核心区持有计时
  if (core.owner === 'player') {
    state.coreHold.player += dt;
    state.coreHold.ai = 0;
  } else if (core.owner === 'ai') {
    state.coreHold.ai += dt;
    state.coreHold.player = 0;
  } else {
    state.coreHold.player = 0;
    state.coreHold.ai = 0;
  }

  if (state.coreHold.player >= CORE_HOLD_TARGET) {
    return endGame(state, 'won', '你持有核心星系满 3 分钟,星渊尽归你手。');
  }
  if (state.coreHold.ai >= CORE_HOLD_TARGET) {
    return endGame(state, 'lost', '敌方持有核心星系满 3 分钟,帝国崩塌。');
  }

  // 歼灭胜利:AI 全舰覆灭且我方占据其母星系以外全部星系
  const totalSystems = state.systems.length;
  if (
    totalShips(state, 'ai') === 0 &&
    ownedSystems(state, 'player') >= totalSystems - 1 &&
    state.systems[state.aiHomeId]!.owner === 'ai'
  ) {
    return endGame(state, 'won', '敌方舰队全灭,你已掌控除敌方母星外的整个星区。');
  }

  // 失败:母星外全丢 + 无舰 + 无力再造,持续 60 秒
  const playerNonHome = state.systems.filter(
    (s) => s.owner === 'player' && s.id !== state.playerHomeId
  ).length;
  const cannotBuild = !canAfford(state.resources.player, SHIPS.corvette.cost);
  const helpless = playerNonHome === 0 && totalShips(state, 'player') === 0 && cannotBuild;
  if (helpless) {
    state.helplessTimer += dt;
    if (state.helplessTimer >= HELPLESS_TARGET) {
      return endGame(state, 'lost', '母星之外尽失,舰队覆灭且无力回天。');
    }
  } else {
    state.helplessTimer = 0;
  }
}

function endGame(state: GameState, status: 'won' | 'lost', reason: string): void {
  state.status = status;
  state.endReason = reason;
  log(state, {
    kind: status === 'won' ? 'capture' : 'warn',
    text: status === 'won' ? `胜利:${reason}` : `失败:${reason}`,
  });
}

// 便捷:重新开局(新种子)
export function newGame(seed: number): GameState {
  return createGame(seed);
}
