/** Least-squares linear projection of `count` future points from a series. */
export function project(vals: number[], count: number): number[] {
  const n = vals.length;
  if (n === 0) return Array(count).fill(0);
  if (n === 1) return Array(count).fill(vals[0]!);
  const xm = (n - 1) / 2;
  const ym = vals.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (vals[i]! - ym);
    den += (i - xm) ** 2;
  }
  const slope = den ? num / den : 0;
  const intercept = ym - slope * xm;
  return Array.from({ length: count }, (_, k) => Math.round(intercept + slope * (n + k)));
}

export interface TrendChartProps {
  history: number[];
  projected?: number[];
  color: string;
  height?: number;
  /** Draw a soft filled area under the history line. */
  showArea?: boolean;
  emptyLabel?: string;
}

/**
 * A single-series sparkline: a solid history line with a soft area fill, an
 * optional dashed forward projection, and a dot at the last actual point.
 * Stretches to its container width; used on the dashboard trend cards and the
 * Accounts performance panel so both read as one chart language.
 */
export function TrendChart({
  history,
  projected = [],
  color,
  height = 66,
  showArea = true,
  emptyLabel = "Not enough history",
}: TrendChartProps) {
  const all = [...history, ...projected];
  // Guard on the history, not the combined series. A caller that projects from
  // an empty history — which every page does for one render, before its data
  // arrives — otherwise passed this check on the projected points alone, and
  // then indexed history[-1]: x(-1) lands at -288 and y(undefined) is NaN, so
  // the SVG came out malformed and the console filled with attribute errors.
  if (history.length < 2) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--content-tertiary)", fontSize: "var(--text-xs)" }}>
        {emptyLabel}
      </div>
    );
  }
  const W = 600;
  const H = height;
  const pad = 6;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (all.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const last = history.length - 1;
  const histLine = history.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const projLine = [
    `M${x(last).toFixed(1)},${y(history[last]!).toFixed(1)}`,
    ...projected.map((v, k) => `L${x(last + 1 + k).toFixed(1)},${y(v).toFixed(1)}`),
  ].join(" ");
  const area = `${histLine} L${x(last).toFixed(1)},${(H - pad).toFixed(1)} L${x(0).toFixed(1)},${(H - pad).toFixed(1)} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} preserveAspectRatio="none" aria-hidden>
      {showArea && <path d={area} fill={`color-mix(in srgb, ${color} 13%, transparent)`} />}
      <path d={histLine} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {projected.length > 0 && (
        <path d={projLine} fill="none" stroke={color} strokeWidth={2} strokeDasharray="5 4" opacity={0.55} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      )}
      <circle cx={x(last)} cy={y(history[last]!)} r={3} fill={color} />
    </svg>
  );
}
