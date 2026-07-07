// 数字滚动/渐变动画组件 —— 禁止生硬跳变。

import { useEffect, useRef, useState } from 'react';
import { fmt } from './format';

export function AnimatedNumber({ value }: { value: number }): JSX.Element {
  const [display, setDisplay] = useState(value);
  const ref = useRef(value);
  const target = useRef(value);
  const raf = useRef(0);

  useEffect(() => {
    target.current = value;
    const step = () => {
      const cur = ref.current;
      const diff = target.current - cur;
      if (Math.abs(diff) < 0.5) {
        ref.current = target.current;
        setDisplay(target.current);
        return;
      }
      ref.current = cur + diff * 0.25;
      setDisplay(ref.current);
      raf.current = requestAnimationFrame(step);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);

  return <span className="mono">{fmt(display)}</span>;
}
