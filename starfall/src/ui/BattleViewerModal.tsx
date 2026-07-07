// 战斗观看器弹窗:挂载 Three.js 观看器,2× / 跳过 / 关闭,结束显示损失清单。

import { useEffect, useRef, useState } from 'react';
import { BattleViewer, type ViewerState } from '../render/battle/BattleViewer';
import { useStore } from '../store';
import { SHIPS } from '../sim/data';
import type { BattleReport, ShipCount } from '../sim/types';

export function BattleViewerModal(): JSX.Element | null {
  const viewingBattle = useStore((s) => s.viewingBattle);
  const game = useStore((s) => s.game);
  const closeBattle = useStore((s) => s.closeBattle);
  const report = viewingBattle ? game.battles[viewingBattle] : null;

  if (!report) return null;
  return <ViewerInner report={report} onClose={closeBattle} key={report.id} />;
}

function ViewerInner({ report, onClose }: { report: BattleReport; onClose: () => void }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<BattleViewer | null>(null);
  const [state, setState] = useState<ViewerState | null>(null);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const viewer = new BattleViewer(host, report, (s) => setState(s));
    viewerRef.current = viewer;
    const onResize = () => viewer.resize(host.clientWidth, host.clientHeight);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [report]);

  const toggleSpeed = () => {
    const ns = speed === 1 ? 2 : 1;
    setSpeed(ns);
    viewerRef.current?.setSpeed(ns);
  };
  const skip = () => viewerRef.current?.skip();

  const playerAttacker = report.attackerOwner === 'player';
  const attColor = playerAttacker ? '#5eead4' : '#f87171';
  const defColor = report.defenderOwner === 'player' ? '#5eead4' : '#f87171';

  const finished = state?.finished;
  const resultText = resultForPlayer(report);

  return (
    <div className="battle-viewer">
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />

      <div className="bv-top">
        <div>
          <div className="bv-title">⚔ {report.systemName} · 星域交战</div>
          <div className="bv-round">
            {finished ? '战斗结束' : `第 ${state?.round ?? 1} / ${state?.totalRounds ?? '?'} 回合`}
          </div>
          <div className="bv-forces">
            <span className="bv-force att" style={{ color: attColor }}>
              进攻方 {forceCount(state?.attacker)} 舰
            </span>
            <span className="bv-force def" style={{ color: defColor }}>
              防守方 {forceCount(state?.defender)} 舰
            </span>
          </div>
        </div>
        <span className="close-x" style={{ position: 'static', fontSize: 26 }} onClick={onClose}>
          ×
        </span>
      </div>

      {finished && (
        <div className="bv-result">
          <div className="bvr-title" style={{ color: resultText.color }}>
            {resultText.title}
          </div>
          <div className="glass" style={{ padding: '16px 26px', marginTop: 16 }}>
            <div style={{ display: 'flex', gap: 40 }}>
              <LossList title="进攻方损失" color={attColor} losses={report.attackerLosses} />
              <LossList title="防守方损失" color={defColor} losses={report.defenderLosses} />
            </div>
            {report.defenseDestroyed && (
              <div style={{ color: '#fbbf24', marginTop: 10, fontSize: 13 }}>◆ 行星防御炮台已被摧毁</div>
            )}
          </div>
        </div>
      )}

      <div className="bv-controls">
        <button className={`btn ${speed === 2 ? 'active' : ''}`} onClick={toggleSpeed}>
          {speed === 2 ? '2× 倍速' : '1× 常速'}
        </button>
        {!finished && (
          <button className="btn" onClick={skip}>
            跳过 ⏭
          </button>
        )}
        <button className="btn primary" onClick={onClose}>
          {finished ? '关闭战报' : '返回'}
        </button>
      </div>
    </div>
  );
}

function forceCount(snaps?: { kind: string; count: number }[]): number {
  if (!snaps) return 0;
  return snaps.filter((s) => s.kind !== 'defense').reduce((a, b) => a + b.count, 0);
}

function resultForPlayer(report: BattleReport): { title: string; color: string } {
  const playerAttacker = report.attackerOwner === 'player';
  const playerInvolved = playerAttacker || report.defenderOwner === 'player';
  if (report.result === 'attackerRetreat') return { title: '进攻方撤退', color: '#fbbf24' };
  const attackerWon = report.result === 'attackerWin';
  const playerWon = playerAttacker ? attackerWon : !attackerWon;
  if (!playerInvolved) {
    return { title: attackerWon ? '进攻方胜利' : '防守方胜利', color: '#9fb3c8' };
  }
  return playerWon
    ? { title: '我方胜利', color: '#5eead4' }
    : { title: '我方失利', color: '#f87171' };
}

function LossList({ title, color, losses }: { title: string; color: string; losses: ShipCount }): JSX.Element {
  const all: [string, number][] = [
    [SHIPS.corvette.name, losses.corvette],
    [SHIPS.destroyer.name, losses.destroyer],
    [SHIPS.cruiser.name, losses.cruiser],
    [SHIPS.colony.name, losses.colony],
  ];
  const items = all.filter(([, n]) => n > 0);
  return (
    <div>
      <div style={{ color, fontFamily: 'Orbitron, sans-serif', fontSize: 13, marginBottom: 6 }}>{title}</div>
      {items.length === 0 ? (
        <div className="dim" style={{ fontSize: 13 }}>无损失</div>
      ) : (
        items.map(([n, c]) => (
          <div key={n} style={{ fontSize: 13, color: '#e8f0f8' }}>
            {n} × {c}
          </div>
        ))
      )}
    </div>
  );
}
