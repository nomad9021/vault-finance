import { z } from "zod";

/**
 * The home screen's widgets: every card and section the dashboard can show,
 * in default order, with its default width (of 12 columns). The app draws
 * them; the assistant rearranges them by id; the server checks ids against
 * this list. Add a widget here and both pick it up.
 */
export type DashboardSpan = 3 | 4 | 6 | 8 | 12;

export interface DashboardWidgetDef {
  id: string;
  label: string;
  span: DashboardSpan;
  /** One line for the assistant: what the widget shows. */
  about: string;
}

export const DASHBOARD_WIDGETS: readonly DashboardWidgetDef[] = [
  { id: "metric-networth", label: "Net worth (number)", span: 3, about: "net worth figure" },
  { id: "metric-income", label: "Income this month (number)", span: 3, about: "this month's income figure" },
  { id: "metric-spending", label: "Spending this month (number)", span: 3, about: "this month's spending figure" },
  { id: "metric-savings", label: "Savings rate (number)", span: 3, about: "savings rate figure" },
  { id: "guilt-free", label: "Guilt-free spending", span: 12, about: "each person's weekly guilt-free money, resets every week" },
  { id: "sankey", label: "Cash-flow Sankey", span: 12, about: "the cash-flow diagram (actual, planned, both, or budget vs actual)" },
  { id: "this-month", label: "This month: plan vs actual", span: 8, about: "safe to spend and the month's plan vs actual" },
  { id: "accounts", label: "Accounts", span: 4, about: "account balances" },
  { id: "trend-networth", label: "Net worth trend", span: 4, about: "net worth chart" },
  { id: "trend-income", label: "Income trend", span: 4, about: "income chart" },
  { id: "trend-spending", label: "Spending trend", span: 4, about: "spending chart" },
  { id: "budgets", label: "Budgets", span: 4, about: "budget left and the categories closest to their limit" },
  { id: "bills", label: "Upcoming bills", span: 4, about: "next bills due" },
  { id: "investments", label: "Investments", span: 4, about: "portfolio value" },
  { id: "recent", label: "Recent activity", span: 8, about: "latest transactions" },
  { id: "goals", label: "Savings goals", span: 4, about: "progress on savings goals" },
];

export const DASHBOARD_WIDGET_IDS: ReadonlySet<string> = new Set(DASHBOARD_WIDGETS.map((w) => w.id));

/** Which cash-flow diagram the dashboard leads with. */
export const SankeyView = z.enum(["actual", "planned", "both", "combined"]);
export type SankeyView = z.infer<typeof SankeyView>;

/** Widths as the assistant names them. */
export const WIDGET_WIDTHS = { quarter: 3, third: 4, half: 6, "two-thirds": 8, full: 12 } as const satisfies Record<string, DashboardSpan>;
export type WidgetWidth = keyof typeof WIDGET_WIDTHS;

export interface ResolvedDashboardWidget {
  id: string;
  hidden: boolean;
  span: DashboardSpan;
}

/**
 * A saved layout over the defaults: saved widgets in their order (unknown ids
 * from older/newer versions dropped), then any widget never arranged, in
 * default order. Spans fall back to the widget's default.
 */
export function resolveWidgets(
  defaults: ReadonlyArray<{ id: string; span: DashboardSpan }>,
  saved: ReadonlyArray<{ id: string; hidden?: boolean | undefined; span?: number | undefined }> | undefined,
): ResolvedDashboardWidget[] {
  const byId = new Map(defaults.map((d) => [d.id, d]));
  const out: ResolvedDashboardWidget[] = [];
  const seen = new Set<string>();
  for (const w of saved ?? []) {
    const d = byId.get(w.id);
    if (!d || seen.has(w.id)) continue;
    seen.add(w.id);
    out.push({ id: w.id, hidden: w.hidden ?? false, span: (w.span as DashboardSpan | undefined) ?? d.span });
  }
  for (const d of defaults) if (!seen.has(d.id)) out.push({ id: d.id, hidden: false, span: d.span });
  return out;
}

export interface DashboardChange {
  reset?: boolean | undefined;
  order?: string[] | undefined;
  show?: string[] | undefined;
  hide?: string[] | undefined;
  widths?: Record<string, WidgetWidth> | undefined;
}

/** Ids in a change that aren't dashboard widgets. */
export function unknownWidgetIds(change: DashboardChange): string[] {
  const ids = [...(change.order ?? []), ...(change.show ?? []), ...(change.hide ?? []), ...Object.keys(change.widths ?? {})];
  return [...new Set(ids.filter((id) => !DASHBOARD_WIDGET_IDS.has(id)))];
}

/**
 * Apply a change to a saved layout. `order` puts the named widgets first, in
 * that order; the rest keep their order after them.
 */
export function applyDashboardChange(
  saved: ReadonlyArray<{ id: string; hidden?: boolean | undefined; span?: number | undefined }> | undefined,
  change: DashboardChange,
): ResolvedDashboardWidget[] {
  let layout = resolveWidgets(DASHBOARD_WIDGETS, change.reset ? [] : saved);
  if (change.order?.length) {
    const first = [...new Set(change.order)]
      .map((id) => layout.find((w) => w.id === id))
      .filter((w): w is ResolvedDashboardWidget => !!w);
    const firstIds = new Set(first.map((w) => w.id));
    layout = [...first, ...layout.filter((w) => !firstIds.has(w.id))];
  }
  const show = new Set(change.show ?? []);
  const hide = new Set(change.hide ?? []);
  return layout.map((w) => {
    const width = change.widths?.[w.id];
    return {
      ...w,
      hidden: show.has(w.id) ? false : hide.has(w.id) ? true : w.hidden,
      span: width ? WIDGET_WIDTHS[width] : w.span,
    };
  });
}
