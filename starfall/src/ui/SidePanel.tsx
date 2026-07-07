// 星系侧面板:行星列表 → 建筑网格 + 造舰面板 → 驻军池与出击。

import { useState } from 'react';
import { useStore } from '../store';
import {
  BUILDINGS,
  BUILDING_TYPES,
  buildingCost,
  buildingOutput,
  buildingTime,
  canAfford,
  combatShips,
  planetBonus,
  PLANET_ICON,
  PLANET_LABEL,
  SHIPS,
  SHIP_TYPES,
  shipCountTotal,
} from '../sim/data';
import { shipBuildTime } from '../sim/economy';
import type {
  BuildingType,
  Planet,
  Resources,
  ShipType,
  StarSystem,
} from '../sim/types';
import { fmt } from './format';

const RING_LABEL: Record<string, string> = { core: '核心区', contested: '争议区', safe: '安全区' };
const OWNER_LABEL: Record<string, string> = { player: '我方', ai: '敌方', neutral: '中立' };

export function SidePanel(): JSX.Element | null {
  useStore((s) => s.frame);
  const game = useStore((s) => s.game);
  const selectedSystem = useStore((s) => s.selectedSystem);
  const selectedPlanet = useStore((s) => s.selectedPlanet);
  const selectPlanet = useStore((s) => s.selectPlanet);
  const selectSystem = useStore((s) => s.selectSystem);
  const launch = useStore((s) => s.launch);

  if (selectedSystem == null) return null;
  const sys = game.systems[selectedSystem];
  if (!sys) return null;

  const planet = selectedPlanet ? sys.planets.find((p) => p.id === selectedPlanet) : null;

  return (
    <div className="side-panel glass">
      <div className="sp-head">
        <div className="sp-title">
          ✦ {sys.name}
          <span className={`ring-badge ring-${sys.ring}`}>{RING_LABEL[sys.ring]}</span>
        </div>
        <div className="sp-sub">
          归属:{OWNER_LABEL[sys.owner]} · {sys.planets.length} 颗行星
        </div>
        <span className="close-x" onClick={() => selectSystem(null)}>
          ×
        </span>
      </div>

      <div className="sp-body">
        {launch.active && launch.from === sys.id ? (
          <LaunchSelector sys={sys} />
        ) : (
          <>
            <div className="section-title">行星</div>
            {sys.planets.map((p) => (
              <PlanetCard
                key={p.id}
                planet={p}
                selected={p.id === selectedPlanet}
                onClick={() => selectPlanet(p.id === selectedPlanet ? null : p.id)}
              />
            ))}

            {planet && planet.owner === 'player' && <PlanetManage sys={sys} planet={planet} />}

            <GarrisonBar sys={sys} />
          </>
        )}
      </div>
    </div>
  );
}

function planetProdSummary(p: Planet): string[] {
  const out: string[] = [];
  const m = buildingOutput('metalMine', p.buildings.metalMine) * planetBonus(p.type, 'metal');
  const c = buildingOutput('crystalExtractor', p.buildings.crystalExtractor) * planetBonus(p.type, 'crystal');
  const f = buildingOutput('fuelPlant', p.buildings.fuelPlant) * planetBonus(p.type, 'fuel');
  if (m > 0) out.push(`⛏${m.toFixed(0)}`);
  if (c > 0) out.push(`◈${c.toFixed(0)}`);
  if (f > 0) out.push(`⬢${f.toFixed(0)}`);
  if (p.buildings.shipyard > 0) out.push(`⚓Lv${p.buildings.shipyard}`);
  if (p.buildings.defenseTurret > 0) out.push(`⊕${200 * p.buildings.defenseTurret}`);
  return out;
}

