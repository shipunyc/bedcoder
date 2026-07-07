// ============================================================================
// 种子随机 —— mulberry32。确定性:同一状态序列产生同一结果。
// 为保持 GameState 可序列化/可回放,rng 状态以数字形式存于 state.rng,
// 通过 nextRng() 推进。这里同时提供一个纯函数式与一个基于闭包的生成器。
// ============================================================================

/** 由当前状态推进一步,返回 [0,1) 随机数与新状态。 */
export function mulberry32Step(state: number): { value: number; next: number } {
  let a = state | 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, next: a };
}

/** 闭包式生成器(用于星图生成等一次性流程)。 */
export function makeRng(seed: number): {
  next: () => number;
  range: (min: number, max: number) => number;
  int: (min: number, max: number) => number;
  pick: <T>(arr: readonly T[]) => T;
  state: () => number;
} {
  let s = seed | 0;
  const next = () => {
    const r = mulberry32Step(s);
    s = r.next;
    return r.value;
  };
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)] as T,
    state: () => s,
  };
}

/** 独立种子的确定性随机(用于战斗解算,不污染主 rng)。 */
export class SeededRandom {
  private s: number;
  constructor(seed: number) {
    this.s = seed | 0;
  }
  next(): number {
    const r = mulberry32Step(this.s);
    this.s = r.next;
    return r.value;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}
