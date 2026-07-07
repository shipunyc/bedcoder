// 事件流(左下):滚动日志,战斗条目带「▶ 观看」。

import { useStore } from '../store';
import { fmtTime } from './format';

export function EventLog(): JSX.Element {
  useStore((s) => s.frame);
  const game = useStore((s) => s.game);
  const openBattle = useStore((s) => s.openBattle);

  return (
    <div className="event-log glass">
      <div className="el-head">◈ 战况实录</div>
      <div className="el-body">
        {game.log.slice(0, 40).map((e) => (
          <div key={e.id} className={`log-entry log-${e.kind}`}>
            <span className="le-time">{fmtTime(e.time)}</span>
            <span className="le-text">{e.text}</span>
            {e.battleId && game.battles[e.battleId] && (
              <span className="log-watch" onClick={() => openBattle(e.battleId!)}>
                ▶ 观看
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
