import {
  DASHBOARD_WIDGETS,
  formatCentsWhole,
  type Account,
  type Bill,
  type BudgetListResponse,
  type Goal,
  type PreIncome,
  type SankeyResponse,
  type Transaction,
  type UserPreferences,
} from "@vault/shared";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Icon,
  ListRow,
  MetricCard,
  Money,
  Panel,
  PanelLink,
  ProgressBar,
  Segmented,
  Sheet,
  Skeleton,
} from "@vault/ui";
import { useEffect, useState, type ReactNode } from "react";
import { availableCents, shownBalance, useShowActualBalances } from "../../lib/balanceView.js";
import { resolveLayout, SPANS, type ResolvedWidget, type Span } from "../../lib/dashboardLayout.js";
import { useHomeArrange } from "../../lib/homeArrange.js";
import { useData } from "../../lib/useData.js";
import { useCountUp } from "../../lib/useCountUp.js";
import { useLayoutMode } from "../../lib/useLayout.js";
import { periodFigures } from "../../lib/budgetPeriod.js";
import { useApp } from "../../state/store.js";
import { buildBudgetSankey, buildBudgetVsActual, preIncomeBranches, withGrossBranch, withTaxBranch } from "./budgetSankey.js";
import type { Navigate, PageId } from "./nav.js";
import { PreIncomeDialog } from "./PreIncomeDialog.js";
import { GuiltFreeCard } from "./GuiltFreeCard.js";
import { SankeyCard } from "./SankeyCard.js";
import { TrendChart, project } from "./TrendChart.js";

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

/**
 * Which month the dashboard opens on.
 *
 * Month-to-date framing makes the app look broken for the first days of every
 * month: on the 2nd there is almost nothing to draw, so the flagship diagram
 * is empty and income/spending both read $0 next to a healthy net worth. So if
 * the current month has no activity yet, fall back to the most recent month
 * that does — always labelled, and steppable, so it never silently lies about
 * which month you're looking at.
 *
 * Derived from the trends data the dashboard already loads: no extra request.
 */
function defaultMonth(
  points: { month: string; incomeCents: number; spendingCents: number }[],
): string {
  const now = currentMonth();
  const current = points.find((p) => p.month === now);
  if (!current || current.incomeCents > 0 || current.spendingCents > 0) return now;
  const withActivity = points
    .filter((p) => p.incomeCents > 0 || p.spendingCents > 0)
    .map((p) => p.month)
    .sort();
  return withActivity[withActivity.length - 1] ?? now;
}
function monthLong(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "long", timeZone: "UTC" });
}
function monthYear(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
}

function monthShort(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
}
function dueLabel(days: number): { text: string; tone: "over" | "soon" | "ok" } {
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, tone: "over" };
  if (days === 0) return { text: "Due today", tone: "over" };
  if (days === 1) return { text: "Due tomorrow", tone: "soon" };
  return { text: `Due in ${days} days`, tone: days <= 7 ? "soon" : "ok" };
}
/**
 * The dashboard can lead with what actually happened, what you planned, or
 * both side by side — the last being the interesting one, since the gap
 * between the two diagrams *is* the story.
 */
type SankeyView = "actual" | "planned" | "both" | "combined";
const SANKEY_VIEW_KEY = "dashboard-sankey-view";
const SANKEY_VIEWS = [
  { value: "actual" as const, label: "Actual" },
  { value: "planned" as const, label: "Planned" },
  { value: "both" as const, label: "Both" },
  { value: "combined" as const, label: "Budget vs actual" },
];
const FROM_GROSS_KEY = "vault.dashboard.from-gross";
function loadFromGross(): boolean {
  try {
    return localStorage.getItem(FROM_GROSS_KEY) !== "off";
  } catch {
    return true;
  }
}

function loadSankeyView(): SankeyView {
  try {
    const v = localStorage.getItem(SANKEY_VIEW_KEY);
    if (v === "actual" || v === "planned" || v === "both" || v === "combined") return v;
  } catch {
    /* ignore */
  }
  return "actual";
}

const toneColor = (tone: "over" | "soon" | "ok") =>
  tone === "over"
    ? "var(--color-negative)"
    : tone === "soon"
      ? "var(--color-warning)"
      : "var(--content-tertiary)";

