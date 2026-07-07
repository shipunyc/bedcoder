// ============================================================================
// PixiJS v8 星图渲染:发光恒星、脉动、连线、在途舰队流光、缩放/拖拽/点选。
// 只读 GameState、只发 action(经 store)。
// ============================================================================

import { Application, Container, Graphics, Text } from 'pixi.js';
import { MAP_SIZE } from '../../sim/galaxy';
import { shortestPath } from '../../sim/fleet';
import { combatShips, fleetPower } from '../../sim/data';
import type { GameState, Owner, StarSystem } from '../../sim/types';
import { useStore } from '../../store';

const COLORS = {
  player: 0x5eead4,
  ai: 0xf87171,
  neutral: 0x9fb3c8,
  core: 0xfde68a,
  contested: 0xfbbf24,
  safe: 0x5eead4,
  edge: 0x1a2b3d,
  edgeHi: 0x5eead4,
};

function ringColor(sys: StarSystem): number {
  if (sys.ring === 'core') return COLORS.core;
  if (sys.ring === 'contested') return COLORS.contested;
  return COLORS.safe;
}
function ownerColor(owner: Owner): number {
  return owner === 'player' ? COLORS.player : owner === 'ai' ? COLORS.ai : COLORS.neutral;
}

interface SystemNode {
  container: Container;
  glow: Graphics;
  halo: Graphics;
  selRing: Graphics;
  reachRing: Graphics;
  label: Text;
  lastOwner: Owner;
  phase: number;
}

export interface TooltipData {
  kind: 'system';
  title: string;
  rows: [string, string][];
  x: number;
  y: number;
}

export class MapRenderer {
  app: Application;
  private world = new Container();
  private edgesG = new Graphics();
  private systemsC = new Container();
  private fleetsC = new Container();
  private nodes: SystemNode[] = [];
  private fleetSprites = new Map<string, { c: Container; body: Graphics; trail: Graphics }>();
  private zoom = 1;
  private baseScale = 1;
  private panX = 0;
  private panY = 0;
  private dragging = false;
  private dragStart = { x: 0, y: 0, px: 0, py: 0 };
  private reachable: Set<number> | null = null;
  private onTooltip: (t: TooltipData | null) => void;
  private hoverTimer: number | null = null;
  private disposed = false;
  private ready = false;

  constructor(onTooltip: (t: TooltipData | null) => void) {
    this.app = new Application();
    this.onTooltip = onTooltip;
  }

