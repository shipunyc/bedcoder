// 无头模拟:跑若干局,让 AI 自战,确认 sim 不崩、有战斗、能推进。
import { createGame, tick, dispatch } from '../src/sim/game';
import { launchFleet } from '../src/sim/fleet';
import { combatShips, fleetPower } from '../src/sim/data';

function run(seed: number, seconds: number): void {
  const g = createGame(seed);
  const dt = 0.1;
  let playerActed = 0;
  for (let t = 0; t < seconds / dt; t++) {
    // 简单的"玩家"脚本:偶尔升级母星建筑并造船、出击,制造战斗
    if (t % 30 === 0) {
      const home = g.systems[g.playerHomeId]!;
      const planet = home.planets.find((p) => p.owner === 'player')!;
      dispatch(g, { type: 'queueBuilding', systemId: home.id, planetId: planet.id, building: 'metalMine' });
      dispatch(g, { type: 'queueBuilding', systemId: home.id, planetId: planet.id, building: 'shipyard' });
      dispatch(g, { type: 'queueShip', systemId: home.id, planetId: planet.id, ship: 'corvette', count: 2 });
      playerActed++;
    }
    if (t % 120 === 60) {
      const home = g.systems[g.playerHomeId]!;
      if (combatShips(home.garrison) > 2) {
        const target = home.neighbors[0];
        if (target != null) {
          launchFleet(g, home.id, target, { ...home.garrison, colony: 0 });
        }
      }
    }
    tick(g, dt);
    if (g.status !== 'playing') break;
  }

  const battles = Object.keys(g.battles).length;
  const aiSystems = g.systems.filter((s) => s.owner === 'ai').length;
  const playerSystems = g.systems.filter((s) => s.owner === 'player').length;
  const aiShips = g.systems.filter((s) => s.owner === 'ai').reduce((a, s) => a + combatShips(s.garrison), 0);
  console.log(
    `seed=${seed} t=${g.time.toFixed(0)}s status=${g.status} battles=${battles} ` +
      `player_sys=${playerSystems} ai_sys=${aiSystems} ai_ships=${aiShips} ` +
      `core=${g.systems[g.coreSystemId]!.owner} playerActed=${playerActed}`
  );
}

// 确定性校验:同 seed 两次,关键指标一致
function deterministic(seed: number): void {
  const a = createGame(seed);
  const b = createGame(seed);
  for (let i = 0; i < 3000; i++) {
    tick(a, 0.1);
    tick(b, 0.1);
  }
  const eq =
    a.time.toFixed(3) === b.time.toFixed(3) &&
    JSON.stringify(a.resources) === JSON.stringify(b.resources) &&
    Object.keys(a.battles).length === Object.keys(b.battles).length &&
    a.systems.map((s) => s.owner).join() === b.systems.map((s) => s.owner).join();
  console.log(`determinism seed=${seed}: ${eq ? 'OK' : 'MISMATCH'}`);
}

for (const s of [1, 42, 1337, 90210]) run(s, 900);
deterministic(12345);
deterministic(777);
