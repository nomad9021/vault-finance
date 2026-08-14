import {
  formatCentsWhole,
  type Goal,
  type SankeyResponse,
  type Transaction,
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
import { useEffect, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import { buildBudgetSankey } from "./budgetSankey.js";
import type { Navigate, PageId } from "./nav.js";
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
  const planSankey = buildBudgetSankey(
    plannedIncome,
    categories.filter((c) => c.kind === "expense"),
    new Map((budgetData?.budgets ?? []).map((b) => [b.categoryId, b.amountCents])),
  );
  const hasPlan = plannedIncome > 0 || planSankey.allocated > 0;

  // Don't offer a view there's no data for — and fall back rather than render
  // an empty card if the remembered choice is currently unavailable.
  const availableViews = SANKEY_VIEWS.filter(
    (v) => (v.value === "actual" && hasData) || (v.value === "planned" && hasPlan) || (v.value === "both" && hasData && hasPlan),
  );
  const effectiveView: SankeyView = availableViews.some((v) => v.value === sankeyView)
    ? sankeyView
    : (availableViews[0]?.value ?? "actual");

  return (
    <div className="page">
      {/* Hero metrics */}
      <div className="grid">
        <div className="col-3">
          <MetricCard
            label="Net worth"
            icon="bank"
            value={formatCentsWhole(netWorth)}
            hint="Across all accounts"
            onClick={() => onNavigate("accounts")}
          />
        </div>
        <div className="col-3">
          <MetricCard
            label={`Income · ${monthLong(month)}`}
            icon="income"
            value={formatCentsWhole(income)}
            onClick={() => onNavigate("income")}
          />
        </div>
        <div className="col-3">
          <MetricCard
            label={`Spending · ${monthLong(month)}`}
            icon="card"
            value={formatCentsWhole(spending)}
            onClick={() => onNavigate("reports")}
          />
        </div>
        <div className="col-3">
          <MetricCard
            label="Savings rate"
            icon="target"
            value={savingsRate !== null ? `${savingsRate}%` : "—"}
            deltaTone={savingsRate !== null && savingsRate >= 0 ? "up" : "down"}
            hint="of income kept"
          />
        </div>
      </div>

      {/* Flagship cash-flow Sankey — actual, planned, or both side by side */}
      {loading && !sankeyData ? (
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
            <Segmented
              options={availableViews}
              value={effectiveView}
              onChange={setSankeyView}
              aria-label="Which cash-flow diagram to show"
            />
          </div>

          {effectiveView === "both" ? (
            <div className="grid">
              <div className="col-6">
                <SankeyCard
                  compact
                  title="Actual"
                  nodes={sankeyData!.nodes}
                  links={sankeyData!.links}
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
              nodes={sankeyData!.nodes}
              links={sankeyData!.links}
              month={sankeyData!.month}
              onNavigate={onNavigate}
              onChanged={reloadSankey}
            />
          )}
        </div>
      ) : (
        <GetStarted onNavigate={onNavigate} hasAccounts={accounts.length > 0} />
      )}

      {/* Net worth · income · spending — past months + forward projection */}
      <div className="grid">
        <div className="col-4">
          <TrendCard
            label="Net worth"
            points={points}
            pick={(p) => p.netWorthCents}
            color="var(--viz-2)"
            goodWhenUp
            onViewAll={() => onNavigate("accounts")}
          />
        </div>
        <div className="col-4">
          <TrendCard
            label="Income"
            points={points}
            pick={(p) => p.incomeCents}
            color="var(--viz-3)"
            goodWhenUp
            onViewAll={() => onNavigate("income")}
          />
        </div>
        <div className="col-4">
          <TrendCard
            label="Spending"
            points={points}
            pick={(p) => p.spendingCents}
            color="var(--viz-1)"
            goodWhenUp={false}
            onViewAll={() => onNavigate("reports")}
          />
        </div>
      </div>

      {/* Budgets · bills · investments */}
      <div className="grid">
        <div className="col-4">
          <BudgetOverview
            data={budgetData}
            month={month}
            categoryById={categoryById}
            onViewAll={() => onNavigate("budgets")}
          />
        </div>
        <div className="col-4">
          <UpcomingBills bills={billData?.bills ?? []} onViewAll={() => onNavigate("bills")} />
        </div>
        <div className="col-4">
          <InvestmentsCard data={investData} onViewAll={() => onNavigate("investments")} />
        </div>
      </div>

      {/* Recent activity · goals */}
      <div className="grid">
        <div className="col-8">
          <RecentActivity
            transactions={recent}
            accountName={(id) => accountById.get(id)?.name ?? "—"}
            onViewAll={() => onNavigate("transactions")}
          />
        </div>
        <div className="col-4">
          <TopGoals goals={goals} onViewAll={() => onNavigate("goals")} />
        </div>
      </div>
    </div>
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
            {formatCentsWhole(Math.abs(delta))} ({pct >= 0 ? "+" : ""}
            {pct.toFixed(0)}%)
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
  onNavigate: (page: PageId) => void;
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
            <Button variant="secondary" onClick={() => onNavigate("settings")}>
              Open Settings
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
