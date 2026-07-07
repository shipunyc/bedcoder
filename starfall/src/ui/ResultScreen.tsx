// 结算画面:胜负标题 + 数据统计 + 再来一局。

import { useStore } from '../store';
import { fmtTime } from './format';

export function ResultScreen(): JSX.Element | null {
  useStore((s) => s.frame); // 订阅刷新,确保 status 变化时重渲染
  const game = useStore((s) => s.game);
  const newGame = useStore((s) => s.newGame);
  if (game.status === 'playing') return null;

  const won = game.status === 'won';
  const st = game.stats.player;
  const captured = game.systems.filter((s) => s.owner === 'player').length;

  return (
    <div className="result-screen">
      <div className="glass result-card">
        <div className={`rc-title ${won ? 'rc-win' : 'rc-lose'}`}>{won ? '胜 利' : '失 败'}</div>
        <div className="rc-reason">{game.endReason}</div>
        <div className="rc-stats">
          <Stat val={st.kills} label="击毁敌舰" />
          <Stat val={st.shipsLost} label="己方损失" />
          <Stat val={captured} label="控制星系" />
          <Stat val={st.shipsBuilt} label="累计造舰" />
          <Stat val={fmtTime(game.time)} label="用时" />
          <Stat val={st.systemsCaptured} label="占领次数" />
        </div>
        <button className="btn primary" style={{ fontSize: 16, padding: '12px 40px' }} onClick={() => newGame()}>
          ↻ 再来一局(新种子)
        </button>
      </div>
    </div>
  );
}

function Stat({ val, label }: { val: number | string; label: string }): JSX.Element {
  return (
    <div className="rc-stat">
      <div className="rcs-val">{val}</div>
      <div className="rcs-label">{label}</div>
    </div>
  );
}
