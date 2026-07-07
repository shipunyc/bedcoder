// 战斗横幅、出击提示。

import { useStore } from '../store';

export function BattleBanner(): JSX.Element | null {
  const banner = useStore((s) => s.banner);
  const openBattle = useStore((s) => s.openBattle);
  const dismiss = useStore((s) => s.dismissBanner);
  if (!banner) return null;
  return (
    <div className="battle-banner glass">
      <span className="bb-title">⚔ 战斗爆发于 {banner.systemName} 星系</span>
      <button className="btn primary" onClick={() => openBattle(banner.battleId)}>
        进入观战
      </button>
      <button className="btn" onClick={() => dismiss()}>
        稍后
      </button>
    </div>
  );
}

export function LaunchHint(): JSX.Element | null {
  const launch = useStore((s) => s.launch);
  const cancelLaunch = useStore((s) => s.cancelLaunch);
  if (!launch.active) return null;
  return (
    <div className="launch-hint glass">
      <span>◎ 目标选择态:点击星图上高亮的可达星系确认出击</span>
      <button className="btn danger" onClick={() => cancelLaunch()}>
        取消
      </button>
    </div>
  );
}
