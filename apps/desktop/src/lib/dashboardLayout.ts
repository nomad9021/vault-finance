import type { DashboardWidget } from "@vault/shared";

export type Span = 3 | 4 | 6 | 8 | 12;
export const SPANS: ReadonlyArray<{ value: Span; label: string }> = [
  { value: 3, label: "¼ width" },
  { value: 4, label: "⅓ width" },
  { value: 6, label: "½ width" },
  { value: 8, label: "⅔ width" },
  { value: 12, label: "Full width" },
];

export interface ResolvedWidget {
  id: string;
  hidden: boolean;
  span: Span;
}

/**
 * The person's saved dashboard layout over the default one: saved widgets in
 * their order (unknown ids from older/newer versions dropped), then any
 * widget they've never arranged, in default order. Spans fall back to the
 * widget's default.
 */
export function resolveLayout(defaults: ReadonlyArray<{ id: string; span: Span }>, saved: DashboardWidget[] | undefined): ResolvedWidget[] {
  const byId = new Map(defaults.map((d) => [d.id, d]));
  const out: ResolvedWidget[] = [];
  const seen = new Set<string>();
  for (const w of saved ?? []) {
    const d = byId.get(w.id);
    if (!d || seen.has(w.id)) continue;
    seen.add(w.id);
    out.push({ id: w.id, hidden: w.hidden ?? false, span: (w.span as Span | undefined) ?? d.span });
  }
  for (const d of defaults) if (!seen.has(d.id)) out.push({ id: d.id, hidden: false, span: d.span });
  return out;
}

/** Move one widget up or down by one place. */
export function moveWidget(layout: ResolvedWidget[], id: string, by: -1 | 1): ResolvedWidget[] {
  const i = layout.findIndex((w) => w.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= layout.length) return layout;
  const next = [...layout];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Drag and drop: put `id` where `beforeId` is. */
export function placeWidget(layout: ResolvedWidget[], id: string, beforeId: string): ResolvedWidget[] {
  if (id === beforeId) return layout;
  const item = layout.find((w) => w.id === id);
  if (!item) return layout;
  const rest = layout.filter((w) => w.id !== id);
  const at = rest.findIndex((w) => w.id === beforeId);
  if (at < 0) return layout;
  return [...rest.slice(0, at), item, ...rest.slice(at)];
}
