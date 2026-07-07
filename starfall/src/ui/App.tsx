// 应用根:星图层 → HUD 层 → 弹窗层。

import { MapContainer } from './MapContainer';
import { TopBar } from './TopBar';
import { SidePanel } from './SidePanel';
import { EventLog } from './EventLog';
import { BattleBanner, LaunchHint } from './Banners';
import { BattleViewerModal } from './BattleViewerModal';
import { ResultScreen } from './ResultScreen';
import { TutorialTips } from './TutorialTips';

export default function App(): JSX.Element {
  return (
    <div className="app-root">
      <MapContainer />

      <div className="hud-layer">
        <TopBar />
        <SidePanel />
        <EventLog />
        <TutorialTips />
        <LaunchHint />
        <BattleBanner />
      </div>

      <div className="modal-layer">
        <BattleViewerModal />
        <ResultScreen />
      </div>
    </div>
  );
}
