// ============================================================================
// 星图生成:泊松圆盘采样 40 恒星系 → 邻接连边(近邻 + MST 保连通,裁剪 2~4 条)
// → 圈层划分(核心/争议/安全)→ 行星 → 玩家/AI 母星(对角)。
// ============================================================================

import { ZERO_SHIPS } from './data';
import { makeRng } from './rng';
import type { Planet, PlanetType, Ring, StarSystem } from './types';

export const MAP_SIZE = 1200;
export const SYSTEM_COUNT = 40;
const CENTER = MAP_SIZE / 2;

const STAR_PREFIX = [
  '天渊',
  '赤枢',
  '玄冥',
  '苍梧',
  '烛龙',
  '瀚海',
  '流火',
  '寒星',
  '幽兰',
  '破晓',
  '孤鸿',
  '长庚',
  '灵曜',
  '沧溟',
  '紫微',
  '朱雀',
  '玄武',
  '青龙',
  '白虎',
  '天狼',
  '参宿',
  '毕宿',
  '角宿',
  '轩辕',
  '太乙',
  '摇光',
  '开阳',
  '天璇',
  '天玑',
  '瑶光',
  '北落',
  '织女',
  '河鼓',
  '心宿',
  '房宿',
  '危宿',
  '虚宿',
  '奎宿',
  '娄宿',
  '昴宿',
];
const PLANET_SUFFIX = ['I', 'II', 'III', 'IV', 'V'];
const PLANET_TYPES: PlanetType[] = ['rock', 'gas', 'ice'];

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** 泊松圆盘采样(简化的暴力拒绝采样),返回约 SYSTEM_COUNT 个点。 */
function poissonPoints(rng: ReturnType<typeof makeRng>): { x: number; y: number }[] {
  const margin = 90;
  const lo = margin;
  const hi = MAP_SIZE - margin;
  let minDist = 190;
  for (let attempt = 0; attempt < 12; attempt++) {
    const pts: { x: number; y: number }[] = [];
    let tries = 0;
    while (pts.length < SYSTEM_COUNT && tries < 6000) {
      tries++;
      const x = rng.range(lo, hi);
      const y = rng.range(lo, hi);
      let ok = true;
      for (const p of pts) {
        if (dist(x, y, p.x, p.y) < minDist) {
          ok = false;
          break;
        }
      }
      if (ok) pts.push({ x, y });
    }
    if (pts.length >= SYSTEM_COUNT) return pts.slice(0, SYSTEM_COUNT);
    minDist *= 0.9; // 放宽间距重试
  }
  // 兜底:网格抖动
  const pts: { x: number; y: number }[] = [];
  const cols = 7;
  for (let i = 0; i < SYSTEM_COUNT; i++) {
    const gx = i % cols;
    const gy = Math.floor(i / cols);
    pts.push({
      x: lo + (gx / (cols - 1)) * (hi - lo) + rng.range(-30, 30),
      y: lo + (gy / 5) * (hi - lo) + rng.range(-30, 30),
    });
  }
  return pts;
}

/** 构建邻接:MST 保连通 + 近邻补边,度数裁剪到 2~4。 */
function buildEdges(pts: { x: number; y: number }[]): Set<string> {
  const n = pts.length;
  const edges = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const degree = new Array(n).fill(0);

  // Prim MST
  const inTree = new Array(n).fill(false);
  const best = new Array(n).fill(Infinity);
  const parent = new Array(n).fill(-1);
  best[0] = 0;
  for (let iter = 0; iter < n; iter++) {
    let u = -1;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      if (!inTree[i] && best[i] < bd) {
        bd = best[i];
        u = i;
      }
    }
    if (u === -1) break;
    inTree[u] = true;
    if (parent[u] >= 0) {
      edges.add(key(u, parent[u]));
      degree[u]++;
      degree[parent[u]]++;
    }
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue;
      const d = dist(pts[u]!.x, pts[u]!.y, pts[v]!.x, pts[v]!.y);
      if (d < best[v]) {
        best[v] = d;
        parent[v] = u;
      }
    }
  }

  // 近邻补边:每系尝试连到最近的几个,度数上限 4
  const neighborsByDist: { j: number; d: number }[][] = [];
  for (let i = 0; i < n; i++) {
    const list: { j: number; d: number }[] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      list.push({ j, d: dist(pts[i]!.x, pts[i]!.y, pts[j]!.x, pts[j]!.y) });
    }
    list.sort((a, b) => a.d - b.d);
    neighborsByDist.push(list);
  }
  for (let i = 0; i < n; i++) {
    for (const { j } of neighborsByDist[i]!) {
      if (degree[i] >= 3) break;
      if (degree[j] >= 4) continue;
      const k = key(i, j);
      if (edges.has(k)) continue;
      // 避免过长边
      if (neighborsByDist[i]![0]!.d * 2.4 < dist(pts[i]!.x, pts[i]!.y, pts[j]!.x, pts[j]!.y))
        continue;
      edges.add(k);
      degree[i]++;
      degree[j]++;
    }
  }
  return edges;
}