export function DashboardPage({ onNavigate }: { onNavigate: Navigate }) {
  const client = useApp((s) => s.client);
  const phone = useLayoutMode() === "narrow";
  const weekStart = useApp((s) => s.reviewPrefs.weekStartsOn);
  // Settings → General → Home screen can hide the cash-flow diagram (per device).
  const hideSankey = useApp((s) => !s.showSankey);

  // Trends come first: they carry six months of income/spending, which is
  // enough to choose a sensible default month without another request.
  const { data: trendData } = useData(() => client.trends(6), [client]);
  const [pickedMonth, setPickedMonth] = useState<string | null>(null);
  const month = pickedMonth ?? defaultMonth(trendData?.points ?? []);
  const isCurrentMonth = month === currentMonth();

  const { data: accountData, reload: reloadAccounts } = useData(() => client.accounts(), [client]);
  const { data: sankeyData, loading, reload: reloadSankey } = useData<SankeyResponse>(
    () => client.sankey(month),
    [client, month],
  );
  const { data: txnData, reload: reloadTxns } = useData(
    () => client.transactions({ limit: 6 }),
    [client],
  );
  const { data: goalData } = useData(() => client.goals(), [client]);
  const { data: budgetData } = useData(() => client.budgets(month, weekStart), [client, month, weekStart]);
  const { data: categoryData } = useData(() => client.categories(), [client]);
  const { data: billData } = useData(() => client.bills(), [client]);
  const { data: investData } = useData(() => client.investments(), [client]);
  const { data: planData } = useData(() => client.budgetPlan(), [client]);
  // The person's own arrangement, saved to their account (follows them to every device).
  const { data: savedPrefs } = useData(() => client.preferences().catch(() => ({})), [client]);
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  useEffect(() => {
    if (savedPrefs) setPrefs(savedPrefs as UserPreferences);
  }, [savedPrefs]);
  const [editing, setEditing] = useState(false);
  const saveLayout = (next: ResolvedWidget[] | null) => {
    const dashboard = next ? next.map(({ id, hidden, span }) => ({ id, hidden, span })) : [];
    setPrefs((p) => ({ ...(p ?? {}), dashboard }));
    void client.savePreferences({ dashboard }).catch(() => {});
  };
  // Before income: the tax profile's estimate and/or the user's own taxes and
  // deductions let both diagrams start from gross pay.
  const { data: taxData } = useData(() => client.taxProfile(), [client]);
  const taxEstimate = taxData?.estimate ?? null;
  const { data: preIncome, reload: reloadPreIncome } = useData<PreIncome>(
    () => client.preIncome().catch(() => ({ items: [], useEstimate: true })),
    [client],
  );
  const [editingPreIncome, setEditingPreIncome] = useState(false);
  const [fromGross, setFromGross] = useState(loadFromGross);
  const toggleGross = (on: boolean) => {
    setFromGross(on);
    try {
      localStorage.setItem(FROM_GROSS_KEY, on ? "on" : "off");
    } catch {
      /* per-device convenience only */
    }
  };

  // Which cash-flow diagram the dashboard leads with. Saved to the account
  // (so the assistant can set it too), with this device's old choice as the
  // fallback until one is saved.
  const sankeyView: SankeyView = prefs?.sankeyView ?? loadSankeyView();
  const setSankeyView = (v: SankeyView) => {
    setPrefs((p) => ({ ...(p ?? {}), sankeyView: v }));
    void client.savePreferences({ sankeyView: v }).catch(() => {});
    try {
      localStorage.setItem(SANKEY_VIEW_KEY, v);
    } catch {
      /* per-device fallback only */
    }
  };

  // Poll so bank auto-sync / webhook imports show up live without a manual
  // refresh. The skeleton only appears when there's no data yet, so this is
  // invisible once loaded.
  useEffect(() => {
    const id = setInterval(() => {
      reloadSankey();
      reloadAccounts();
      reloadTxns();
    }, 90_000);
    return () => clearInterval(id);
  }, [reloadSankey, reloadAccounts, reloadTxns]);

  const accounts = accountData?.accounts ?? [];
  const netWorth = accounts.reduce((sum, a) => sum + a.balanceCents, 0);
  const income = sankeyData?.totalIncomeCents ?? 0;
  const spending = sankeyData?.totalSpendingCents ?? 0;
  const savingsRate = income > 0 ? Math.round(((income - spending) / income) * 100) : null;
  const hasData = (sankeyData?.links.length ?? 0) > 0;
  const goals = goalData?.goals ?? [];
  const recent = txnData?.transactions ?? [];
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const categories = categoryData?.categories ?? [];
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const points = trendData?.points ?? [];

  // The planned diagram, built from the same category tree and allocations the
  // Budgets planner uses, so the two are always the same picture.
  const plannedIncome = planData?.plannedIncomeCents ?? 0;
  const planBase = buildBudgetSankey(
    plannedIncome,
    categories.filter((c) => c.kind === "expense"),
    new Map((budgetData?.budgets ?? []).map((b) => [b.categoryId, b.amountCents])),
  );
  const branches = preIncomeBranches(taxEstimate, preIncome);
  const gross = fromGross && branches.length > 0;
  const planSankey = { ...planBase, ...(gross && plannedIncome > 0 ? withTaxBranch(planBase, branches) : planBase) };
  const actualSankey = sankeyData ? (gross ? withGrossBranch(sankeyData, branches) : sankeyData) : null;
  const hasPlan = plannedIncome > 0 || planSankey.allocated > 0;
  const budgetVsActual = buildBudgetVsActual(budgetData ?? { budgets: [] }, categories);

  // Don't offer a view there's no data for — and fall back rather than render
  // an empty card if the remembered choice is currently unavailable.
  const availableViews = SANKEY_VIEWS.filter(
    (v) => (v.value === "actual" && hasData) || (v.value === "planned" && hasPlan) || (v.value === "both" && hasData && hasPlan) || (v.value === "combined" && budgetVsActual.rows.length > 0),
  );
  const effectiveView: SankeyView = availableViews.some((v) => v.value === sankeyView)
    ? sankeyView
    : (availableViews[0]?.value ?? "actual");

  // Every card and section is a widget the person can move, hide or resize
  // (Customize); their layout is saved to their account on the server.
  const nodes: Record<string, ReactNode> = {
    "metric-networth": (<MetricCard
            label="Net worth"
            icon="bank"
            value={formatCentsWhole(netWorth)}
            hint="Across all accounts"
            onClick={() => onNavigate("accounts")}
          />),
    "metric-income": (<MetricCard
            label={`Income · ${monthLong(month)}`}
            icon="income"
            value={formatCentsWhole(income)}
            onClick={() => onNavigate("income")}
          />),
    "metric-spending": (<MetricCard
            label={`Spending · ${monthLong(month)}`}
            icon="card"
            value={formatCentsWhole(spending)}
            onClick={() => onNavigate("reports")}
          />),
    "metric-savings": (<MetricCard
            label="Savings rate"
            icon="target"
            value={savingsRate !== null ? `${savingsRate}%` : "—"}
            deltaTone={savingsRate !== null && savingsRate >= 0 ? "up" : "down"}
            hint="of income kept"
          />),
    sankey: ((loading && !sankeyData ? (
        <Panel>
          <Skeleton height={360} />
        </Panel>
      ) : hasData || hasPlan ? (
        <div className="stack">
          <div className="row-between wrap">
            <div className="row" style={{ gap: "var(--space-1)" }}>
              <Button
                variant="ghost"
                size="sm"
                icon="chevronLeft"
                aria-label="Previous month"
                onClick={() => setPickedMonth(shiftMonth(month, -1))}
              />
              <span className="eyebrow" style={{ minWidth: 108, textAlign: "center" }}>
                {monthLong(month)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                icon="chevronRight"
                aria-label="Next month"
                disabled={month >= currentMonth()}
                onClick={() => setPickedMonth(shiftMonth(month, 1))}
              />
              {/* Says plainly why you're not looking at the current month. */}
              {!isCurrentMonth && (
                <button className="panel-link" onClick={() => setPickedMonth(currentMonth())}>
                  {monthLong(currentMonth())} has no activity yet — jump to it
                </button>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              {branches.length > 0 && (
                <label className="radio" style={{ fontSize: "var(--text-sm)" }} title="Show taxes and deductions coming off gross pay before income">
                  <input type="checkbox" checked={fromGross} onChange={(e) => toggleGross(e.target.checked)} />
                  <span className="dot" style={{ borderRadius: "var(--radius-sm)" }} />
                  From gross pay
                </label>
              )}
              <Button variant="ghost" size="sm" icon="edit" disabled={!preIncome} onClick={() => setEditingPreIncome(true)}>
                Before income
              </Button>
              <Segmented
                options={availableViews}
                value={effectiveView}
                onChange={setSankeyView}
                aria-label="Which cash-flow diagram to show"
              />
            </div>
          </div>

          {effectiveView === "both" ? (
            <div className="grid">
              <div className="col-6">
                <SankeyCard
                  compact
                  title="Actual"
                  nodes={actualSankey!.nodes}
                  links={actualSankey!.links}
                  month={sankeyData!.month}
                  onNavigate={onNavigate}
                  onChanged={reloadSankey}
                />
              </div>
              <div className="col-6">
                <SankeyCard
                  compact
                  title="Planned"
                  nodes={planSankey.nodes}
                  links={planSankey.links}
                  month={month}
                  onNavigate={onNavigate}
                />
              </div>
            </div>
          ) : effectiveView === "combined" ? (
            <SankeyCard
              editable
              singlePeriod
              title="Budget vs actual"
              hint="Budget flows in on the left, spending out on the right"
              nodes={budgetVsActual.nodes}
              links={budgetVsActual.links}
              month={month}
              onNavigate={onNavigate}
            />
          ) : effectiveView === "planned" ? (
            <SankeyCard
              editable
              title="Budget plan"
              hint="Click a category to see this month's actual spending"
              nodes={planSankey.nodes}
              links={planSankey.links}
              month={month}
              onNavigate={onNavigate}
            />
          ) : (
            <SankeyCard
              editable
              nodes={actualSankey!.nodes}
              links={actualSankey!.links}
              month={sankeyData!.month}
              onNavigate={onNavigate}
              onChanged={reloadSankey}
            />
          )}
        </div>
      ) : (
        <GetStarted onNavigate={onNavigate} hasAccounts={accounts.length > 0} />
      ))),
    "this-month": (<ThisMonth
            month={month}
            isCurrentMonth={isCurrentMonth}
            plannedIncomeCents={plannedIncome}
            incomeCents={income}
            budgetedCents={budgetData?.totalBudgetedCents ?? 0}
            spentCents={budgetData?.totalSpentCents ?? spending}
            budgets={budgetData}
            categories={categories}
            bills={billData?.bills ?? []}
            onNavigate={onNavigate}
          />),
    accounts: (<AccountsCard accounts={accounts} onViewAll={() => onNavigate("accounts")} />),
    "trend-networth": (<TrendCard
            label="Net worth"
            points={points}
            pick={(p) => p.netWorthCents}
            color="var(--viz-2)"
            goodWhenUp
            onViewAll={() => onNavigate("accounts")}
          />),
    "trend-income": (<TrendCard
            label="Income"
            points={points}
            pick={(p) => p.incomeCents}
            color="var(--viz-3)"
            goodWhenUp
            onViewAll={() => onNavigate("income")}
          />),
    "trend-spending": (<TrendCard
            label="Spending"
            points={points}
            pick={(p) => p.spendingCents}
            color="var(--viz-1)"
            goodWhenUp={false}
            onViewAll={() => onNavigate("reports")}
          />),
    budgets: (<BudgetOverview
            data={budgetData}
            month={month}
            isCurrentMonth={isCurrentMonth}
            categoryById={categoryById}
            onViewAll={() => onNavigate("budgets")}
          />),
    bills: (<UpcomingBills bills={billData?.bills ?? []} onViewAll={() => onNavigate("bills")} />),
    investments: (<InvestmentsCard data={investData} onViewAll={() => onNavigate("investments")} />),
    recent: (<RecentActivity
            transactions={recent}
            accountName={(id) => accountById.get(id)?.name ?? "—"}
            onViewAll={() => onNavigate("transactions")}
          />),
    goals: (<TopGoals goals={goals} onViewAll={() => onNavigate("goals")} />),
    "guilt-free": <GuiltFreeCard />,
  };
  // Phone: one compact summary stands in for the four number cards.
  const phoneSummary = (
    <PhoneSummary
      month={month}
      points={points}
      netWorthCents={netWorth}
      incomeCents={income}
      spendingCents={spending}
      savingsRate={savingsRate}
      onNavigate={onNavigate}
    />
  );
  const defaults = DASHBOARD_WIDGETS.map((w) => ({ id: w.id, span: w.span }));
  // Until the person arranges it, a phone leads with the week's guilt-free
  // money, budgets and goals; once they do, their order wins everywhere.
  const PHONE_FIRST = ["guilt-free", "budgets", "goals"];
  const customized = (prefs?.dashboard?.length ?? 0) > 0;
  const layout = resolveLayout(
    phone && !customized
      ? [...PHONE_FIRST.flatMap((id) => defaults.filter((d) => d.id === id)), ...defaults.filter((d) => !PHONE_FIRST.includes(d.id))]
      : defaults,
    prefs?.dashboard,
  );
  const labels = Object.fromEntries(DASHBOARD_WIDGETS.map((w) => [w.id, w.label]));
  const shown = layout.filter((w) => !w.hidden && !(hideSankey && w.id === "sankey"));
  // On a phone the summary takes the place of the first number card shown,
  // and carries the net worth chart, so the net worth trend card stays out.
  const anyMetric = shown.some((w) => w.id.startsWith("metric-"));
  const firstMetric = shown.find((w) => w.id.startsWith("metric-"))?.id;
  const viewItems = phone
    ? shown.filter((w) => !(w.id.startsWith("metric-") && w.id !== firstMetric) && !(anyMetric && w.id === "trend-networth"))
    : shown;

  const setWidget = (id: string, patch: Partial<ResolvedWidget>) => saveLayout(layout.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const hidden = layout.filter((w) => w.hidden);
  const editItems = layout.filter((w) => !w.hidden);
  const items = editing ? editItems : viewItems;
  const arrange = useHomeArrange({
    ids: items.map((w) => w.id),
    editing,
    onStartEditing: () => setEditing(true),
    // The visible cards in their new order; hidden ones keep their place after.
    onCommit: (ids) => saveLayout([...ids.map((id) => layout.find((w) => w.id === id)!).filter(Boolean), ...hidden]),
  });
  const byId = new Map(items.map((w) => [w.id, w]));
  const nextSpan = (span: Span) => SPANS[(SPANS.findIndex((sp) => sp.value === span) + 1) % SPANS.length]!.value;
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="page">
      {editing ? (
        <div className="home-edit-bar" role="toolbar" aria-label="Editing your home screen">
          <Button variant="secondary" size="sm" icon="plus" aria-label="Add a card" onClick={() => setAddOpen(true)}>
            {phone ? "" : "Add card"}
          </Button>
          <span className="home-edit-hint t-xs t-tertiary">
            Drag cards to move them{phone ? "" : ", tap the size to resize"}
          </span>
          <Button variant="primary" size="sm" onClick={() => setEditing(false)}>
            Done
          </Button>
        </div>
      ) : (
        <div className="row-between wrap" style={{ marginBottom: -8 }}>
          <span className="t-xs t-tertiary">{phone ? "" : "Tip: hold a card to rearrange"}</span>
          <Button variant="ghost" size="sm" icon="edit" onClick={() => setEditing(true)}>
            Edit home screen
          </Button>
        </div>
      )}
      <div
        className="grid home-grid"
        data-editing={editing ? "true" : undefined}
        onClick={(e) => {
          // Tapping empty space finishes editing, like the iPhone.
          if (editing && e.target === e.currentTarget) setEditing(false);
        }}
      >
        {arrange.order.map((id, i) => {
          const w = byId.get(id);
          if (!w) return null;
          const label = labels[w.id] ?? w.id;
          return (
            <div
              key={w.id}
              className={`col-${phone ? 12 : w.span} home-card`}
              data-editing={editing ? "true" : undefined}
              tabIndex={editing ? 0 : undefined}
              aria-label={editing ? `${label}. Arrow keys move it.` : undefined}
              {...arrange.bind(w.id, i)}
            >
              {editing ? (
                <>
                  <button
                    type="button"
                    className="home-card-remove"
                    data-no-drag
                    aria-label={`Hide ${label}`}
                    title={`Hide ${label}`}
                    onClick={() => setWidget(w.id, { hidden: true })}
                  >
                    <span aria-hidden="true" />
                  </button>
                  <div className="home-card-body" inert>
                    {nodes[w.id]}
                  </div>
                  {!phone && (
                    <button
                      type="button"
                      className="home-card-size"
                      data-no-drag
                      title="Change the width"
                      aria-label={`Width of ${label}: ${SPANS.find((sp) => sp.value === w.span)?.label}. Change it.`}
                      onClick={() => setWidget(w.id, { span: nextSpan(w.span) })}
                    >
                      {SPANS.find((sp) => sp.value === w.span)?.label}
                    </button>
                  )}
                </>
              ) : phone && w.id === firstMetric ? (
                phoneSummary
              ) : (
                nodes[w.id]
              )}
            </div>
          );
        })}
      </div>
      {(() => {
        const AddPanel = phone ? Sheet : Dialog;
        return (
          <AddPanel open={addOpen} title="Add a card" onClose={() => setAddOpen(false)}>
        <div className="stack">
          {hidden.length === 0 ? (
            <p className="t-sm t-tertiary">Every card is already on your home screen.</p>
          ) : (
            hidden.map((w) => (
              <ListRow
                key={w.id}
                title={labels[w.id] ?? w.id}
                onClick={() => {
                  setWidget(w.id, { hidden: false });
                  if (hidden.length === 1) setAddOpen(false);
                }}
                trailing={<Icon name="plus" size={16} />}
                chevron={false}
              />
            ))
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              saveLayout(null);
              setAddOpen(false);
            }}
          >
            Reset to the standard layout
          </Button>
        </div>
          </AddPanel>
        );
      })()}
      {editingPreIncome && preIncome && (
        <PreIncomeDialog
          value={preIncome}
          hasEstimate={!!taxEstimate}
          onClose={() => setEditingPreIncome(false)}
          onSaved={() => {
            setEditingPreIncome(false);
            toggleGross(true);
            reloadPreIncome();
          }}
        />
      )}
    </div>
  );
}

function daysLeftInMonth(): number {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return end.getUTCDate() - now.getUTCDate() + 1;
}

/** Categories that are saving rather than spending (and everything inside them). */
const SAVINGS_NAME = /saving|invest|retire|401\s?k|\bira\b|emergency fund|sinking fund|brokerage/i;

/**
 * What's safe to spend: what's left in this month's budgets, not counting the
 * budgets for bills (they're set aside automatically) or savings. Spending in
 * a budget past its limit eats into the rest.
 */
export function safeToSpend(
  budgets: BudgetListResponse | null,
  categories: Array<{ id: string; name: string; parentCategoryId: string | null }>,
  bills: Array<{ categoryId: string | null }>,
): { leftCents: number; budgetedCents: number; spentCents: number; excluded: number } {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const roots = new Set<string>([
    ...bills.map((b) => b.categoryId).filter((x): x is string => !!x),
    ...categories.filter((c) => SAVINGS_NAME.test(c.name)).map((c) => c.id),
  ]);
  const excludedCat = (id: string) => {
    for (let cur = byId.get(id), n = 0; cur && n < 50; cur = cur.parentCategoryId ? byId.get(cur.parentCategoryId) : undefined, n++) {
      if (roots.has(cur.id)) return true;
    }
    return roots.has(id);
  };
  let budgetedCents = 0;
  let spentCents = 0;
  let excluded = 0;
  for (const b of budgets?.budgets ?? []) {
    if (excludedCat(b.categoryId)) {
      excluded++;
      continue;
    }
    budgetedCents += b.amountCents;
    spentCents += b.spentCents;
  }
  return { leftCents: budgetedCents - spentCents, budgetedCents, spentCents, excluded };
}

/**
 * Where the plan meets the bank: the month's plan next to what actually
 * happened, and what's safe to spend — what's left in the spending budgets.
 */
function ThisMonth({
  month,
  isCurrentMonth,
  plannedIncomeCents,
  incomeCents,
  budgetedCents,
  spentCents,
  budgets,
  categories,
  bills,
  onNavigate,
}: {
  month: string;
  isCurrentMonth: boolean;
  plannedIncomeCents: number;
  incomeCents: number;
  budgetedCents: number;
  spentCents: number;
  budgets: BudgetListResponse | null;
  categories: Array<{ id: string; name: string; parentCategoryId: string | null }>;
  bills: Bill[];
  onNavigate: Navigate;
}) {
  const daysLeft = daysLeftInMonth();
  const safe = safeToSpend(budgets, categories, bills);
  const perDay = isCurrentMonth && safe.leftCents > 0 ? Math.floor(safe.leftCents / daysLeft) : null;

  const rows: { label: string; planned: number; actual: number; goodWhenOver: boolean; page: PageId }[] = [
    { label: "Income", planned: plannedIncomeCents, actual: incomeCents, goodWhenOver: true, page: "income" },
    // Only categories with a budget — unbudgeted spending has nothing to compare against.
    { label: "Budgeted spending", planned: budgetedCents, actual: spentCents, goodWhenOver: false, page: "budgets" },
  ];

  return (
    <Panel title={`${monthLong(month)}: plan vs actual`} subtitle={isCurrentMonth ? `${daysLeft} days left` : "Past month"}>
      <div className="grid">
        <div className="col-5">
          <div className="eyebrow">Safe to spend</div>
          {safe.budgetedCents > 0 ? (
            <>
              <div className="stat-value" style={{ color: safe.leftCents < 0 ? "var(--color-negative)" : undefined }}>
                {formatCentsWhole(safe.leftCents)}
              </div>
              <div className="t-xs t-tertiary" style={{ marginTop: "var(--space-1)" }}>
                Left in your spending budgets
                {perDay !== null && ` · ${formatCentsWhole(perDay)}/day`}
              </div>
              <div className="t-2xs t-tertiary" style={{ marginTop: "var(--space-2)" }}>
                {formatCentsWhole(safe.spentCents)} of {formatCentsWhole(safe.budgetedCents)} spent · bills and savings aren't counted
              </div>
            </>
          ) : (
            <>
              <div className="stat-value t-tertiary">—</div>
              <button type="button" className="panel-link" style={{ marginTop: "var(--space-1)" }} onClick={() => onNavigate("budgets")}>
                Set spending budgets to see this
              </button>
            </>
          )}
        </div>
        <div className="col-7 stack">
          {rows.map((r) => {
            const off = r.actual - r.planned;
            const good = r.goodWhenOver ? off >= 0 : off <= 0;
            return (
              <button className="tap-target"
                key={r.label}
                type="button"
                onClick={() => onNavigate(r.page)}
                style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }}
              >
                <div className="row-between t-sm" style={{ marginBottom: "var(--space-1)" }}>
                  <span className="t-medium">{r.label}</span>
                  <span className="num t-tertiary">
                    {formatCentsWhole(r.actual)}
                    {r.planned > 0 && ` / ${formatCentsWhole(r.planned)}`}
                  </span>
                </div>
                {r.planned > 0 ? (
                  <ProgressBar
                    value={r.actual / r.planned}
                    over={!r.goodWhenOver && r.actual > r.planned}
                    label={`${r.label}: actual vs plan`}
                  />
                ) : (
                  <div className="t-2xs t-tertiary">No plan yet — set one in Budgets</div>
                )}
                {r.planned > 0 && (
                  <div className="t-2xs" style={{ marginTop: 2, color: good ? "var(--content-tertiary)" : "var(--color-negative)" }}>
                    {off === 0 ? "On plan" : `${formatCentsWhole(Math.abs(off))} ${off > 0 ? "over" : "under"} plan`}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

/** Balances at a glance — free to use by default, the bank's number on request. */
function AccountsCard({ accounts, onViewAll }: { accounts: Account[]; onViewAll: () => void }) {
  const [showActual, setShowActual] = useShowActualBalances();
  const rows = accounts.filter((a) => !a.archivedAt && a.balanceCents !== 0).slice(0, 6);
  const anySetAside = accounts.some((a) => (a.setAsideCents ?? 0) > 0);
  return (
    <Panel
      title="Accounts"
      subtitle={showActual ? "Bank balances" : "Free to use"}
      actions={
        <span className="row" style={{ gap: "var(--space-2)" }}>
          {anySetAside && (
            <button className="panel-link" onClick={() => setShowActual(!showActual)}>
              {showActual ? "Show available" : "Show actual"}
            </button>
          )}
          <PanelLink onClick={onViewAll} />
        </span>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          compact
          icon="bank"
          title="No accounts yet"
          body="Add an account to see balances here."
          action={
            <Button variant="secondary" size="sm" onClick={onViewAll}>
              Add an account
            </Button>
          }
        />
      ) : (
        <div className="list list-divided">
          {rows.map((a) => (
            <ListRow
              key={a.id}
              chevron={false}
              title={a.name}
              subtitle={
                (a.setAsideCents ?? 0) > 0
                  ? showActual
                    ? `${formatCentsWhole(availableCents(a))} available`
                    : `${formatCentsWhole(a.setAsideCents ?? 0)} set aside`
                  : undefined
              }
              trailing={<Money cents={shownBalance(a, showActual)} whole />}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

/** A metric's history + 3-month projection, with current value and change. */
function TrendCard({
  label,
  points,
  pick,
  color,
  goodWhenUp,
  onViewAll,
}: {
  label: string;
  points: { month: string; netWorthCents: number; incomeCents: number; spendingCents: number }[];
  pick: (p: { month: string; netWorthCents: number; incomeCents: number; spendingCents: number }) => number;
  color: string;
  goodWhenUp: boolean;
  onViewAll: () => void;
}) {
  const history = points.map(pick);
  const projected = project(history, 3);
  const current = history[history.length - 1] ?? 0;
  const first = history[0] ?? 0;
  const delta = current - first;
  const good = goodWhenUp ? delta >= 0 : delta <= 0;
  const pct = (delta / (Math.abs(first) || 1)) * 100;
  const projEnd = projected[projected.length - 1] ?? current;
  const spanLabel =
    points.length > 0
      ? `${monthShort(points[0]!.month)}–${monthShort(points[points.length - 1]!.month)} · +3 mo`
      : "";

  return (
    <Panel title={label} subtitle={spanLabel} actions={<PanelLink onClick={onViewAll} />}>
      <div className="row-baseline">
        <span className="stat-value" style={{ fontSize: "var(--text-xl)" }}>
          {formatCentsWhole(current)}
        </span>
        {history.length >= 2 && (
          <span className={`stat-delta ${good ? "pos" : "neg"}`}>
            <Icon name={delta >= 0 ? "arrowUp" : "arrowDown"} size={12} />
            {formatCentsWhole(Math.abs(delta))}
            {/* A % change from (almost) nothing is meaningless — show it only from a real base. */}
            {Math.abs(first) >= 100 && Math.abs(pct) < 1000 && ` (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)`}
          </span>
        )}
      </div>
      <div style={{ marginTop: "var(--space-3)" }}>
        <TrendChart history={history} projected={projected} color={color} />
      </div>
      <div className="row-between t-2xs t-tertiary" style={{ marginTop: "var(--space-1)" }}>
        <span>{points.length > 0 ? monthShort(points[0]!.month) : ""}</span>
        <span>projected {formatCentsWhole(projEnd)}</span>
      </div>
    </Panel>
  );
}

/** This month's budgeted-vs-spent, with the top few category bars. */
/**
 * The budget at a glance: what's left this month, then the few categories
 * that most need attention (closest to or over their limit). Weekly budgets
 * are judged on this week, since that's when they reset.
 */
function BudgetOverview({
  data,
  month,
  isCurrentMonth,
  categoryById,
  onViewAll,
}: {
  data: BudgetListResponse | null;
  month: string;
  isCurrentMonth: boolean;
  categoryById: Map<string, { name: string; color: string }>;
  onViewAll: () => void;
}) {
  const budgeted = data?.totalBudgetedCents ?? 0;
  const spent = data?.totalSpentCents ?? 0;
  const left = budgeted - spent;
  const over = budgeted > 0 && left < 0;
  const ranked = (data?.budgets ?? [])
    .map((b) => ({ b, ...periodFigures(b) }))
    .filter((x) => x.limit > 0)
    .sort((x, y) => y.spent / y.limit - x.spent / x.limit)
    .slice(0, 3);
  const daysLeft = isCurrentMonth ? daysLeftInMonth() : 0;

  return (
    <Panel title="Budgets" subtitle={monthLong(month)} actions={<PanelLink onClick={onViewAll} />}>
      {budgeted === 0 ? (
        <EmptyState
          compact
          icon="target"
          title="No budgets this month"
          body="Set a weekly or monthly limit per category to track spending against a plan."
          action={
            <Button variant="secondary" size="sm" onClick={onViewAll}>
              Set budgets
            </Button>
          }
        />
      ) : (
        <>
          <div className="row-baseline" style={{ marginBottom: "var(--space-1)" }}>
            <span
              className="stat-value num"
              style={{ fontSize: "var(--text-xl)", color: over ? "var(--color-negative)" : undefined }}
            >
              {formatCentsWhole(Math.abs(left))}
            </span>
            <span className="t-sm t-tertiary">{over ? "over budget" : "left to spend"}</span>
          </div>
          <div className="t-xs t-tertiary" style={{ marginBottom: "var(--space-3)" }}>
            {formatCentsWhole(spent)} of {formatCentsWhole(budgeted)}
            {daysLeft > 0 && ` · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
            {daysLeft > 0 && left > 0 && ` · ${formatCentsWhole(Math.floor(left / daysLeft))} a day`}
          </div>
          <ProgressBar value={spent / budgeted} over={over} label="Total budget used" />
          <div className="stack" style={{ marginTop: "var(--space-4)" }}>
            {ranked.map(({ b, limit, spent: s, weekly }) => {
              const cat = categoryById.get(b.categoryId);
              const catLeft = limit - s;
              return (
                <div key={b.categoryId}>
                  <div className="row-between t-xs" style={{ marginBottom: "var(--space-1)" }}>
                    <span className="row" style={{ gap: "var(--space-2)", minWidth: 0 }}>
                      <span
                        aria-hidden
                        className="dot-swatch"
                        style={{ background: cat?.color ?? "var(--color-accent)" }}
                      />
                      <span className="truncate">{cat?.name ?? "Category"}</span>
                      {weekly && <span className="t-tertiary" style={{ flex: "none" }}>this week</span>}
                    </span>
                    <span
                      className="num"
                      style={{ color: catLeft < 0 ? "var(--color-negative)" : "var(--content-tertiary)", flex: "none" }}
                    >
                      {catLeft < 0 ? `${formatCentsWhole(-catLeft)} over` : `${formatCentsWhole(catLeft)} left`}
                    </span>
                  </div>
                  <ProgressBar
                    small
                    value={s / limit}
                    over={catLeft < 0}
                    {...(cat?.color ? { color: cat.color } : {})}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}
    </Panel>
  );
}

/**
 * Phone: the four headline numbers in one card: net worth large, the month's
 * income, spending and savings rate beneath it. Each part opens its page.
 */
function PhoneSummary({
  month,
  points,
  netWorthCents,
  incomeCents,
  spendingCents,
  savingsRate,
  onNavigate,
}: {
  month: string;
  points: { month: string; netWorthCents: number }[];
  netWorthCents: number;
  incomeCents: number;
  spendingCents: number;
  savingsRate: number | null;
  onNavigate: Navigate;
}) {
  const shownNetWorth = useCountUp(netWorthCents);
  const history = points.map((p) => p.netWorthCents);
  const projected = project(history, 3);
  const first = history[0] ?? 0;
  const delta = (history[history.length - 1] ?? 0) - first;
  const pct = (delta / (Math.abs(first) || 1)) * 100;
  const figures: Array<{ label: string; value: string; page: PageId | null }> = [
    { label: "Income", value: formatCentsWhole(incomeCents), page: "income" },
    { label: "Spending", value: formatCentsWhole(spendingCents), page: "reports" },
    { label: "Saved", value: savingsRate !== null ? `${savingsRate}%` : "—", page: null },
  ];
  return (
    <div className="panel phone-summary">
      <button type="button" className="phone-summary-hero" onClick={() => onNavigate("networth")}>
        <span className="t-sm t-tertiary">Net worth</span>
        <span className="phone-summary-value num">{formatCentsWhole(Math.round(shownNetWorth))}</span>
        {history.length >= 2 && (
          <span className={`stat-delta ${delta >= 0 ? "pos" : "neg"}`} style={{ alignSelf: "flex-start" }}>
            <Icon name={delta >= 0 ? "arrowUp" : "arrowDown"} size={12} />
            {formatCentsWhole(Math.abs(delta))}
            {Math.abs(first) >= 100 && Math.abs(pct) < 1000 && ` (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)`}
            {points[0] && <span className="t-tertiary" style={{ fontWeight: 400 }}>&nbsp;since {monthShort(points[0].month)}</span>}
          </span>
        )}
      </button>
      {/* Six months of net worth, dashed three months ahead. */}
      <div className="phone-summary-chart">
        <TrendChart history={history} projected={projected} color="var(--viz-2)" height={72} />
      </div>
      <div className="phone-summary-month t-xs t-tertiary">{monthLong(month)}</div>
      <div className="phone-summary-figures">
        {figures.map((f) => (
          <button
            key={f.label}
            type="button"
            className="phone-summary-figure"
            disabled={!f.page}
            onClick={() => f.page && onNavigate(f.page)}
          >
            <span className="t-xs t-tertiary">{f.label}</span>
            <span className="num t-medium">{f.value}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The next few bills due, sorted by soonest (server already sorts). */
function UpcomingBills({
  bills,
  onViewAll,
}: {
  bills: { id: string; name: string; amountCents: number; daysUntilDue: number; color: string }[];
  onViewAll: () => void;
}) {
  const next = bills.slice(0, 4);
  return (
    <Panel title="Upcoming bills" subtitle="Soonest first" actions={<PanelLink onClick={onViewAll} />}>
      {next.length === 0 ? (
        <EmptyState
          compact
          icon="receipt"
          title="No bills tracked"
          body="Add recurring bills to see what's due next."
          action={
            <Button variant="secondary" size="sm" onClick={onViewAll}>
              Add a bill
            </Button>
          }
        />
      ) : (
        <div className="list list-divided">
          {next.map((b) => {
            const due = dueLabel(b.daysUntilDue);
            return (
              <ListRow
                key={b.id}
                chevron={false}
                leading={<span aria-hidden className="sq-swatch" style={{ background: b.color }} />}
                title={b.name}
                subtitle={<span style={{ color: toneColor(due.tone), fontWeight: 600 }}>{due.text}</span>}
                trailing={<Money cents={b.amountCents} whole />}
              />
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/** Portfolio value + unrealized gain/loss + top allocation slice. */
function InvestmentsCard({
  data,
  onViewAll,
}: {
  data: {
    totalValueCents: number;
    totalCostBasisCents: number;
    allocation: { symbol: string; share: number }[];
  } | null;
  onViewAll: () => void;
}) {
  const value = data?.totalValueCents ?? 0;
  const cost = data?.totalCostBasisCents ?? 0;
  const gain = value - cost;
  const gainPct = cost > 0 ? (gain / cost) * 100 : 0;
  const top = data?.allocation?.[0];

  return (
    <Panel title="Investments" subtitle="Portfolio value" actions={<PanelLink onClick={onViewAll} />}>
      {value === 0 ? (
        <EmptyState
          compact
          icon="invest"
          title="No holdings yet"
          body="Track positions to see portfolio value and allocation."
          action={
            <Button variant="secondary" size="sm" onClick={onViewAll}>
              Add holdings
            </Button>
          }
        />
      ) : (
        <>
          <div className="stat-value">{formatCentsWhole(value)}</div>
          <div className={`stat-delta ${gain >= 0 ? "pos" : "neg"}`}>
            <Icon name={gain >= 0 ? "trendUp" : "trendDown"} size={13} />
            {formatCentsWhole(Math.abs(gain))} ({gainPct >= 0 ? "+" : ""}
            {gainPct.toFixed(1)}%)
          </div>
          {top && (
            <div className="t-xs t-tertiary" style={{ marginTop: "var(--space-3)" }}>
              Largest holding ·{" "}
              <b style={{ color: "var(--content-primary)" }}>{top.symbol}</b>{" "}
              {Math.round(top.share * 100)}%
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function RecentActivity({
  transactions,
  accountName,
  onViewAll,
}: {
  transactions: Transaction[];
  accountName: (id: string) => string;
  onViewAll: () => void;
}) {
  return (
    <Panel title="Recent activity" actions={<PanelLink onClick={onViewAll} />}>
      {transactions.length === 0 ? (
        <EmptyState
          compact
          icon="card"
          title="No transactions yet"
          body="Import a statement or add one by hand to get started."
          action={
            <Button variant="secondary" size="sm" onClick={onViewAll}>
              Open Transactions
            </Button>
          }
        />
      ) : (
        <div className="list list-divided">
          {transactions.map((t) => (
            <ListRow
              key={t.id}
              chevron={false}
              title={t.merchantName}
              subtitle={`${t.postedAt.slice(5)} · ${accountName(t.accountId)}`}
              trailing={<Money cents={t.amountCents} signed tone="auto" />}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Savings goals: progress toward each, and when it's on track to land. */
function TopGoals({ goals, onViewAll }: { goals: Goal[]; onViewAll: () => void }) {
  // Unfinished goals first, closest to done first; finished ones last.
  const top = [...goals]
    .sort((a, b) => {
      const pa = a.savedCents / (a.targetCents || 1);
      const pb = b.savedCents / (b.targetCents || 1);
      return (pa >= 1 ? 1 : 0) - (pb >= 1 ? 1 : 0) || pb - pa;
    })
    .slice(0, 3);

  return (
    <Panel title="Savings goals" actions={<PanelLink onClick={onViewAll} />}>
      {top.length === 0 ? (
        <EmptyState
          compact
          icon="flag"
          title="No savings goals"
          body="Name what you're saving for and track progress toward it."
          action={
            <Button variant="secondary" size="sm" onClick={onViewAll}>
              Add a goal
            </Button>
          }
        />
      ) : (
        <div className="stack-lg">
          {top.map((g) => {
            const pct = g.targetCents > 0 ? Math.min(1, g.savedCents / g.targetCents) : 0;
            return (
              <div key={g.id}>
                <div className="row-between t-sm" style={{ marginBottom: "var(--space-1)" }}>
                  <span className="t-medium truncate">{g.name}</span>
                  <span className="num t-tertiary" style={{ flex: "none" }}>
                    {formatCentsWhole(g.savedCents)} of {formatCentsWhole(g.targetCents)}
                  </span>
                </div>
                <ProgressBar value={pct} color={g.color} label={g.name} />
                <div className="t-xs t-tertiary" style={{ marginTop: "var(--space-1)" }}>
                  {goalPlanLine(g, pct)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function goalPlanLine(g: Goal, pct: number): string {
  if (pct >= 1) return "Funded";
  const parts = [`${Math.round(pct * 100)}%`];
  if (g.monthlyCents > 0) parts.push(`${formatCentsWhole(g.monthlyCents)} a month`);
  if (g.targetDate) parts.push(`target ${monthYear(g.targetDate.slice(0, 7))}`);
  else if (g.projectedCompletion) parts.push(`on track for ${monthYear(g.projectedCompletion)}`);
  return parts.join(" · ");
}

function GetStarted({
  onNavigate,
  hasAccounts,
}: {
  onNavigate: Navigate;
  hasAccounts: boolean;
}) {
  const aiVisible = useApp((s) => s.aiVisible);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: "var(--grid-gap)",
      }}
    >
      <Card kicker="Get started" title={hasAccounts ? "Record transactions" : "Add your first account"}>
        <p className="card-body">
          {hasAccounts
            ? "Add or import this month's income and spending — the cash-flow diagram appears here as soon as there's a flow to draw."
            : "Checking, savings, credit cards, loans — accounts are where every transaction lives."}
        </p>
        <div>
          <Button variant="primary" onClick={() => onNavigate(hasAccounts ? "transactions" : "accounts")}>
            {hasAccounts ? "Open Transactions" : "Open Accounts"}
          </Button>
        </div>
      </Card>
      {aiVisible ? (
        <Card kicker="Anytime" title="Ask the assistant">
          <p className="card-body">
            Your assistant can explain spending, forecast cash flow, and summarize your month.
          </p>
          <div>
            <Button variant="secondary" icon="sparkle" onClick={() => onNavigate("assistant")}>
              Open AI Assistant
            </Button>
          </div>
        </Card>
      ) : (
        <Card kicker="Optional" title="Add an AI assistant">
          <p className="card-body">
            Off by default. Connect OpenAI, Anthropic, or a local Ollama in Settings to get spending
            explanations and monthly summaries.
          </p>
          <div>
            <Button variant="secondary" onClick={() => onNavigate("settings", { tab: "ai" })}>
              Open AI settings
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