  async init(parent: HTMLElement): Promise<void> {
    await this.app.init({
      background: 0x05070d,
      resizeTo: parent,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    if (this.disposed) {
      this.app.destroy(true);
      return;
    }
    parent.appendChild(this.app.canvas);
    this.app.canvas.id = 'map-canvas';

    this.world.addChild(this.edgesG);
    this.world.addChild(this.fleetsC);
    this.world.addChild(this.systemsC);
    this.app.stage.addChild(this.world);

    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;

    this.buildStatic();
    this.fitView();
    this.bindInteraction();
    this.ready = true;

    this.app.ticker.add(() => this.frame());
  }

  private get game(): GameState {
    return useStore.getState().game;
  }

  private buildStatic(): void {
    this.nodes = [];
    this.systemsC.removeChildren();
    const g = this.game;

    // 连线(一次性)
    this.drawEdges();

    for (const sys of g.systems) {
      const c = new Container();
      c.position.set(sys.x, sys.y);
      c.eventMode = 'static';
      c.cursor = 'pointer';

      const reachRing = new Graphics();
      const halo = new Graphics();
      const glow = new Graphics();
      const selRing = new Graphics();
      const rc = ringColor(sys);

      glow.circle(0, 0, sys.ring === 'core' ? 15 : 9).fill({ color: rc, alpha: 0.9 });
      glow.circle(0, 0, sys.ring === 'core' ? 30 : 20).fill({ color: rc, alpha: 0.16 });

      const label = new Text({
        text: sys.name,
        style: {
          fontFamily: 'Orbitron, sans-serif',
          fontSize: 13,
          fill: 0xe8f0f8,
          align: 'center',
        },
      });
      label.anchor.set(0.5, 0);
      label.position.set(0, sys.ring === 'core' ? 34 : 24);
      label.alpha = 0.85;

      c.addChild(reachRing, halo, glow, selRing, label);
      this.drawHalo(halo, sys);
      this.systemsC.addChild(c);

      const node: SystemNode = {
        container: c,
        glow,
        halo,
        selRing,
        reachRing,
        label,
        lastOwner: sys.owner,
        phase: (sys.id * 1.37) % (Math.PI * 2),
      };
      this.nodes.push(node);

      c.on('pointerover', (e) => this.onHover(sys.id, e.global.x, e.global.y));
      c.on('pointerout', () => this.clearHover());
      c.on('pointerdown', (e) => {
        e.stopPropagation();
        this.onSystemClick(sys.id);
      });
    }
  }

  private drawEdges(): void {
    const g = this.game;
    this.edgesG.clear();
    const drawn = new Set<string>();
    for (const sys of g.systems) {
      for (const nb of sys.neighbors) {
        const key = sys.id < nb ? `${sys.id}-${nb}` : `${nb}-${sys.id}`;
        if (drawn.has(key)) continue;
        drawn.add(key);
        const o = g.systems[nb]!;
        this.edgesG
          .moveTo(sys.x, sys.y)
          .lineTo(o.x, o.y)
          .stroke({ width: 1.4, color: COLORS.edge, alpha: 0.7 });
      }
    }
  }

  private drawHalo(halo: Graphics, sys: StarSystem): void {
    halo.clear();
    const col = ownerColor(sys.owner);
    if (sys.owner !== 'neutral') {
      const r = sys.ring === 'core' ? 26 : 17;
      halo.circle(0, 0, r).stroke({ width: 2, color: col, alpha: 0.9 });
      halo.circle(0, 0, r + 5).stroke({ width: 1, color: col, alpha: 0.3 });
    } else {
      halo.circle(0, 0, 14).stroke({ width: 1, color: COLORS.neutral, alpha: 0.25 });
    }
  }

  private fitView(): void {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const pad = 120;
    this.baseScale = Math.min((w - pad) / MAP_SIZE, (h - pad) / MAP_SIZE);
    this.zoom = 1;
    this.applyTransform(true);
  }

  private applyTransform(center = false): void {
    const scale = this.baseScale * this.zoom;
    this.world.scale.set(scale);
    if (center) {
      this.panX = (this.app.screen.width - MAP_SIZE * scale) / 2;
      this.panY = (this.app.screen.height - MAP_SIZE * scale) / 2;
    }
    this.world.position.set(this.panX, this.panY);
  }

  private bindInteraction(): void {
    const stage = this.app.stage;
    stage.on('pointerdown', (e) => {
      this.dragging = true;
      this.dragStart = { x: e.global.x, y: e.global.y, px: this.panX, py: this.panY };
    });
    stage.on('pointermove', (e) => {
      if (this.dragging) {
        this.panX = this.dragStart.px + (e.global.x - this.dragStart.x);
        this.panY = this.dragStart.py + (e.global.y - this.dragStart.y);
        this.applyTransform();
      }
    });
    const end = () => (this.dragging = false);
    stage.on('pointerup', end);
    stage.on('pointerupoutside', end);

    this.app.canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const rect = this.app.canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const oldScale = this.baseScale * this.zoom;
      const worldX = (mx - this.panX) / oldScale;
      const worldY = (my - this.panY) / oldScale;
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      this.zoom = Math.max(0.5, Math.min(2.5, this.zoom * factor));
      const newScale = this.baseScale * this.zoom;
      this.panX = mx - worldX * newScale;
      this.panY = my - worldY * newScale;
      this.applyTransform();
    }, { passive: false });
  }

  private onHover(id: number, gx: number, gy: number): void {
    if (this.hoverTimer) window.clearTimeout(this.hoverTimer);
    const rect = this.app.canvas.getBoundingClientRect();
    this.hoverTimer = window.setTimeout(() => {
      const sys = this.game.systems[id]!;
      const rows: [string, string][] = [
        ['圈层', sys.ring === 'core' ? '核心区' : sys.ring === 'contested' ? '争议区' : '安全区'],
        ['归属', sys.owner === 'player' ? '我方' : sys.owner === 'ai' ? '敌方' : '中立'],
        ['行星', `${sys.planets.length} 颗`],
      ];
      const cs = combatShips(sys.garrison);
      if (cs > 0) rows.push(['驻军', `${cs} 艘 · 战力 ${Math.round(fleetPower(sys.garrison))}`]);
      if (this.reachable) {
        const reach = this.reachable.has(id);
        rows.push(['出击', reach ? '可达(点击确认)' : '不可达']);
      }
      this.onTooltip({
        kind: 'system',
        title: sys.name,
        rows,
        x: rect.left + gx,
        y: rect.top + gy,
      });
    }, 180);
  }

  private clearHover(): void {
    if (this.hoverTimer) window.clearTimeout(this.hoverTimer);
    this.onTooltip(null);
  }

  private onSystemClick(id: number): void {
    const st = useStore.getState();
    if (st.launch.active) {
      if (this.reachable && this.reachable.has(id)) {
        const res = st.confirmLaunch(id);
        if (!res.ok) {
          // 失败保持选择态
        }
        this.setReachable(null);
      }
      return;
    }
    st.selectSystem(id);
  }

  /** 进入/退出出击目标选择态,传入可达星系集合。 */
  setReachable(set: Set<number> | null): void {
    this.reachable = set;
  }

  /** 根据当前出击起点计算可达星系(排除起点自身)。 */
  computeReachable(from: number): Set<number> {
    const g = this.game;
    const set = new Set<number>();
    for (const sys of g.systems) {
      if (sys.id === from) continue;
      const p = shortestPath(g, from, sys.id);
      if (p && p.length > 0) set.add(sys.id);
    }
    return set;
  }

