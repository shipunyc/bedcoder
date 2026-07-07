// ============================================================================
// Three.js 战斗观看器:消费 combat 输出的 RoundEvent 数组做定速回放。
// 低多边形舰船(InstancedMesh)+ 动能弹道 + 粒子爆炸 + UnrealBloom 后期。
// ============================================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BattleReport, ShipType, StackSnapshot } from '../../sim/types';

const CY = 0x5eead4;
const RD = 0xf87171;

interface Slot {
  pos: THREE.Vector3;
  alive: boolean;
}
interface StackVis {
  side: 'attacker' | 'defender';
  kind: ShipType;
  mesh: THREE.InstancedMesh;
  slots: Slot[];
  alive: number;
}

interface Bolt {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  to: THREE.Vector3;
  life: number;
  ttl: number;
  active: boolean;
}
interface Boom {
  points: THREE.Points;
  vel: Float32Array;
  life: number;
  ttl: number;
  light: THREE.PointLight;
  active: boolean;
}

export interface ViewerState {
  round: number;
  totalRounds: number;
  attacker: StackSnapshot[];
  defender: StackSnapshot[];
  finished: boolean;
}

const ROUND_TIME = 1.2; // 每回合定速秒数

export class BattleViewer {
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private controls: OrbitControls;
  private stacks: StackVis[] = [];
  private bolts: Bolt[] = [];
  private booms: Boom[] = [];
  private dummy = new THREE.Object3D();
  private report: BattleReport;
  private roundIndex = -1;
  private roundClock = 0;
  private killsApplied = false;
  private speed = 1;
  private finished = false;
  private raf = 0;
  private lastT = 0;
  private onState: (s: ViewerState) => void;
  private disposed = false;
  private clockNoise = 0;

  constructor(container: HTMLElement, report: BattleReport, onState: (s: ViewerState) => void) {
    this.report = report;
    this.onState = onState;

    const w = container.clientWidth;
    const h = container.clientHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.domElement.id = 'battle-canvas';
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(52, w / h, 0.1, 4000);
    this.camera.position.set(0, 60, 210);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.6;
    this.controls.minDistance = 90;
    this.controls.maxDistance = 460;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 1.15, 0.62, 0.18);
    this.composer.addPass(bloom);

    this.buildEnvironment();
    this.buildFleets();
    this.buildPools();

