// 新手指引:4 条依次出现的浮动提示(建矿 → 造船厂 → 造舰 → 出击),不强制。

import { useEffect } from 'react';
import { useStore } from '../store';

const TIPS = [
  {
    step: 0,
    title: '第一步 · 发展经济',
    text: '点击星图上带青色光环的母星系,选中一颗己方行星,升级「金属矿场」提升资源产出。',
  },
  {
    step: 1,
    title: '第二步 · 建造船坞',
    text: '在母星行星上建造「造船厂」,解锁舰船生产。',
  },
  {
    step: 2,
    title: '第三步 · 打造舰队',
    text: '在造舰面板生产护卫舰/驱逐舰,舰船会进入该星系的驻军池。',
  },
  {
    step: 3,
    title: '第四步 · 出击扩张',
    text: '选中己方星系点「出击」,编组舰队,在星图上点击高亮星系进军,占领星区。',
  },
];

function achievedStep(game: ReturnType<typeof useStore.getState>['game']): number {
  const pPlanets = game.systems.flatMap((s) => s.planets).filter((p) => p.owner === 'player');
  const builtBeyondStart = pPlanets.some(
    (p) => p.buildQueue.length > 0 || p.buildings.metalMine > 1
  );
  const hasYard = pPlanets.some((p) => p.buildings.shipyard >= 1);
  const madeShip = game.stats.player.shipsBuilt > 0 || pPlanets.some((p) => p.shipQueue.length > 0);
  const launched = game.fleets.some((f) => f.owner === 'player') || game.stats.player.systemsCaptured > 0;
  if (launched) return 99;
  if (madeShip) return 3;
  if (hasYard) return 2;
  if (builtBeyondStart) return 1;
  return 0;
}

export function TutorialTips(): JSX.Element | null {
  useStore((s) => s.frame);
  const game = useStore((s) => s.game);
  const step = useStore((s) => s.tutorialStep);
  const advance = useStore((s) => s.advanceTutorial);

  useEffect(() => {
    const a = achievedStep(game);
    if (a > step) advance(a);
  });

  if (step >= 99 || game.status !== 'playing') return null;
  const tip = TIPS.find((t) => t.step === step);
  if (!tip) return null;

  return (
    <div className="tutorial-tip glass" style={{ left: 14, bottom: 290 }}>
      <div className="tt-step">{tip.title}</div>
      <div>{tip.text}</div>
      <div className="tt-close" onClick={() => advance(99)}>
        跳过引导 ✕
      </div>
    </div>
  );
}