  private frame(): void {
    if (!this.ready) return;
    const t = performance.now() / 1000;
    const g = this.game;
    const st = useStore.getState();
    const selected = st.selectedSystem;

    // 系统节点动画与状态
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i]!;
      const sys = g.systems[i]!;
      // 脉动
      const pulse = 1 + Math.sin(t * 2 + node.phase) * 0.12;
      node.glow.scale.set(pulse);
      // owner 变化重绘光环
      if (node.lastOwner !== sys.owner) {
        node.lastOwner = sys.owner;
        this.drawHalo(node.halo, sys);
      }
      // 选中旋转光圈
      if (selected === sys.id) {
        if (node.selRing.width === 0 || (node.selRing as unknown as { _built?: boolean })._built !== true) {
          node.selRing.clear();
          const r = sys.ring === 'core' ? 32 : 22;
          node.selRing.circle(0, 0, r).stroke({ width: 2, color: 0x5eead4, alpha: 0.9 });
          node.selRing.moveTo(r, 0).lineTo(r + 7, 0).stroke({ width: 2, color: 0x5eead4, alpha: 0.9 });
          node.selRing.moveTo(-r, 0).lineTo(-r - 7, 0).stroke({ width: 2, color: 0x5eead4, alpha: 0.9 });
          (node.selRing as unknown as { _built?: boolean })._built = true;
        }
        node.selRing.visible = true;
        node.selRing.rotation = t * 0.8;
      } else {
        node.selRing.visible = false;
      }
      // 出击可达高亮
      if (this.reachable) {
        if (this.reachable.has(sys.id)) {
          node.reachRing.clear();
          node.reachRing
            .circle(0, 0, sys.ring === 'core' ? 30 : 20)
            .stroke({ width: 2, color: 0xfbbf24, alpha: 0.5 + Math.sin(t * 4) * 0.3 });
          node.reachRing.visible = true;
        } else {
          node.reachRing.visible = false;
        }
      } else {
        node.reachRing.visible = false;
      }
      // 标签按缩放显隐
      node.label.visible = this.zoom > 0.85 || sys.ring === 'core';
    }

    this.updateFleets(t);
  }

  private updateFleets(t: number): void {
    const g = this.game;
    const alive = new Set<string>();
    for (const fleet of g.fleets) {
      alive.add(fleet.id);
      const from = g.systems[fleet.currentSystem]!;
      const toId = fleet.route[0];
      if (toId == null) continue;
      const to = g.systems[toId]!;
      const prog = Math.max(0, Math.min(1, fleet.hopElapsed / fleet.hopDuration));
      const x = from.x + (to.x - from.x) * prog;
      const y = from.y + (to.y - from.y) * prog;
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const col = fleet.owner === 'player' ? COLORS.player : COLORS.ai;

      let sp = this.fleetSprites.get(fleet.id);
      if (!sp) {
        const c = new Container();
        const trail = new Graphics();
        const body = new Graphics();
        body.moveTo(9, 0).lineTo(-6, 5).lineTo(-3, 0).lineTo(-6, -5).closePath().fill({ color: col });
        body.circle(0, 0, 3).fill({ color: 0xffffff, alpha: 0.9 });
        trail.moveTo(-4, 0).lineTo(-26, 0).stroke({ width: 3, color: col, alpha: 0.4 });
        c.addChild(trail, body);
        this.fleetsC.addChild(c);
        sp = { c, body, trail };
        this.fleetSprites.set(fleet.id, sp);
      }
      sp.c.position.set(x, y);
      sp.c.rotation = angle;
      const size = combatShips(fleet.ships) + fleet.ships.colony;
      const s = 0.8 + Math.min(1.4, size * 0.12) + Math.sin(t * 6 + x) * 0.05;
      sp.c.scale.set(s);
    }
    // 移除已消失舰队
    for (const [id, sp] of this.fleetSprites) {
      if (!alive.has(id)) {
        sp.c.destroy({ children: true });
        this.fleetSprites.delete(id);
      }
    }
  }

  /** 星系归属或连接可能变化时,重绘静态层(占领后)。 */
  refreshHalos(): void {
    const g = this.game;
    for (let i = 0; i < this.nodes.length; i++) {
      this.drawHalo(this.nodes[i]!.halo, g.systems[i]!);
      this.nodes[i]!.lastOwner = g.systems[i]!.owner;
    }
  }

  /** 新游戏后完全重建。 */
  rebuild(): void {
    if (!this.ready) return;
    for (const [, sp] of this.fleetSprites) sp.c.destroy({ children: true });
    this.fleetSprites.clear();
    this.buildStatic();
    this.fitView();
  }

  dispose(): void {
    this.disposed = true;
    if (this.hoverTimer) window.clearTimeout(this.hoverTimer);
    try {
      this.app.destroy(true, { children: true });
    } catch {
      /* ignore */
    }
  }
}