function makePlanets(
  sysName: string,
  count: number,
  rng: ReturnType<typeof makeRng>,
  idBase: string
): Planet[] {
  const planets: Planet[] = [];
  for (let i = 0; i < count; i++) {
    const type = rng.pick(PLANET_TYPES);
    planets.push({
      id: `${idBase}-p${i}`,
      name: `${sysName} ${PLANET_SUFFIX[i] ?? 'VI'}`,
      type,
      owner: 'neutral',
      buildings: {
        metalMine: 0,
        crystalExtractor: 0,
        fuelPlant: 0,
        shipyard: 0,
        defenseTurret: 0,
      },
      buildQueue: [],
      shipQueue: [],
    });
  }
  return planets;
}

export interface GalaxyResult {
  systems: StarSystem[];
  coreSystemId: number;
  playerHomeId: number;
  aiHomeId: number;
  rngState: number;
}

export function generateGalaxy(seed: number): GalaxyResult {
  const rng = makeRng(seed);
  const pts = poissonPoints(rng);
  const edges = buildEdges(pts);

  // 圈层:按到图心距离排序
  const order = pts
    .map((p, i) => ({ i, d: dist(p.x, p.y, CENTER, CENTER) }))
    .sort((a, b) => a.d - b.d);
  const ringOf = new Array<Ring>(pts.length).fill('safe');
  order.forEach((o, rank) => {
    if (rank === 0) ringOf[o.i] = 'core';
    else if (rank <= 12) ringOf[o.i] = 'contested';
    else ringOf[o.i] = 'safe';
  });
  const coreSystemId = order[0]!.i;

  // 邻接列表
  const adj: number[][] = pts.map(() => []);
  for (const e of edges) {
    const [a, b] = e.split('-').map(Number) as [number, number];
    adj[a]!.push(b);
    adj[b]!.push(a);
  }

  const systems: StarSystem[] = pts.map((p, i) => {
    const name = STAR_PREFIX[i] ?? `星系${i}`;
    const planetCount = rng.int(2, 4);
    return {
      id: i,
      name,
      x: p.x,
      y: p.y,
      ring: ringOf[i]!,
      owner: 'neutral',
      neighbors: adj[i]!.slice().sort((a, b) => a - b),
      planets: makePlanets(name, planetCount, rng, `s${i}`),
      garrison: { ...ZERO_SHIPS },
    };
  });

  // 玩家母星:安全区中离图心最远者;AI 母星:与玩家近似对角的安全区星系
  const safeIds = systems.filter((s) => s.ring === 'safe').map((s) => s.id);
  let playerHomeId = safeIds[0]!;
  let far = -1;
  for (const id of safeIds) {
    const d = dist(systems[id]!.x, systems[id]!.y, CENTER, CENTER);
    if (d > far) {
      far = d;
      playerHomeId = id;
    }
  }
  const ph = systems[playerHomeId]!;
  // 对角点
  const oppX = CENTER - (ph.x - CENTER);
  const oppY = CENTER - (ph.y - CENTER);
  let aiHomeId = safeIds[0]!;
  let bestOpp = Infinity;
  for (const id of safeIds) {
    if (id === playerHomeId) continue;
    const d = dist(systems[id]!.x, systems[id]!.y, oppX, oppY);
    if (d < bestOpp) {
      bestOpp = d;
      aiHomeId = id;
    }
  }

  // 配置母星:主行星已殖民并带基础经济
  setupHome(systems[playerHomeId]!, 'player');
  setupHome(systems[aiHomeId]!, 'ai');

  return { systems, coreSystemId, playerHomeId, aiHomeId, rngState: rng.state() };
}

function setupHome(sys: StarSystem, owner: 'player' | 'ai'): void {
  sys.owner = owner;
  const primary = sys.planets[0]!;
  primary.owner = owner;
  primary.name = owner === 'player' ? `${sys.name} 母星` : `${sys.name} 要塞`;
  primary.buildings.metalMine = 1;
  primary.buildings.crystalExtractor = 1;
  primary.buildings.fuelPlant = 1;
  // 起始舰队:少量护卫舰驻守,保证开局即有可操作单位
  sys.garrison = { corvette: 3, destroyer: 0, cruiser: 0, colony: 0 };
}