function PlanetCard({
  planet,
  selected,
  onClick,
}: {
  planet: Planet;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  const summary = planetProdSummary(planet);
  const busy = planet.buildQueue.length + planet.shipQueue.length;
  return (
    <div className={`planet-card ${selected ? 'selected' : ''}`} onClick={onClick}>
      <div className="pc-head">
        <div className="pc-name">
          {PLANET_ICON[planet.type]} {planet.name}
        </div>
        <div className={`pc-owner owner-${planet.owner}`}>{OWNER_LABEL[planet.owner]}</div>
      </div>
      <div className="pc-summary">
        <span className="dim">{PLANET_LABEL[planet.type]}</span>
        {summary.map((s, i) => (
          <span key={i}>{s}</span>
        ))}
        {busy > 0 && <span style={{ color: '#fbbf24' }}>◔ {busy} 项建造中</span>}
      </div>
    </div>
  );
}

function pendingLevel(planet: Planet, type: BuildingType): number {
  let lvl = planet.buildings[type];
  for (const q of planet.buildQueue) if (q.buildingType === type) lvl = Math.max(lvl, q.targetLevel);
  return lvl;
}

function costOk(res: Resources, cost: Resources): boolean {
  return canAfford(res, cost);
}

function PlanetManage({ sys, planet }: { sys: StarSystem; planet: Planet }): JSX.Element {
  const game = useStore((s) => s.game);
  const act = useStore((s) => s.act);
  const res = game.resources.player;

  const activeBuild = planet.buildQueue[0];
  const activeShip = planet.shipQueue[0];

  return (
    <>
      <div className="section-title">建筑网格</div>
      <div className="build-grid">
        {BUILDING_TYPES.map((type) => {
          const def = BUILDINGS[type];
          const cur = planet.buildings[type];
          const target = pendingLevel(planet, type);
          const maxed = target >= def.maxLevel;
          const nextLevel = target + 1;
          const cost = maxed ? def.baseCost : buildingCost(type, nextLevel);
          const affordable = !maxed && costOk(res, cost);
          const queuedHere = planet.buildQueue.some((q) => q.buildingType === type);
          return (
            <div className="build-cell" key={type} title={def.desc}>
              <div className="bc-icon">{def.icon}</div>
              <div className="bc-name">{def.name}</div>
              <div className="lvl-pips">
                {Array.from({ length: def.maxLevel }).map((_, i) => (
                  <span key={i} className={`lvl-pip ${i < cur ? 'on' : ''}`} />
                ))}
              </div>
              <div className="bc-lvl">{cur === 0 ? '未建' : `Lv${cur}`}{queuedHere && cur < target ? `→${target}` : ''}</div>
              {!maxed ? (
                <>
                  <button
                    className="bc-btn"
                    disabled={!affordable}
                    onClick={() =>
                      act({ type: 'queueBuilding', systemId: sys.id, planetId: planet.id, building: type })
                    }
                  >
                    {cur === 0 ? '建造' : '升级'} · {buildingTime(type, nextLevel).toFixed(0)}s
                  </button>
                  <div className="bc-cost">
                    {cost.metal > 0 && (
                      <span className={res.metal < cost.metal ? 'cost-bad' : 'cost-metal'}>⛏{cost.metal}</span>
                    )}
                    {cost.crystal > 0 && (
                      <span className={res.crystal < cost.crystal ? 'cost-bad' : 'cost-crystal'}>◈{cost.crystal}</span>
                    )}
                    {cost.fuel > 0 && (
                      <span className={res.fuel < cost.fuel ? 'cost-bad' : 'cost-fuel'}>⬢{cost.fuel}</span>
                    )}
                  </div>
                </>
              ) : (
                <div className="bc-lvl" style={{ color: '#fde68a' }}>满级</div>
              )}
            </div>
          );
        })}
      </div>

      {activeBuild && (
        <div className="queue-row">
          <span className="qr-label">
            {BUILDINGS[activeBuild.buildingType].name} → Lv{activeBuild.targetLevel}
          </span>
          <Progress value={1 - activeBuild.remaining / activeBuild.total} />
        </div>
      )}

      <div className="section-title">造舰面板</div>
      {planet.buildings.shipyard <= 0 ? (
        <div className="dim" style={{ fontSize: 12, padding: '6px 2px' }}>
          需先建造「造船厂」以解锁造舰。
        </div>
      ) : (
        <ShipYard sys={sys} planet={planet} />
      )}

      {activeShip && (
        <div className="queue-row">
          <span className="qr-label">{SHIPS[activeShip.shipType].name}</span>
          <Progress value={1 - activeShip.remaining / activeShip.total} />
        </div>
      )}
      {planet.shipQueue.length > 1 && (
        <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
          队列中还有 {planet.shipQueue.length - 1} 艘待造
        </div>
      )}
    </>
  );
}

function ShipYard({ sys, planet }: { sys: StarSystem; planet: Planet }): JSX.Element {
  const game = useStore((s) => s.game);
  const act = useStore((s) => s.act);
  const res = game.resources.player;
  const [qty, setQty] = useState<Record<ShipType, number>>({
    corvette: 1,
    destroyer: 1,
    cruiser: 1,
    colony: 1,
  });

  return (
    <>
      {SHIP_TYPES.map((type) => {
        const def = SHIPS[type];
        const n = qty[type];
        const affordable = costOk(res, def.cost);
        const time = shipBuildTime(type, planet.buildings.shipyard);
        return (
          <div className="ship-card" key={type}>
            <div className="sc-icon">{def.icon}</div>
            <div className="sc-info">
              <div className="sc-name">{def.name}</div>
              <div className="sc-stat">
                <span>❤{def.hp}</span>
                <span>⚔{def.firepower}</span>
                <span className="dim">{time.toFixed(0)}s</span>
              </div>
              <div className="bc-cost" style={{ justifyContent: 'flex-start', marginTop: 2 }}>
                <span className={res.metal < def.cost.metal ? 'cost-bad' : 'cost-metal'}>⛏{def.cost.metal}</span>
                <span className={res.crystal < def.cost.crystal ? 'cost-bad' : 'cost-crystal'}>◈{def.cost.crystal}</span>
                <span className={res.fuel < def.cost.fuel ? 'cost-bad' : 'cost-fuel'}>⬢{def.cost.fuel}</span>
              </div>
            </div>
            <div className="sc-actions">
              <button className="qty-btn" onClick={() => setQty((q) => ({ ...q, [type]: Math.max(1, q[type] - 1) }))}>
                −
              </button>
              <span className="mono" style={{ minWidth: 18, textAlign: 'center' }}>{n}</span>
              <button className="qty-btn" onClick={() => setQty((q) => ({ ...q, [type]: q[type] + 1 }))}>
                +
              </button>
              <button
                className="bc-btn"
                style={{ width: 'auto', padding: '4px 8px' }}
                disabled={!affordable}
                onClick={() => act({ type: 'queueShip', systemId: sys.id, planetId: planet.id, ship: type, count: n })}
              >
                建造
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}

function GarrisonBar({ sys }: { sys: StarSystem }): JSX.Element | null {
  const startLaunch = useStore((s) => s.startLaunch);
  const g = sys.garrison;
  const total = shipCountTotal(g);
  const canLaunch = sys.owner === 'player' && total > 0;

  return (
    <>
      <div className="section-title">驻军池</div>
      <div className="garrison-bar">
        {total === 0 ? (
          <span className="dim">无驻军</span>
        ) : (
          <>
            {g.corvette > 0 && <GItem icon="△" n={g.corvette} />}
            {g.destroyer > 0 && <GItem icon="◆" n={g.destroyer} />}
            {g.cruiser > 0 && <GItem icon="⬣" n={g.cruiser} />}
            {g.colony > 0 && <GItem icon="⬡" n={g.colony} />}
          </>
        )}
        {canLaunch && (
          <button
            className="btn primary"
            style={{ marginLeft: 'auto' }}
            onClick={() => startLaunch(sys.id)}
          >
            ⚔ 出击
          </button>
        )}
      </div>
      {sys.owner === 'player' && combatShips(g) === 0 && total > 0 && (
        <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
          仅有殖民船,派往中立星系可扩张。
        </div>
      )}
    </>
  );
}

function GItem({ icon, n }: { icon: string; n: number }): JSX.Element {
  return (
    <div className="garrison-item">
      <span className="gi-icon">{icon}</span>
      {n}
    </div>
  );
}

function LaunchSelector({ sys }: { sys: StarSystem }): JSX.Element {
  const launch = useStore((s) => s.launch);
  const setLaunchShips = useStore((s) => s.setLaunchShips);
  const cancelLaunch = useStore((s) => s.cancelLaunch);
  const g = sys.garrison;
  const sel = launch.ships;
  const total = shipCountTotal(sel);

  const rows: { type: ShipType; icon: string; name: string }[] = SHIP_TYPES.filter((t) => g[t] > 0).map(
    (t) => ({ type: t, icon: SHIPS[t].icon, name: SHIPS[t].name })
  );

  return (
    <>
      <div className="section-title">编组出击</div>
      <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>
        选择随行舰船数量,然后在星图上点击高亮的可达星系确认目标。
      </div>
      {rows.map((r) => (
        <div className="ship-card" key={r.type}>
          <div className="sc-icon">{r.icon}</div>
          <div className="sc-info">
            <div className="sc-name">{r.name}</div>
            <div className="sc-stat dim">驻军 {g[r.type]} 艘</div>
          </div>
          <div className="sc-actions">
            <button
              className="qty-btn"
              onClick={() => setLaunchShips(r.type, Math.max(0, sel[r.type] - 1))}
            >
              −
            </button>
            <span className="mono" style={{ minWidth: 20, textAlign: 'center' }}>{sel[r.type]}</span>
            <button
              className="qty-btn"
              onClick={() => setLaunchShips(r.type, Math.min(g[r.type], sel[r.type] + 1))}
            >
              +
            </button>
            <button className="bc-btn" style={{ width: 'auto', padding: '4px 8px' }} onClick={() => setLaunchShips(r.type, g[r.type])}>
              全部
            </button>
          </div>
        </div>
      ))}
      <div className="garrison-bar" style={{ justifyContent: 'space-between' }}>
        <span>已选 {total} 艘 · 战力约 {fmt(estimatePower(sel))}</span>
        <button className="btn danger" onClick={() => cancelLaunch()}>
          取消
        </button>
      </div>
    </>
  );
}

function estimatePower(s: { corvette: number; destroyer: number; cruiser: number; colony: number }): number {
  return (
    s.corvette * (SHIPS.corvette.hp * 0.3 + SHIPS.corvette.firepower) +
    s.destroyer * (SHIPS.destroyer.hp * 0.3 + SHIPS.destroyer.firepower) +
    s.cruiser * (SHIPS.cruiser.hp * 0.3 + SHIPS.cruiser.firepower)
  );
}

function Progress({ value }: { value: number }): JSX.Element {
  return (
    <div className="progress" style={{ flex: 1 }}>
      <div className="pfill" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      <div className="pflow" />
    </div>
  );
}
