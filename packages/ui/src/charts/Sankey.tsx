import { useMemo, useState } from "react";

/**
 * Interactive cash-flow Sankey: income sources (left) → total-income hub →
 * spending leaves (right). Direct port of the design reference's
 * sankeyGeo()/buildSankey() layout (design/reference/Finance App v3.dc.html)
 * onto server-provided data. Click a node or flow to focus it — the page
 * around this component renders the drill-in panel.
 *
 * Interactions are click-based, never hover-only, so the same component
 * serves the Phase 2 touch targets unchanged.
 */

export interface SankeyNodeDatum {
  id: string;
  label: string;
  value: number;
  color: string;
}

export interface SankeyProps {
  incomes: SankeyNodeDatum[];
  leaves: SankeyNodeDatum[];
  /** Label above the hub bar, e.g. "TOTAL INCOME · $4,000". */
  hubLabel: string;
  /** Value formatter for node captions. */
  format: (value: number) => string;
  focus: string | null;
  onFocus: (id: string | null) => void;
  /** Tint links by category color (design's colorfulFlow); hub-grey otherwise. */
  colorful?: boolean;
  hubColor?: string;
  ariaLabel?: string;
}

const H = 640;
const W = 1040;
const NW = 4;
const PAD = 26;
const X_INC = 200;
const X_HUB = 492;
const X_LEAF = 806;
const GAP_L = 10;
const GAP_I = 14;

interface PlacedNode extends SankeyNodeDatum {
  x: number;
  y: number;
  h: number;
}

interface Link {
  from: string;
  to: string;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  t: number;
}

function rgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function linkPath(l: Link): string {
  const mx = (l.sx + l.tx) / 2;
  return `M${l.sx},${l.sy} C${mx},${l.sy} ${mx},${l.ty} ${l.tx},${l.ty} L${l.tx},${l.ty + l.t} C${mx},${l.ty + l.t} ${mx},${l.sy + l.t} ${l.sx},${l.sy + l.t} Z`;
}

function layout(incomes: SankeyNodeDatum[], leaves: SankeyNodeDatum[]) {
  const total = Math.max(
    1,
    incomes.reduce((s, n) => s + n.value, 0),
  );
  const availL = H - 2 * PAD - (leaves.length - 1) * GAP_L;
  const scale = availL / total;

  const heights = leaves.map((n) => Math.max(6, n.value * scale));
  const sumL = heights.reduce((a, b) => a + b, 0) + (leaves.length - 1) * GAP_L;
  let y = (H - sumL) / 2;
  const placedLeaves: PlacedNode[] = leaves.map((n, i) => {
    const node = { ...n, x: X_LEAF, y, h: heights[i]! };
    y += heights[i]! + GAP_L;
    return node;
  });

  const hubH = heights.reduce((a, b) => a + b, 0);
  const hubY = (H - hubH) / 2;

  const iHeights = incomes.map((n) => n.value * scale);
  const sumI = iHeights.reduce((a, b) => a + b, 0) + (incomes.length - 1) * GAP_I;
  let yi = (H - sumI) / 2;
  const placedIncomes: PlacedNode[] = incomes.map((n, i) => {
    const node = { ...n, x: X_INC, y: yi, h: iHeights[i]! };
    yi += iHeights[i]! + GAP_I;
    return node;
  });

  const links: Link[] = [];
  let hubIn = hubY;
  for (const n of placedIncomes) {
    links.push({ from: n.id, to: "hub", sx: n.x + NW, sy: n.y, tx: X_HUB, ty: hubIn, t: n.h });
    hubIn += n.h;
  }
  let hubOut = hubY;
  for (const n of placedLeaves) {
    links.push({ from: "hub", to: n.id, sx: X_HUB + NW, sy: hubOut, tx: n.x, ty: n.y, t: n.h });
    hubOut += n.h;
  }

  return { incomes: placedIncomes, leaves: placedLeaves, links, hubY, hubH };
}

