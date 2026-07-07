// 顶栏 HUD:资源(带每秒增量与滚动动画)、核心争夺状态、游戏时间、速度/新局。

import { useStore } from '../store';
import { computeIncome } from '../sim/economy';
import { CORE_HOLD_TARGET } from '../sim/data';
import { AnimatedNumber } from './AnimatedNumber';
import { fmtSigned, fmtTime } from './format';

export function TopBar(): JSX.Element {
  useStore((s) => s.frame); // 订阅刷新
  const game = useStore((s) => s.game);
  const speed = useStore((s) => s.speed);
  const paused = useStore((s) => s.paused);
  const setSpeed = useStore((s) => s.setSpeed);
  const togglePause = useStore((s) => s.togglePause);
  const newGame = useStore((s) => s.newGame);

  const res = game.resources.player;
  const inc = computeIncome(game, 'player');
  const core = game.systems[game.coreSystemId]!;
  const holder = core.owner;
  const holdSec = holder === 'player' ? game.coreHold.player : holder === 'ai' ? game.coreHold.ai : 0;
  const pct = Math.min(100, (holdSec / CORE_HOLD_TARGET) * 100);
  const holdColor = holder === 'player' ? '#5eead4' : holder === 'ai' ? '#f87171' : '#9fb3c8';

  return (
    <div className="topbar">
      <div className="glass">
        <div className="res-group">
          <ResItem label="金属" color="#cbd5e1" value={res.metal} inc={inc.metal} />
          <ResItem label="晶体" color="#7dd3fc" value={res.crystal} inc={inc.crystal} />
          <ResItem label="燃料" color="#fca5a5" value={res.fuel} inc={inc.fuel} />
        </div>
      </div>

      <div className="glass topbar-center">
        <div className="core-status">
          <div className="core-label">◆ 核心星系 · {core.name}</div>
          <div className="core-timer" style={{ color: holdColor }}>
            {holder === 'neutral'
              ? '尚未被占据'
              : `${holder === 'player' ? '我方' : '敌方'}持有 ${fmtTime(holdSec)} / ${fmtTime(CORE_HOLD_TARGET)}`}
          </div>
          <div className="core-bar">
            <div
              className="fill"
              style={{ width: `${pct}%`, background: holdColor, boxShadow: `0 0 10px ${holdColor}` }}
            />
          </div>
        </div>
      </div>

      <div className="glass topbar-right">
        <span className="game-time">⏱ {fmtTime(game.time)}</span>
        <button className={`btn ${paused ? 'active' : ''}`} onClick={togglePause}>
          {paused ? '继续' : '暂停'}
        </button>
        <button className={`btn ${speed === 2 ? 'active' : ''}`} onClick={() => setSpeed(speed === 2 ? 1 : 2)}>
          2×
        </button>
        <button className="btn danger" onClick={() => newGame()}>
          新游戏
        </button>
      </div>
    </div>
  );
}

function ResItem({
  label,
  color,
  value,
  inc,
}: {
  label: string;
  color: string;
  value: number;
  inc: number;
}): JSX.Element {
  return (
    <div className="res-item">
      <div className="res-label">
        <span className="res-dot" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
        {label}
      </div>
      <div className="res-val">
        <AnimatedNumber value={value} />
      </div>
      <div className="res-inc">{fmtSigned(inc)}/秒</div>
    </div>
  );
}
