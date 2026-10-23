import {
  formatCentsWhole,
  type Account,
  type Bill,
  type Goal,
  type PreIncome,
  type SankeyResponse,
  type Transaction,
  type UserPreferences,
} from "@vault/shared";
import {
  Button,
  Card,
  EmptyState,
  Icon,
  ListRow,
  MetricCard,
  Money,
  Panel,
  PanelLink,
  ProgressBar,
  Segmented,
  Skeleton,
} from "@vault/ui";
import { useEffect, useState, type ReactNode } from "react";
import { availableCents, shownBalance, useShowActualBalances } from "../../lib/balanceView.js";
import { moveWidget, placeWidget, resolveLayout, SPANS, type ResolvedWidget, type Span } from "../../lib/dashboardLayout.js";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import { buildBudgetSankey, preIncomeBranches, withGrossBranch, withTaxBranch } from "./budgetSankey.js";
import type { Navigate, PageId } from "./nav.js";
import { PreIncomeDialog } from "./PreIncomeDialog.js";
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
type SankeyView = "actual" | "planned" | "both";
const SANKEY_VIEW_KEY = "dashboard-sankey-view";
const SANKEY_VIEWS = [
  { value: "actual" as const, label: "Actual" },
  { value: "planned" as const, label: "Planned" },
  { value: "both" as const, label: "Both" },
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
    if (v === "actual" || v === "planned" || v === "both") return v;
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
  const { data: budgetData } = useData(() => client.budgets(month), [client, month]);
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
  const [customizing, setCustomizing] = useState(false);
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

  // Which cash-flow diagram the dashboard leads with. Remembered, because it's
  // a statement about how you think about money, not a per-visit choice.
  const [sankeyView, setSankeyView] = useState<SankeyView>(loadSankeyView);
  useEffect(() => {
    try {
      localStorage.setItem(SANKEY_VIEW_KEY, sankeyView);
    } catch {
      /* ignore */
    }
  }, [sankeyView]);

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

  // Don't offer a view there's no data for — and fall back rather than render
  // an empty card if the remembered choice is currently unavailable.
  const availableViews = SANKEY_VIEWS.filter(
    (v) => (v.value === "actual" && hasData) || (v.value === "planned" && hasPlan) || (v.value === "both" && hasData && hasPlan),
  );
  const effectiveView: SankeyView = availableViews.some((v) => v.value === sankeyView)
    ? sankeyView
    : (availableViews[0]?.value ?? "actual");

  // Every card and section is a widget the person can move, hide or resize
  // (Customize); their layout is saved to their account on the server.
  const widgetNodes: Record<string, { label: string; span: Span; node: ReactNode }> = {
    "metric-networth": { label: "Net worth (number)", span: 3, node: <MetricCard
            label="Net worth"
            icon="bank"
            value={formatCentsWhole(netWorth)}
            hint="Across all accounts"
            onClick={() => onNavigate("accounts")}
          /> },
    "metric-income": { label: "Income this month (number)", span: 3, node: <MetricCard
            label={`Income · ${monthLong(month)}`}
            icon="income"
            value={formatCentsWhole(income)}
            onClick={() => onNavigate("income")}
          /> },
    "metric-spending": { label: "Spending this month (number)", span: 3, node: <MetricCard
            label={`Spending · ${monthLong(month)}`}
            icon="card"
            value={formatCentsWhole(spending)}
            onClick={() => onNavigate("reports")}
          /> },
    "metric-savings": { label: "Savings rate (number)", span: 3, node: <MetricCard
            label="Savings rate"
            icon="target"
            value={savingsRate !== null ? `${savingsRate}%` : "—"}
            deltaTone={savingsRate !== null && savingsRate >= 0 ? "up" : "down"}
            hint="of income kept"
          /> },
    sankey: { label: "Cash-flow Sankey", span: 12, node: (loading && !sankeyData ? (
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
          ) : effectiveView === "planned" ? (
            <SankeyCard
              title="Budget plan"
              hint="Click a category to see this month's actual spending"
              nodes={planSankey.nodes}
              links={planSankey.links}
              month={month}
              onNavigate={onNavigate}
            />
          ) : (
            <SankeyCard
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
      )) },
    "this-month": { label: "This month: plan vs actual", span: 8, node: <ThisMonth
            month={month}
            isCurrentMonth={isCurrentMonth}
            plannedIncomeCents={plannedIncome}
            incomeCents={income}
            budgetedCents={budgetData?.totalBudgetedCents ?? 0}
            spentCents={budgetData?.totalSpentCents ?? spending}
            accounts={accounts}
            bills={billData?.bills ?? []}
            onNavigate={onNavigate}
          /> },
    accounts: { label: "Accounts", span: 4, node: <AccountsCard accounts={accounts} onViewAll={() => onNavigate("accounts")} /> },
    "trend-networth": { label: "Net worth trend", span: 4, node: <TrendCard
            label="Net worth"
            points={points}
            pick={(p) => p.netWorthCents}
            color="var(--viz-2)"
            goodWhenUp
            onViewAll={() => onNavigate("accounts")}
          /> },
    "trend-income": { label: "Income trend", span: 4, node: <TrendCard
            label="Income"
            points={points}
            pick={(p) => p.incomeCents}
            color="var(--viz-3)"
            goodWhenUp
            onViewAll={() => onNavigate("income")}
          /> },
    "trend-spending": { label: "Spending trend", span: 4, node: <TrendCard
            label="Spending"
            points={points}
            pick={(p) => p.spendingCents}
            color="var(--viz-1)"
            goodWhenUp={false}
            onViewAll={() => onNavigate("reports")}
          /> },
    budgets: { label: "Budgets", span: 4, node: <BudgetOverview
            data={budgetData}
            month={month}
            categoryById={categoryById}
            onViewAll={() => onNavigate("budgets")}
          /> },
    bills: { label: "Upcoming bills", span: 4, node: <UpcomingBills bills={billData?.bills ?? []} onViewAll={() => onNavigate("bills")} /> },
    investments: { label: "Investments", span: 4, node: <InvestmentsCard data={investData} onViewAll={() => onNavigate("investments")} /> },
    recent: { label: "Recent activity", span: 8, node: <RecentActivity
            transactions={recent}
            accountName={(id) => accountById.get(id)?.name ?? "—"}
            onViewAll={() => onNavigate("transactions")}
          /> },
    goals: { label: "Goals", span: 4, node: <TopGoals goals={goals} onViewAll={() => onNavigate("goals")} /> },
  };
  const layout = resolveLayout(
    Object.entries(widgetNodes).map(([id, w]) => ({ id, span: w.span })),
    prefs?.dashboard,
  );

  return (
    <div className="page">
      <div className="row-between wrap" style={{ marginBottom: -8 }}>
        <span />
        <Button variant={customizing ? "primary" : "ghost"} size="sm" icon="edit" onClick={() => setCustomizing((c) => !c)}>
          {customizing ? "Done" : "Customize"}
        </Button>
      </div>
      {customizing && (
        <CustomizeDashboard
          layout={layout}
          labels={Object.fromEntries(Object.entries(widgetNodes).map(([id, w]) => [id, w.label]))}
          onChange={saveLayout}
          onReset={() => saveLayout(null)}
        />
      )}
      <div className="grid">
        {layout
          .filter((w) => !w.hidden)
          .map((w) => (
            <div key={w.id} className={`col-${w.span}`}>
              {widgetNodes[w.id]!.node}
            </div>
          ))}
      </div>
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

/** Arrange the dashboard: drag or nudge widgets, show/hide them, pick their width. */
function CustomizeDashboard({
  layout,
  labels,
  onChange,
  onReset,
}: {
  layout: ResolvedWidget[];
  labels: Record<string, string>;
  onChange: (next: ResolvedWidget[]) => void;
  onReset: () => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const set = (id: string, patch: Partial<ResolvedWidget>) => onChange(layout.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  return (
    <Panel
      title="Customize your dashboard"
      subtitle="Drag to reorder, or use the arrows. Saved to your account."
      actions={
        <Button variant="ghost" size="sm" onClick={onReset}>
          Reset to default
        </Button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        {layout.map((w, i) => (
          <div
            key={w.id}
            draggable
            onDragStart={() => setDragging(w.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragging) onChange(placeWidget(layout, dragging, w.id));
              setDragging(null);
            }}
            onDragEnd={() => setDragging(null)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 4px",
              borderTop: i ? "1px solid var(--color-divider)" : undefined,
              opacity: dragging === w.id ? 0.5 : w.hidden ? 0.6 : 1,
              cursor: "grab",
            }}
          >
            <span aria-hidden="true" style={{ color: "var(--content-tertiary)", letterSpacing: -2 }}>⋮⋮</span>
            <label className="radio" style={{ flex: 1, fontSize: "var(--text-sm)" }}>
              <input type="checkbox" checked={!w.hidden} onChange={(e) => set(w.id, { hidden: !e.target.checked })} />
              <span className="dot" style={{ borderRadius: "var(--radius-sm)" }} />
              {labels[w.id] ?? w.id}
            </label>
            <select
              className="input"
              aria-label={`Width of ${labels[w.id] ?? w.id}`}
              value={w.span}
              onChange={(e) => set(w.id, { span: Number(e.target.value) as Span })}
              style={{ width: 120, padding: "4px 8px" }}
            >
              {SPANS.map((sp) => (
                <option key={sp.value} value={sp.value}>
                  {sp.label}
                </option>
              ))}
            </select>
            <Button variant="ghost" size="sm" icon="arrowUp" aria-label="Move up" disabled={i === 0} onClick={() => onChange(moveWidget(layout, w.id, -1))} />
            <Button variant="ghost" size="sm" icon="arrowDown" aria-label="Move down" disabled={i === layout.length - 1} onClick={() => onChange(moveWidget(layout, w.id, 1))} />
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** Accounts you spend from: checking, savings and other cash. */
const CASH_TYPES = new Set<Account["type"]>(["checking", "savings", "other"]);

function daysLeftInMonth(): number {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return end.getUTCDate() - now.getUTCDate() + 1;
}

/**
 * Where the plan meets the bank: the month's plan next to what actually
 * happened, and what's safe to spend — free cash (after set-asides) minus the
 * part of this month's remaining bills that hasn't been set aside yet.
 */
function ThisMonth({
  month,
  isCurrentMonth,
  plannedIncomeCents,
  incomeCents,
  budgetedCents,
  spentCents,
  accounts,
  bills,
  onNavigate,
}: {
  month: string;
  isCurrentMonth: boolean;
  plannedIncomeCents: number;
  incomeCents: number;
  budgetedCents: number;
  spentCents: number;
  accounts: Account[];
  bills: Bill[];
  onNavigate: Navigate;
}) {
  const daysLeft = daysLeftInMonth();
  const freeCash = accounts
    .filter((a) => !a.isLiability && CASH_TYPES.has(a.type))
    .reduce((s, a) => s + availableCents(a), 0);
  const billsDue = bills.filter((b) => b.daysUntilDue < daysLeft);
  const unfundedBills = billsDue.reduce((s, b) => s + Math.max(0, b.amountCents - b.savedCents), 0);
  const safeToSpend = freeCash - unfundedBills;
  const leftToSpend = budgetedCents - spentCents;
  const perDay = isCurrentMonth && leftToSpend > 0 ? Math.floor(leftToSpend / daysLeft) : null;

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
          <div className="stat-value" style={{ color: safeToSpend < 0 ? "var(--color-negative)" : undefined }}>
            {formatCentsWhole(safeToSpend)}
          </div>
          <div className="t-xs t-tertiary" style={{ marginTop: "var(--space-1)" }}>
            {formatCentsWhole(freeCash)} free cash
            {unfundedBills > 0 && ` − ${formatCentsWhole(unfundedBills)} for ${billsDue.length} bill${billsDue.length === 1 ? "" : "s"} still due`}
          </div>
          {budgetedCents > 0 && (
            <div className="t-xs t-tertiary" style={{ marginTop: "var(--space-2)" }}>
              Budget left: <b style={{ color: leftToSpend < 0 ? "var(--color-negative)" : "var(--content-primary)" }}>{formatCentsWhole(leftToSpend)}</b>
              {perDay !== null && ` · ${formatCentsWhole(perDay)}/day`}
            </div>
          )}
        </div>
        <div className="col-7 stack">
          {rows.map((r) => {
            const off = r.actual - r.planned;
            const good = r.goodWhenOver ? off >= 0 : off <= 0;
            return (
              <button
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
function BudgetOverview({
  data,
  month,
  categoryById,
  onViewAll,
}: {
  data: {
    budgets: { categoryId: string; amountCents: number; spentCents: number }[];
    totalBudgetedCents: number;
    totalSpentCents: number;
  } | null;
  month: string;
  categoryById: Map<string, { name: string; color: string }>;
  onViewAll: () => void;
}) {
  const budgeted = data?.totalBudgetedCents ?? 0;
  const spent = data?.totalSpentCents ?? 0;
  const over = budgeted > 0 && spent > budgeted;
  const top = [...(data?.budgets ?? [])].sort((a, b) => b.spentCents - a.spentCents).slice(0, 3);

  return (
    <Panel title="Budgets" subtitle={monthLong(month)} actions={<PanelLink onClick={onViewAll} />}>
      {budgeted === 0 ? (
        <EmptyState
          compact
          icon="target"
          title="No budgets this month"
          body="Set a limit per category to track spending against a plan."
          action={
            <Button variant="secondary" size="sm" onClick={onViewAll}>
              Set budgets
            </Button>
          }
        />
      ) : (
        <>
          <div className="row-baseline" style={{ marginBottom: "var(--space-2)" }}>
            <span className="stat-value" style={{ fontSize: "var(--text-xl)" }}>
              {formatCentsWhole(spent)}
            </span>
            <span className="t-xs t-tertiary">of {formatCentsWhole(budgeted)}</span>
          </div>
          <ProgressBar value={spent / budgeted} over={over} label="Total budget used" />
          <div className="stack" style={{ marginTop: "var(--space-4)" }}>
            {top.map((b) => {
              const cat = categoryById.get(b.categoryId);
              const catOver = b.spentCents > b.amountCents;
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
                    </span>
                    <span
                      className="num"
                      style={{
                        color: catOver ? "var(--color-negative)" : "var(--content-tertiary)",
                        flex: "none",
                      }}
                    >
                      {formatCentsWhole(b.spentCents)} / {formatCentsWhole(b.amountCents)}
                    </span>
                  </div>
                  <ProgressBar
                    small
                    value={b.amountCents > 0 ? b.spentCents / b.amountCents : 0}
                    over={catOver}
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

function TopGoals({ goals, onViewAll }: { goals: Goal[]; onViewAll: () => void }) {
  const top = [...goals]
    .sort((a, b) => b.savedCents / (b.targetCents || 1) - a.savedCents / (a.targetCents || 1))
    .slice(0, 3);

  return (
    <Panel title="Goals" actions={<PanelLink onClick={onViewAll} />}>
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
          {top.map((g) => (
            <div key={g.id}>
              <div className="row-between t-sm" style={{ marginBottom: "var(--space-1)" }}>
                <span className="t-medium truncate">{g.name}</span>
                <span className="num t-tertiary" style={{ flex: "none" }}>
                  {formatCentsWhole(g.savedCents)} / {formatCentsWhole(g.targetCents)}
                </span>
              </div>
              <ProgressBar
                value={g.targetCents > 0 ? g.savedCents / g.targetCents : 0}
                color={g.color}
                label={g.name}
              />
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
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
