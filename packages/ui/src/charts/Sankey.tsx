import { useMemo, useState } from "react";

/**
 * Interactive multi-level cash-flow Sankey. Columns come from each node's
 * `depth` (income sources 0 → total-income hub 1 → spending categories 2 →
 * subcategories 3, 4, …), so the diagram branches to any depth the server
 * sends. Node heights are value-proportional with one global scale; links are
 * routed with a barycenter ordering to keep crossings down. Click a node or
 * flow to focus it — the page around this component renders the drill-in panel.
 *
 * Interactions are click-based, never hover-only, so the same component serves
 * touch targets unchanged.
 */

export interface SankeyNodeDatum {
  id: string;
  label: string;
  value: number;
  color: string;
  /** Column index: income=0, hub=1, top categories=2, subcategories 3+. */
  depth: number;
  kind: "income" | "hub" | "category" | "saved";
}

export interface SankeyLinkDatum {
  from: string;
  to: string;
  value: number;
}

export interface SankeyProps {
  nodes: SankeyNodeDatum[];
  links: SankeyLinkDatum[];
  /** Value formatter for node captions. */
  format: (value: number) => string;
  focus: string | null;
  onFocus: (id: string | null) => void;
  /** Tint links by category color; hub-grey otherwise. */
  colorful?: boolean;
  hubColor?: string;
  ariaLabel?: string;
}

// The viewBox height is computed per-render (see layout): the diagram grows to
// fit its tallest column so nothing is clipped, using BASE_H as a floor.
const BASE_H = 600;
const W = 1240;
const NW = 6;
const PAD = 40;
const X0 = 64; // x of the leftmost (depth 0) column bar
const X1 = 1176; // x of the rightmost column bar (labels sit to its left)
const GAP = 14; // vertical gap between node slots
const MIN_NODE = 4; // min bar height (thin sliver for tiny/$0 nodes)
const ROW_MIN = 34; // min slot height so a two-line label always fits without overlap
const MIN_LINK = 2; // hairline connector for $0 links so empty categories stay attached

interface PlacedNode extends SankeyNodeDatum {
  x: number;
  y: number;
  h: number;
}

