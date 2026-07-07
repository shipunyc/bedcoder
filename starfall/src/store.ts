// ============================================================================
// zustand store:持有 GameState,驱动主循环,桥接 sim 与渲染。
// sim 在原对象上原地推进;渲染器(Pixi/Three)直接读 game 实时状态,
// React UI 以较低频率(~15Hz)刷新以省性能。
// ============================================================================

import { create } from 'zustand';
import { createGame, dispatch, tick } from './sim/game';
import type { GameAction, GameState, ShipCount, ShipType } from './sim/types';
import { ZERO_SHIPS } from './sim/data';

const SAVE_KEY = 'starfall.save.v1';

export interface LaunchState {
  active: boolean;
  from: number | null;
  ships: ShipCount;
}

export interface BattleBanner {
  battleId: string;
  systemName: string;
}

interface StoreState {
  game: GameState;
  frame: number; // UI 刷新计数
  paused: boolean;
  speed: number; // 1 | 2
  selectedSystem: number | null;
  selectedPlanet: string | null;
  launch: LaunchState;
  viewingBattle: string | null;
  banner: BattleBanner | null;
  seenBattles: Set<string>;
  tutorialStep: number;

  // actions
  bump: () => void;
  act: (a: GameAction) => { ok: boolean; reason?: string };
  newGame: () => void;
  togglePause: () => void;
  setSpeed: (s: number) => void;
  selectSystem: (id: number | null) => void;
  selectPlanet: (id: string | null) => void;
  startLaunch: (from: number) => void;
  setLaunchShips: (ship: ShipType, count: number) => void;
  cancelLaunch: () => void;
  confirmLaunch: (to: number) => { ok: boolean; reason?: string };
  openBattle: (id: string) => void;
  closeBattle: () => void;
  dismissBanner: () => void;
  advanceTutorial: (step: number) => void;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff) | 0;
}

function loadGame(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as GameState;
    if (!g || !Array.isArray(g.systems)) return null;
    return g;
  } catch {
    return null;
  }
}

function saveGame(g: GameState): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(g));
  } catch {
    /* 忽略配额错误 */
  }
}

const initial = loadGame() ?? createGame(randomSeed());

export const useStore = create<StoreState>((set, get) => ({
  game: initial,
  frame: 0,
  paused: false,
  speed: 1,
  selectedSystem: null,
  selectedPlanet: null,
  launch: { active: false, from: null, ships: { ...ZERO_SHIPS } },
  viewingBattle: null,
  banner: null,
  seenBattles: new Set(Object.keys(initial.battles)),
  tutorialStep: initial.time > 5 ? 99 : 0,

  bump: () => set((s) => ({ frame: s.frame + 1 })),

  act: (a) => {
    const res = dispatch(get().game, a);
    get().bump();
    return res;
  },

  newGame: () => {
    const g = createGame(randomSeed());
    saveGame(g);
    set({
      game: g,
      frame: 0,
      paused: false,
      speed: 1,
      selectedSystem: null,
      selectedPlanet: null,
      launch: { active: false, from: null, ships: { ...ZERO_SHIPS } },
      viewingBattle: null,
      banner: null,
      seenBattles: new Set(),
      tutorialStep: 0,
    });
  },

  togglePause: () => set((s) => ({ paused: !s.paused })),
  setSpeed: (s) => set({ speed: s }),

  selectSystem: (id) =>
    set({ selectedSystem: id, selectedPlanet: null }),
  selectPlanet: (id) => set({ selectedPlanet: id }),

  startLaunch: (from) =>
    set({ launch: { active: true, from, ships: { ...ZERO_SHIPS } } }),
  setLaunchShips: (ship, count) =>
    set((s) => ({
      launch: { ...s.launch, ships: { ...s.launch.ships, [ship]: Math.max(0, count) } },
    })),
  cancelLaunch: () => set({ launch: { active: false, from: null, ships: { ...ZERO_SHIPS } } }),
  confirmLaunch: (to) => {
    const { launch, game } = get();
    if (!launch.active || launch.from == null) return { ok: false, reason: '无出击' };
    const res = dispatch(game, { type: 'launchFleet', from: launch.from, to, ships: launch.ships });
    if (res.ok) {
      set({ launch: { active: false, from: null, ships: { ...ZERO_SHIPS } } });
    }
    get().bump();
    return res;
  },

  openBattle: (id) => set({ viewingBattle: id, banner: null, paused: true }),
  closeBattle: () => set({ viewingBattle: null, paused: false }),
  dismissBanner: () => set({ banner: null }),
  advanceTutorial: (step) => set((s) => ({ tutorialStep: Math.max(s.tutorialStep, step) })),
}));

// ---- 主循环(模块级,单例) ----

let lastT = performance.now();
let saveAccum = 0;
let uiAccum = 0;

function frameLoop(now: number): void {
  const dt = (now - lastT) / 1000;
  lastT = now;
  const st = useStore.getState();
  const g = st.game;

  if (!st.paused && g.status === 'playing') {
    const scaled = dt * st.speed;
    tick(g, scaled);

    // 检测新的与玩家相关的战斗 → 弹横幅
    if (!st.banner && !st.viewingBattle) {
      for (const id of Object.keys(g.battles)) {
        if (st.seenBattles.has(id)) continue;
        const b = g.battles[id]!;
        st.seenBattles.add(id);
        if (b.attackerOwner === 'player' || b.defenderOwner === 'player') {
          useStore.setState({ banner: { battleId: id, systemName: b.systemName } });
          break;
        }
      }
    } else {
      // 仍要登记已见,避免堆积
      for (const id of Object.keys(g.battles)) st.seenBattles.add(id);
    }
  }

  // UI 刷新节流(~15Hz)
  uiAccum += dt;
  if (uiAccum >= 0.066) {
    uiAccum = 0;
    useStore.setState((s) => ({ frame: s.frame + 1 }));
  }

  // 自动存档(每 3 秒)
  saveAccum += dt;
  if (saveAccum >= 3) {
    saveAccum = 0;
    saveGame(g);
  }

  requestAnimationFrame(frameLoop);
}

export function startGameLoop(): void {
  lastT = performance.now();
  requestAnimationFrame(frameLoop);
}

// 开发期:暴露 store 便于调试(生产构建可 tree-shake)。
if (import.meta.env.DEV) {
  (window as unknown as { __store?: typeof useStore }).__store = useStore;
}