    this.lastT = performance.now();
    this.loop();
  }

  // ---------- 场景搭建 ----------

  private buildEnvironment(): void {
    this.scene.add(new THREE.AmbientLight(0x223344, 1.4));
    const key = new THREE.DirectionalLight(0x88bbff, 0.6);
    key.position.set(120, 160, 100);
    this.scene.add(key);

    // 星点
    const starCount = 2600;
    const sg = new THREE.BufferGeometry();
    const sp = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 900 + Math.random() * 1400;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      sp[i * 3] = r * Math.sin(ph) * Math.cos(th);
      sp[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      sp[i * 3 + 2] = r * Math.cos(ph);
    }
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const stars = new THREE.Points(
      sg,
      new THREE.PointsMaterial({ color: 0x9fc6ff, size: 1.6, sizeAttenuation: true, transparent: true, opacity: 0.9 })
    );
    this.scene.add(stars);

    // 远景行星
    const planet = new THREE.Mesh(
      new THREE.IcosahedronGeometry(150, 2),
      new THREE.MeshStandardMaterial({ color: 0x18324a, emissive: 0x0a1a2e, flatShading: true, roughness: 1 })
    );
    planet.position.set(-360, -170, -640);
    this.scene.add(planet);
    // 大气辉光
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(168, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0x2a6cff, transparent: true, opacity: 0.16, side: THREE.BackSide })
    );
    atmo.position.copy(planet.position);
    this.scene.add(atmo);
    const rim = new THREE.PointLight(0x3b7dff, 2.2, 900);
    rim.position.set(-250, -80, -480);
    this.scene.add(rim);

    // 星云色块
    for (let i = 0; i < 4; i++) {
      const col = i % 2 === 0 ? 0x1b3a6b : 0x3a1b52;
      const neb = new THREE.Mesh(
        new THREE.PlaneGeometry(1200, 1200),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false })
      );
      neb.position.set((Math.random() - 0.5) * 900, (Math.random() - 0.5) * 500, -700 - i * 120);
      this.scene.add(neb);
    }
  }

  private shipGeometry(kind: ShipType): THREE.BufferGeometry {
    switch (kind) {
      case 'corvette':
        return new THREE.ConeGeometry(1.6, 7, 4);
      case 'destroyer': {
        const g = new THREE.BoxGeometry(3, 2, 7);
        return g;
      }
      case 'cruiser':
        return new THREE.DodecahedronGeometry(4.4, 0);
      case 'colony':
        return new THREE.OctahedronGeometry(3.2, 0);
    }
  }

  private buildFleets(): void {
    const build = (side: 'attacker' | 'defender', snaps: StackSnapshot[]) => {
      const combat = snaps.filter((s) => s.kind !== 'defense') as { kind: ShipType; count: number }[];
      const color = side === 'attacker' ? this.report.attackerOwner === 'player' ? CY : RD : this.report.defenderOwner === 'player' ? CY : RD;
      const zBase = side === 'attacker' ? 95 : -95;
      const dir = side === 'attacker' ? -1 : 1;
      let rowOffset = 0;
      for (const s of combat) {
        const geo = this.shipGeometry(s.kind);
        const mat = new THREE.MeshStandardMaterial({
          color: 0x0b1622,
          emissive: color,
          emissiveIntensity: 1.4,
          flatShading: true,
          metalness: 0.2,
          roughness: 0.5,
        });
        const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, s.count));
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const slots: Slot[] = [];
        const cols = Math.ceil(Math.sqrt(s.count));
        for (let i = 0; i < s.count; i++) {
          const cx = (i % cols) - (cols - 1) / 2;
          const cy = Math.floor(i / cols) - Math.floor(s.count / cols) / 2;
          const pos = new THREE.Vector3(cx * 11, cy * 8, zBase + rowOffset * dir + (Math.random() - 0.5) * 4);
          slots.push({ pos, alive: true });
          this.dummy.position.copy(pos);
          this.dummy.rotation.set(dir < 0 ? -Math.PI / 2 : Math.PI / 2, 0, Math.random() * 0.4);
          this.dummy.updateMatrix();
          mesh.setMatrixAt(i, this.dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        this.scene.add(mesh);
        this.stacks.push({ side, kind: s.kind, mesh, slots, alive: s.count });
        rowOffset += 26;
      }
    };
    build('attacker', this.report.initialAttacker);
    build('defender', this.report.initialDefender);
  }

  private buildPools(): void {
    // 弹道池
    const boltGeo = new THREE.SphereGeometry(0.9, 6, 6);
    for (let i = 0; i < 120; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const m = new THREE.Mesh(boltGeo, mat);
      m.visible = false;
      this.scene.add(m);
      this.bolts.push({ mesh: m, from: new THREE.Vector3(), to: new THREE.Vector3(), life: 0, ttl: 0.4, active: false });
    }
    // 爆炸池
    const P = 40;
    for (let i = 0; i < 20; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P * 3), 3));
      const pts = new THREE.Points(
        geo,
        new THREE.PointsMaterial({ color: 0xffcc88, size: 2.4, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false })
      );
      pts.visible = false;
      this.scene.add(pts);
      const light = new THREE.PointLight(0xffaa66, 0, 120);
      this.scene.add(light);
      this.booms.push({ points: pts, vel: new Float32Array(P * 3), life: 0, ttl: 0.9, light, active: false });
    }
  }

  // ---------- 回放 ----------

  private stackFor(side: 'attacker' | 'defender', kind: ShipType): StackVis | undefined {
    return this.stacks.find((s) => s.side === side && s.kind === kind);
  }

  private aliveSlot(sv: StackVis): Slot | null {
    const live = sv.slots.filter((s) => s.alive);
    if (live.length === 0) return null;
    return live[Math.floor(Math.random() * live.length)]!;
  }

  private spawnBolt(from: THREE.Vector3, to: THREE.Vector3, playerSide: boolean): void {
    const b = this.bolts.find((x) => !x.active);
    if (!b) return;
    b.active = true;
    b.life = 0;
    b.from.copy(from);
    b.to.copy(to);
    (b.mesh.material as THREE.MeshBasicMaterial).color.setHex(playerSide ? 0xd6fff7 : 0xffb37a);
    b.mesh.scale.set(1, 1, 1);
    b.mesh.visible = true;
    b.mesh.position.copy(from);
  }

  private spawnBoom(at: THREE.Vector3): void {
    const b = this.booms.find((x) => !x.active);
    if (!b) return;
    b.active = true;
    b.life = 0;
    const pos = b.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, at.x, at.y, at.z);
      const sp = 30 + Math.random() * 60;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      b.vel[i * 3] = sp * Math.sin(ph) * Math.cos(th);
      b.vel[i * 3 + 1] = sp * Math.sin(ph) * Math.sin(th);
      b.vel[i * 3 + 2] = sp * Math.cos(ph);
    }
    pos.needsUpdate = true;
    b.points.visible = true;
    (b.points.material as THREE.PointsMaterial).opacity = 1;
    b.light.position.copy(at);
    b.light.intensity = 6;
  }

  private startRound(idx: number): void {
    this.roundIndex = idx;
    this.roundClock = 0;
    this.killsApplied = false;
    if (idx >= this.report.rounds.length) {
      this.finish();
      return;
    }
    const rd = this.report.rounds[idx]!;
    // 生成弹道
    for (const f of rd.fires) {
      if (f.fromKind === 'defense' || f.toKind === 'defense') continue;
      const fromSV = this.stackFor(f.fromSide, f.fromKind as ShipType);
      const toSV = this.stackFor(f.toSide, f.toKind as ShipType);
      if (!fromSV || !toSV) continue;
      const a = this.aliveSlot(fromSV);
      const d = this.aliveSlot(toSV);
      if (!a || !d) continue;
      const playerShoots =
        (f.fromSide === 'attacker' && this.report.attackerOwner === 'player') ||
        (f.fromSide === 'defender' && this.report.defenderOwner === 'player');
      this.spawnBolt(a.pos, d.pos, playerShoots);
    }
    this.emitState();
  }

  private applyKills(idx: number): void {
    const rd = this.report.rounds[idx]!;
    // 目标存活数(该回合末快照)
    const wantAtt = new Map<ShipType, number>();
    const wantDef = new Map<ShipType, number>();
    for (const s of rd.attacker) if (s.kind !== 'defense') wantAtt.set(s.kind as ShipType, s.count);
    for (const s of rd.defender) if (s.kind !== 'defense') wantDef.set(s.kind as ShipType, s.count);
    for (const sv of this.stacks) {
      const want = (sv.side === 'attacker' ? wantAtt.get(sv.kind) : wantDef.get(sv.kind)) ?? 0;
      while (sv.alive > want) {
        const live = sv.slots.filter((s) => s.alive);
        if (live.length === 0) break;
        const victim = live[Math.floor(Math.random() * live.length)]!;
        victim.alive = false;
        sv.alive--;
        this.spawnBoom(victim.pos);
        // 隐藏该实例
        const i = sv.slots.indexOf(victim);
        this.dummy.position.copy(victim.pos);
        this.dummy.scale.set(0.001, 0.001, 0.001);
        this.dummy.updateMatrix();
        sv.mesh.setMatrixAt(i, this.dummy.matrix);
        this.dummy.scale.set(1, 1, 1);
        sv.mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  private emitState(): void {
    const rd = this.roundIndex >= 0 && this.roundIndex < this.report.rounds.length
      ? this.report.rounds[this.roundIndex]!
      : null;
    this.onState({
      round: this.roundIndex + 1,
      totalRounds: this.report.rounds.length,
      attacker: rd ? rd.attacker : this.report.initialAttacker,
      defender: rd ? rd.defender : this.report.initialDefender,
      finished: this.finished,
    });
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.emitState();
  }

  setSpeed(mult: number): void {
    this.speed = mult;
  }

  skip(): void {
    // 一次性推进到结尾
    for (let i = Math.max(0, this.roundIndex); i < this.report.rounds.length; i++) {
      this.applyKills(i);
    }
    this.roundIndex = this.report.rounds.length;
    this.finish();
  }

  // ---------- 主循环 ----------

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    let dt = (now - this.lastT) / 1000;
    this.lastT = now;
    if (dt > 0.1) dt = 0.1;

    if (!this.finished) {
      if (this.roundIndex < 0) {
        this.startRound(0);
      } else {
        this.roundClock += dt * this.speed;
        if (!this.killsApplied && this.roundClock >= ROUND_TIME * 0.55) {
          this.applyKills(this.roundIndex);
          this.killsApplied = true;
          this.emitState();
        }
        if (this.roundClock >= ROUND_TIME) {
          this.startRound(this.roundIndex + 1);
        }
      }
    }

    this.updateBolts(dt);
    this.updateBooms(dt);
    this.advanceFormation(dt);

    // 摄像机手持噪声
    this.clockNoise += dt;
    this.controls.target.set(
      Math.sin(this.clockNoise * 0.7) * 3,
      Math.cos(this.clockNoise * 0.5) * 2,
      0
    );
    this.controls.update();

    this.composer.render();
  };

  private updateBolts(dt: number): void {
    for (const b of this.bolts) {
      if (!b.active) continue;
      b.life += dt * this.speed;
      const t = Math.min(1, b.life / b.ttl);
      b.mesh.position.lerpVectors(b.from, b.to, t);
      const stretch = 3 + Math.sin(t * Math.PI) * 4;
      b.mesh.scale.set(1, 1, stretch);
      b.mesh.lookAt(b.to);
      if (t >= 1) {
        b.active = false;
        b.mesh.visible = false;
      }
    }
  }

  private updateBooms(dt: number): void {
    for (const b of this.booms) {
      if (!b.active) continue;
      b.life += dt * this.speed;
      const pos = b.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        pos.setXYZ(
          i,
          pos.getX(i) + b.vel[i * 3]! * dt,
          pos.getY(i) + b.vel[i * 3 + 1]! * dt,
          pos.getZ(i) + b.vel[i * 3 + 2]! * dt
        );
      }
      pos.needsUpdate = true;
      const t = Math.min(1, b.life / b.ttl);
      (b.points.material as THREE.PointsMaterial).opacity = 1 - t;
      b.light.intensity = 6 * (1 - t);
      if (t >= 1) {
        b.active = false;
        b.points.visible = false;
        b.light.intensity = 0;
      }
    }
  }

  private advanceFormation(dt: number): void {
    // 双方战列线随回合缓慢逼近
    const prog = Math.min(1, (this.roundIndex + this.roundClock / ROUND_TIME) / 12);
    const target = 95 - prog * 40;
    for (const sv of this.stacks) {
      const dir = sv.side === 'attacker' ? 1 : -1;
      for (let i = 0; i < sv.slots.length; i++) {
        const slot = sv.slots[i]!;
        if (!slot.alive) continue;
        const desiredZ = target * dir + (slot.pos.z - Math.sign(slot.pos.z) * 95) * 0 + (i % 5) * dir * 5;
        slot.pos.z += (desiredZ - slot.pos.z) * Math.min(1, dt * 0.5);
        this.dummy.position.copy(slot.pos);
        this.dummy.rotation.set(dir > 0 ? -Math.PI / 2 : Math.PI / 2, 0, i * 0.3);
        this.dummy.updateMatrix();
        sv.mesh.setMatrixAt(i, this.dummy.matrix);
      }
      sv.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.scene.traverse((o) => {
      const any = o as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
      if (any.geometry) any.geometry.dispose();
      if (any.material) {
        const m = any.material;
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else m.dispose();
      }
    });
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
