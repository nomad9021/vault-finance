export interface PieSlice {
  label: string;
  value: number;
  color: string;
}

export interface PieChartProps {
  data: PieSlice[];
  /** Formats slice values and the center total. */
  format: (value: number) => string;
  /** Center caption under the total, e.g. "spent". */
  centerLabel?: string;
  ariaLabel?: string;
}

const SIZE = 220;
const R = 100;
const INNER = 60;
const CX = SIZE / 2;
const CY = SIZE / 2;

function arc(startAngle: number, endAngle: number): string {
  // Full-circle guard: SVG arcs can't draw a 360° sweep in one path.
  const sweep = endAngle - startAngle;
  if (sweep >= Math.PI * 2 - 1e-6) {
    return [
      `M ${CX} ${CY - R}`,
      `A ${R} ${R} 0 1 1 ${CX - 0.01} ${CY - R}`,
      `L ${CX - 0.01} ${CY - INNER}`,
      `A ${INNER} ${INNER} 0 1 0 ${CX} ${CY - INNER}`,
      "Z",
    ].join(" ");
  }
  const p = (angle: number, radius: number) => [
    CX + radius * Math.sin(angle),
    CY - radius * Math.cos(angle),
  ];
  const large = sweep > Math.PI ? 1 : 0;
  const [x1, y1] = p(startAngle, R);
  const [x2, y2] = p(endAngle, R);
  const [x3, y3] = p(endAngle, INNER);
  const [x4, y4] = p(startAngle, INNER);
  return [
    `M ${x1} ${y1}`,
    `A ${R} ${R} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${INNER} ${INNER} 0 ${large} 0 ${x4} ${y4}`,
    "Z",
  ].join(" ");
}

/** Donut chart with a legend — used for spending-by-category breakdowns. */
export function PieChart({ data, format, centerLabel, ariaLabel = "Breakdown" }: PieChartProps) {
  const slices = data.filter((d) => d.value > 0);
  const total = slices.reduce((s, d) => s + d.value, 0);

  return (
    <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        style={{ width: SIZE, maxWidth: "100%", height: "auto", flex: "0 0 auto" }}
        role="img"
        aria-label={ariaLabel}
      >
        {total === 0 ? (
          <circle cx={CX} cy={CY} r={(R + INNER) / 2} fill="none" stroke="var(--color-divider)" strokeWidth={R - INNER} />
        ) : (
          (() => {
            let angle = 0;
            return slices.map((d) => {
              const start = angle;
              angle += (d.value / total) * Math.PI * 2;
              return <path key={d.label} d={arc(start, angle)} fill={d.color} />;
            });
          })()
        )}
        <text
          x={CX}
          y={CY - 4}
          textAnchor="middle"
          style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 20, fill: "var(--color-text)" }}
        >
          {format(total)}
        </text>
        {centerLabel && (
          <text
            x={CX}
            y={CY + 16}
            textAnchor="middle"
            style={{ fontFamily: "var(--font-body)", fontSize: 11.5, fill: "var(--color-neutral-500)" }}
          >
            {centerLabel}
          </text>
        )}
      </svg>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 160, flex: 1 }}>
        {slices.map((d) => (
          <div key={d.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: d.color, flex: "0 0 auto" }} />
            <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {d.label}
            </span>
            <span style={{ color: "var(--color-neutral-400)" }}>
              {total > 0 ? Math.round((d.value / total) * 100) : 0}%
            </span>
            <span style={{ fontWeight: 600, minWidth: 64, textAlign: "right" }}>{format(d.value)}</span>
          </div>
        ))}
        {slices.length === 0 && (
          <span style={{ fontSize: 13, color: "var(--color-neutral-500)" }}>No spending yet.</span>
        )}
      </div>
    </div>
  );
}
