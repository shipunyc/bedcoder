// 星图容器:挂载 Pixi 渲染器,管理出击可达高亮与悬停 tooltip。

import { useEffect, useRef, useState } from 'react';
import { MapRenderer, type TooltipData } from '../render/map/MapRenderer';
import { useStore } from '../store';

export function MapContainer(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MapRenderer | null>(null);
  const firstGame = useRef(true);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const game = useStore((s) => s.game);
  const launch = useStore((s) => s.launch);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new MapRenderer((t) => setTooltip(t));
    rendererRef.current = renderer;
    renderer.init(host);
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  // 新游戏 → 重建星图(跳过首次挂载,init 已负责初始渲染)
  useEffect(() => {
    if (firstGame.current) {
      firstGame.current = false;
      return;
    }
    const r = rendererRef.current;
    if (r) r.rebuild();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game]);

  // 出击目标选择态 → 高亮可达星系
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    if (launch.active && launch.from != null) {
      r.setReachable(r.computeReachable(launch.from));
    } else {
      r.setReachable(null);
    }
  }, [launch.active, launch.from]);

  return (
    <>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0, zIndex: 1 }} />
      {tooltip && <MapTooltip data={tooltip} />}
    </>
  );
}

function MapTooltip({ data }: { data: TooltipData }): JSX.Element {
  const x = Math.min(data.x + 16, window.innerWidth - 260);
  const y = Math.min(data.y + 14, window.innerHeight - 140);
  return (
    <div className="map-tooltip glass" style={{ left: x, top: y }}>
      <div className="mt-title">{data.title}</div>
      {data.rows.map(([k, v], i) => (
        <div className="mt-row" key={i}>
          <span className="dim">{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}