export function Sankey({
  incomes,
  leaves,
  hubLabel,
  format,
  focus,
  onFocus,
  colorful = true,
  hubColor = "#9397ab",
  ariaLabel = "Cash flow diagram",
}: SankeyProps) {
  const [hover, setHover] = useState<number | null>(null);
  const geo = useMemo(() => layout(incomes, leaves), [incomes, leaves]);
  const gradientSeed = useMemo(() => Math.random().toString(36).slice(2, 8), []);

  const colorById = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of [...incomes, ...leaves]) map.set(n.id, n.color);
    return map;
  }, [incomes, leaves]);
  const linkColor = (id: string) => (colorful ? (colorById.get(id) ?? hubColor) : hubColor);
  const linkHot = (l: Link) =>
    focus !== null && (l.from === focus || l.to === focus || focus === "hub");
  const nodeOpacity = (id: string) =>
    focus && focus !== id && focus !== "hub" && id !== "hub" ? 0.3 : 1;

  const labelStyle = {
    fontFamily: "var(--font-heading)",
    fontWeight: 600,
    fontSize: 12.5,
    fill: "var(--color-text)",
  } as const;
  const mutedStyle = {
    fontFamily: "var(--font-body)",
    fontWeight: 400,
    fontSize: 11.5,
    fill: "var(--color-neutral-500)",
  } as const;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        {geo.links.map((l, i) => {
          const catId = l.to === "hub" ? l.from : l.to;
          const c1 = l.to === "hub" ? linkColor(catId) : hubColor;
          const c2 = l.to === "hub" ? hubColor : linkColor(catId);
          return (
            <linearGradient
              key={i}
              id={`flow-${gradientSeed}-${i}`}
              gradientUnits="userSpaceOnUse"
              x1={l.sx}
              x2={l.tx}
              y1={0}
              y2={0}
            >
              <stop offset="0%" stopColor={rgba(c1, 0.55)} />
              <stop offset="100%" stopColor={rgba(c2, 0.55)} />
            </linearGradient>
          );
        })}
      </defs>

      {geo.links.map((l, i) => {
        const hot = linkHot(l);
        const dim = focus !== null && !hot;
        return (
          <path
            key={`l${i}`}
            d={linkPath(l)}
            fill={`url(#flow-${gradientSeed}-${i})`}
            opacity={dim ? 0.1 : hover === i || hot ? 1 : 0.72}
            style={{ cursor: "pointer", transition: "opacity .2s" }}
            onClick={() => onFocus(l.to === "hub" ? l.from : l.to)}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        );
      })}

      {geo.incomes.map((n) => (
        <g
          key={n.id}
          opacity={nodeOpacity(n.id)}
          style={{ cursor: "pointer" }}
          onClick={() => onFocus(focus === n.id ? null : n.id)}
        >
          <rect x={n.x} y={n.y} width={NW} height={n.h} fill={linkColor(n.id)} />
          <text x={n.x - 12} y={n.y + n.h / 2 - 3} textAnchor="end" style={labelStyle}>
            {n.label}
          </text>
          <text x={n.x - 12} y={n.y + n.h / 2 + 13} textAnchor="end" style={mutedStyle}>
            {format(n.value)}
          </text>
        </g>
      ))}

      <g style={{ cursor: "pointer" }} onClick={() => onFocus(focus === "hub" ? null : "hub")}>
        <rect x={X_HUB} y={geo.hubY} width={NW} height={geo.hubH} fill={hubColor} />
        <text
          x={X_HUB + 7}
          y={geo.hubY - 12}
          textAnchor="middle"
          style={{ ...labelStyle, fontSize: 11.5, letterSpacing: ".06em" }}
        >
          {hubLabel}
        </text>
      </g>

      {geo.leaves.map((n) => (
        <g
          key={n.id}
          opacity={nodeOpacity(n.id)}
          style={{ cursor: "pointer" }}
          onClick={() => onFocus(focus === n.id ? null : n.id)}
        >
          <rect x={n.x} y={n.y} width={NW} height={n.h} fill={linkColor(n.id)} />
          <text x={n.x + 24} y={n.y + n.h / 2 + 4.5} textAnchor="start" style={labelStyle}>
            {n.label}
            <tspan dx={8} style={mutedStyle}>
              {format(n.value)}
            </tspan>
          </text>
        </g>
      ))}
    </svg>
  );
}
