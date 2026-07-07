// 验证:一个有章法的玩家能否在 10~20 分钟内取胜。
import { createGame, tick, dispatch } from '../src/sim/game';
import { launchFleet, shortestPath } from '../src/sim/fleet';
import { combatShips, fleetPower, canAfford, SHIPS } from '../src/sim/data';
import type { GameState } from '../src/sim/types';

function playerTurn(g: GameState): void {
  // 在所有己方带船坞行星上狂造军舰;母星补建经济与船坞
  for (const sys of g.systems) {
    if (sys.owner !== 'player') continue;
    for (const p of sys.planets) {
      if (p.owner !== 'player') continue;
      if (p.buildQueue.length === 0) {
        // 优先船坞→矿→防御
        if (p.buildings.shipyard < 2) dispatch(g, { type: 'queueBuilding', systemId: sys.id, planetId: p.id, building: 'shipyard' });
        else if (p.buildings.metalMine < 4) dispatch(g, { type: 'queueBuilding', systemId: sys.id, planetId: p.id, building: 'metalMine' });
        else if (p.buildings.crystalExtractor < 3) dispatch(g, { type: 'queueBuilding', systemId: sys.id, planetId: p.id, building: 'crystalExtractor' });
        else if (p.buildings.fuelPlant < 3) dispatch(g, { type: 'queueBuilding', systemId: sys.id, planetId: p.id, building: 'fuelPlant' });
        else if (p.buildings.defenseTurret < 3) dispatch(g, { type: 'queueBuilding', systemId: sys.id, planetId: p.id, building: 'defenseTurret' });
      }
      if (p.buildings.shipyard > 0 && p.shipQueue.length < 2) {
        if (canAfford(g.resources.player, SHIPS.destroyer.cost)) dispatch(g, { type: 'queueShip', systemId: sys.id, planetId: p.id, ship: 'destroyer', count: 1 });
        else dispatch(g, { type: 'queueShip', systemId: sys.id, planetId: p.id, ship: 'corvette', count: 1 });
        // 偶尔造殖民船
        if (g.systems.some((s) => s.owner === 'neutral') && !g.systems.some((s) => s.owner === 'player' && s.garrison.colony > 0) && canAfford(g.resources.player, SHIPS.colony.cost)) {
          dispatch(g, { type: 'queueShip', systemId: sys.id, planetId: p.id, ship: 'colony', count: 1 });
        }
      }
    }
  }
  // 殖民船 → 最近中立
  for (const sys of g.systems) {
    if (sys.owner === 'player' && sys.garrison.colony > 0) {
      let best: number | null = null, bl = Infinity;
      for (const s of g.systems) {
        if (s.owner !== 'neutral') continue;
        const path = shortestPath(g, sys.id, s.id);
        if (path && path.length < bl) { bl = path.length; best = s.id; }
      }
      if (best != null) launchFleet(g, sys.id, best, { corvette: Math.min(1, sys.garrison.corvette), destroyer: 0, cruiser: 0, colony: sys.garrison.colony });
    }
  }
  // 集结最强星系,进攻核心或最近敌系
  let rally = null as null | GameState['systems'][0], rp = 0;
  for (const sys of g.systems) {
    if (sys.owner !== 'player') continue;
    const pw = fleetPower(sys.garrison);
    if (pw > rp) { rp = pw; rally = sys; }
  }
  if (rally && rp > 1500) {
    const core = g.systems[g.coreSystemId]!;
    let target = core.owner !== 'player' ? core.id : null;
    if (target == null) {
      // 打最近的敌系
      let bl = Infinity;
      for (const s of g.systems) {
        if (s.owner !== 'ai') continue;
        const path = shortestPath(g, rally.id, s.id);
        if (path && path.length < bl) { bl = path.length; target = s.id; }
      }
    }
    if (target != null && shortestPath(g, rally.id, target)) {
      launchFleet(g, rally.id, target, { corvette: rally.garrison.corvette, destroyer: rally.garrison.destroyer, cruiser: rally.garrison.cruiser, colony: 0 });
    }
  }
}

function run(seed: number): void {
  const g = createGame(seed);
  const dt = 0.1;
  for (let t = 0; t < 20 * 60 / dt; t++) {
    if (t % 25 === 0) playerTurn(g);
    tick(g, dt);
    if (g.status !== 'playing') break;
  }
  console.log(`seed=${seed} status=${g.status} t=${g.time.toFixed(0)}s core=${g.systems[g.coreSystemId]!.owner} player_sys=${g.systems.filter(s=>s.owner==='player').length} ai_sys=${g.systems.filter(s=>s.owner==='ai').length} kills=${g.stats.player.kills}`);
}

for (const s of [1, 42, 1337, 90210, 7]) run(s);