interface PlacedLink {
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

function linkPath(l: PlacedLink): string {
  const mx = (l.sx + l.tx) / 2;
  return `M${l.sx},${l.sy} C${mx},${l.sy} ${mx},${l.ty} ${l.tx},${l.ty} L${l.tx},${l.ty + l.t} C${mx},${l.ty + l.t} ${mx},${l.sy + l.t} ${l.sx},${l.sy + l.t} Z`;
}

function layout(nodes: SankeyNodeDatum[], links: SankeyLinkDatum[]) {
  const depths = [...new Set(nodes.map((n) => n.depth))].sort((a, b) => a - b);
  const maxDepth = depths[depths.length - 1] ?? 0;
  const xFor = (d: number) => (maxDepth === 0 ? X0 : X0 + (d * (X1 - X0)) / maxDepth);

  // A node's drawn magnitude is the largest of its value and its total in/out
  // flow, so a bar never renders shorter than the flows attached to it.
  const sumIn = new Map<string, number>();
  const sumOut = new Map<string, number>();
  for (const l of links) {
    sumOut.set(l.from, (sumOut.get(l.from) ?? 0) + l.value);
    sumIn.set(l.to, (sumIn.get(l.to) ?? 0) + l.value);
  }
  const magnitude = (n: SankeyNodeDatum) =>
    Math.max(n.value, sumIn.get(n.id) ?? 0, sumOut.get(n.id) ?? 0);

  const byDepth = new Map<number, SankeyNodeDatum[]>();
  for (const n of nodes) {
    const arr = byDepth.get(n.depth) ?? [];
    arr.push(n);
    byDepth.set(n.depth, arr);
  }

  let maxColSum = 1;
  for (const ns of byDepth.values()) {
    maxColSum = Math.max(maxColSum, ns.reduce((s, n) => s + magnitude(n), 0));
  }
  const scale = (BASE_H - 2 * PAD) / maxColSum;

  // Each node occupies a slot at least ROW_MIN tall so its two-line label always
  // has room — the value-proportional bar is centered inside that slot. Grow the
  // viewBox so the tallest column always fits instead of clipping top/bottom.
  const barHeight = (n: SankeyNodeDatum) => Math.max(MIN_NODE, magnitude(n) * scale);
  const slotHeight = (n: SankeyNodeDatum) => Math.max(ROW_MIN, barHeight(n));
  const columnHeight = (ns: SankeyNodeDatum[]) =>
    ns.reduce((s, n) => s + slotHeight(n), 0) + Math.max(0, ns.length - 1) * GAP;
  let contentH = 0;
  for (const ns of byDepth.values()) contentH = Math.max(contentH, columnHeight(ns));
  const H = Math.max(BASE_H, Math.ceil(contentH + 2 * PAD));

  const placed = new Map<string, PlacedNode>();
  const parentsOf = new Map<string, string[]>();
  for (const l of links) {
    const arr = parentsOf.get(l.to) ?? [];
    arr.push(l.from);
    parentsOf.set(l.to, arr);
  }

  for (const d of depths) {
    const ns = [...(byDepth.get(d) ?? [])];
    // Order each column: leftmost by value; deeper columns by the average y of
    // their already-placed parents (barycenter heuristic) to reduce crossings.
    if (d === depths[0]) {
      ns.sort((a, b) => magnitude(b) - magnitude(a));
    } else {
      const bary = (n: SankeyNodeDatum) => {
        const ps = (parentsOf.get(n.id) ?? [])
          .map((id) => placed.get(id))
          .filter((p): p is PlacedNode => !!p);
        if (ps.length === 0) return Number.MAX_SAFE_INTEGER;
        return ps.reduce((s, p) => s + (p.y + p.h / 2), 0) / ps.length;
      };
      ns.sort((a, b) => bary(a) - bary(b));
    }

    const totalH = columnHeight(ns);
    let y = (H - totalH) / 2;
    for (const n of ns) {
      const slot = slotHeight(n);
      const h = barHeight(n);
      // Center the bar within its (possibly taller) label slot.
      placed.set(n.id, { ...n, x: xFor(d), y: y + (slot - h) / 2, h });
      y += slot + GAP;
    }
  }

  // Route links: each source stacks its outgoing flows by target position,
  // each target stacks its incoming flows by source position. Sorting by
  // (source y, target y) yields both from a single pass of cursors.
  const outCursor = new Map<string, number>();
  const inCursor = new Map<string, number>();
  const ordered = [...links].sort((a, b) => {
    const sa = placed.get(a.from)?.y ?? 0;
    const sb = placed.get(b.from)?.y ?? 0;
    if (sa !== sb) return sa - sb;
    return (placed.get(a.to)?.y ?? 0) - (placed.get(b.to)?.y ?? 0);
  });
  const placedLinks: PlacedLink[] = [];
  for (const l of ordered) {
    const s = placed.get(l.from);
    const t = placed.get(l.to);
    if (!s || !t) continue;
    // Empty ($0) categories still get a hairline connector so the link between
    // the hub and the zero-value node is visible.
    const h = l.value > 0 ? l.value * scale : MIN_LINK;
    const sy = outCursor.get(l.from) ?? s.y;
    const ty = inCursor.get(l.to) ?? t.y;
    placedLinks.push({ from: l.from, to: l.to, sx: s.x + NW, sy, tx: t.x, ty, t: h });
    outCursor.set(l.from, sy + h);
    inCursor.set(l.to, ty + h);
  }

  return { nodes: [...placed.values()], links: placedLinks, maxDepth, height: H };
}

export function Sankey({
  nodes,
  links,
  format,
  focus,
  onFocus,
  colorful = true,
  hubColor = "#9397ab",
  ariaLabel = "Cash flow diagram",
}: SankeyProps) {
  const [hover, setHover] = useState<number | null>(null);
  const geo = useMemo(() => layout(nodes, links), [nodes, links]);
  const gradientSeed = useMemo(() => Math.random().toString(36).slice(2, 8), []);

  const colorById = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of nodes) map.set(n.id, n.color);
    return map;
  }, [nodes]);

  // Percentages read as each node's share of total income (the hub = 100%),
  // falling back to the summed income sources if there is no hub node.
  const rootTotal = useMemo(() => {
    const hub = nodes.find((n) => n.kind === "hub");
    if (hub && hub.value > 0) return hub.value;
    const incomeSum = nodes.filter((n) => n.depth === 0).reduce((s, n) => s + n.value, 0);
    return incomeSum > 0 ? incomeSum : nodes.reduce((m, n) => Math.max(m, n.value), 0);
  }, [nodes]);

  // A flow is tinted by the more specific (deeper) of its two endpoints.
  const depthById = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of nodes) map.set(n.id, n.depth);
    return map;
  }, [nodes]);
  const flowKey = (l: PlacedLink) =>
    (depthById.get(l.to) ?? 0) >= (depthById.get(l.from) ?? 0) ? l.to : l.from;
  const linkColor = (id: string) => (colorful ? (colorById.get(id) ?? hubColor) : hubColor);

  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      const s = map.get(a) ?? new Set<string>();
      s.add(b);
      map.set(a, s);
    };
    for (const l of links) {
      add(l.from, l.to);
      add(l.to, l.from);
    }
    return map;
  }, [links]);

  const linkHot = (l: PlacedLink) => focus !== null && (l.from === focus || l.to === focus);
  const nodeOpacity = (id: string) =>
    focus && focus !== id && !(neighbors.get(focus)?.has(id) ?? false) ? 0.3 : 1;

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
      viewBox={`0 0 ${W} ${geo.height}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        {geo.links.map((l, i) => {
          const key = flowKey(l);
          const c1 = l.from === key ? linkColor(key) : hubColor;
          const c2 = l.to === key ? linkColor(key) : hubColor;
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
            onClick={() => onFocus(flowKey(l))}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        );
      })}

      {geo.nodes.map((n) => {
        // Income sources (leftmost) and the hub label to the RIGHT of their bar;
        // every spending node labels to the LEFT so the deepest column's captions
        // grow inward and never run off the right edge.
        const right = n.depth === 0 || n.kind === "hub";
        const anchor = right ? "start" : "end";
        const lx = right ? n.x + NW + 10 : n.x - 10;
        const cy = n.y + n.h / 2;
        const pct = rootTotal > 0 ? (n.value / rootTotal) * 100 : 0;
        const caption = rootTotal > 0 ? `${format(n.value)} (${pct.toFixed(1)}%)` : format(n.value);
        return (
          <g
            key={n.id}
            opacity={nodeOpacity(n.id)}
            style={{ cursor: "pointer" }}
            onClick={() => onFocus(focus === n.id ? null : n.id)}
          >
            <rect x={n.x} y={n.y} width={NW} height={n.h} rx={1.5} fill={linkColor(n.id)} />
            <text x={lx} y={cy - 3} textAnchor={anchor} style={labelStyle}>
              {n.label}
            </text>
            <text x={lx} y={cy + 12} textAnchor={anchor} style={mutedStyle}>
              {caption}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
