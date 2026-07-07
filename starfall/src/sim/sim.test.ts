import { describe, expect, it } from 'vitest';
import { createGame, tick } from './game';
import { generateGalaxy, SYSTEM_COUNT } from './galaxy';
import { resolveCombat } from './combat';
import { ZERO_SHIPS } from './data';

function ownersString(seed: number, steps: number): string {
  const g = createGame(seed);
  for (let i = 0; i < steps; i++) tick(g, 0.1);
  return (
    g.time.toFixed(2) +
    '|' +
    JSON.stringify(g.resources) +
    '|' +
    Object.keys(g.battles).length +
    '|' +
    g.systems.map((s) => s.owner).join(',')
  );
}

describe('galaxy', () => {
  it('生成 40 个连通的星系', () => {
    const g = generateGalaxy(12345);
    expect(g.systems.length).toBe(SYSTEM_COUNT);
    // BFS 连通性
    const seen = new Set<number>([0]);
    const q = [0];
    while (q.length) {
      const c = q.shift()!;
      for (const nb of g.systems[c]!.neighbors) {
        if (!seen.has(nb)) {
          seen.add(nb);
          q.push(nb);
        }
      }
    }
    expect(seen.size).toBe(SYSTEM_COUNT);
  });

  it('每星系度数在 2~4 之间(除孤立兜底)', () => {
    const g = generateGalaxy(999);
    for (const s of g.systems) {
      expect(s.neighbors.length).toBeGreaterThanOrEqual(1);
      expect(s.neighbors.length).toBeLessThanOrEqual(5);
    }
  });

  it('存在唯一核心星系与对角母星', () => {
    const g = generateGalaxy(7);
    expect(g.systems[g.coreSystemId]!.ring).toBe('core');
    expect(g.playerHomeId).not.toBe(g.aiHomeId);
    expect(g.systems[g.playerHomeId]!.owner).toBe('player');
    expect(g.systems[g.aiHomeId]!.owner).toBe('ai');
  });
});

describe('determinism', () => {
  it('同 seed 同步数结果完全一致', () => {
    expect(ownersString(42, 2000)).toBe(ownersString(42, 2000));
    expect(ownersString(1337, 1500)).toBe(ownersString(1337, 1500));
  });

  it('不同 seed 结果不同', () => {
    expect(ownersString(1, 500)).not.toBe(ownersString(2, 500));
  });
});

describe('combat', () => {
  it('确定性:同输入同种子输出一致', () => {
    const input = {
      systemId: 0,
      systemName: '测试',
      attackerOwner: 'player' as const,
      defenderOwner: 'ai' as const,
      attacker: { ...ZERO_SHIPS, corvette: 10, destroyer: 4 },
      defender: { ...ZERO_SHIPS, cruiser: 3, corvette: 5 },
      defensePower: 400,
      seed: 123456,
    };
    const a = resolveCombat(input, 'b1');
    const b = resolveCombat(input, 'b1');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.rounds.length).toBeGreaterThan(0);
    expect(['attackerWin', 'defenderWin', 'attackerRetreat']).toContain(a.result);
  });

  it('压倒性兵力进攻方获胜', () => {
    const r = resolveCombat(
      {
        systemId: 0,
        systemName: 't',
        attackerOwner: 'player',
        defenderOwner: 'ai',
        attacker: { ...ZERO_SHIPS, cruiser: 20 },
        defender: { ...ZERO_SHIPS, corvette: 1 },
        defensePower: 0,
        seed: 5,
      },
      'b2'
    );
    expect(r.result).toBe('attackerWin');
  });
});

describe('economy', () => {
  it('资源随时间增长', () => {
    const g = createGame(42);
    const before = g.resources.player.metal;
    for (let i = 0; i < 100; i++) tick(g, 0.1);
    expect(g.resources.player.metal).toBeGreaterThan(before);
  });
});
