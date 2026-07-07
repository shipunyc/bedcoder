// UI 格式化工具。

export function fmt(n: number): string {
  if (n >= 100000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 10000) return Math.round(n).toLocaleString();
  return Math.round(n).toString();
}

export function fmtSigned(n: number): string {
  const r = n >= 0 ? '+' : '';
  return `${r}${n.toFixed(1)}`;
}

export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(0)}秒`;
  return fmtTime(sec);
}
