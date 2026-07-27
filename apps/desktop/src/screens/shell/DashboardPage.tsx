import {
  formatCents,
  formatCentsWhole,
  type Goal,
  type SankeyResponse,
  type Transaction,
} from "@vault/shared";
import { Button, Card, MetricCard, Panel } from "@vault/ui";
import { useEffect } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { Navigate, PageId } from "./AppShell.js";
import { SankeyCard } from "./SankeyCard.js";
import { TrendChart, project } from "./TrendChart.js";

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
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
  if (days <= 7) return { text: `Due in ${days} days`, tone: "soon" };
  return { text: `Due in ${days} days`, tone: "ok" };
}
const toneColor = (tone: "over" | "soon" | "ok") =>
  tone === "over" ? "var(--color-negative)" : tone === "soon" ? "var(--color-accent)" : "var(--color-neutral-500)";

/** A subtle "See all →" link used in every dashboard panel header. */
function SeeAll({ onClick, label = "See all" }: { onClick: () => void; label?: string }) {
  return (
    <button className="panel-link" onClick={onClick}>
      {label} →
    </button>
  );
}

export function DashboardPage({ onNavigate }: { onNavigate: Navigate }) {
  const client = useApp((s) => s.client);
  const month = currentMonth();
  const { data: accountData, reload: reloadAccounts } = useData(() => client.accounts(), [client]);
  const { data: sankeyData, loading, reload: reloadSankey } = useData<SankeyResponse>(
    () => client.sankey(),
    [client],
  );
  const { data: txnData, reload: reloadTxns } = useData(
    () => client.transactions({ limit: 6 }),
    [client],
  );
  const { data: goalData } = useData(() => client.goals(), [client]);
  const { data: trendData } = useData(() => client.trends(6), [client]);
  const { data: budgetData } = useData(() => client.budgets(month), [client, month]);
  const { data: categoryData } = useData(() => client.categories(), [client]);
  const { data: billData } = useData(() => client.bills(), [client]);
  const { data: investData } = useData(() => client.investments(), [client]);

  // Poll so bank auto-sync / webhook imports show up live without a manual
  // refresh. The spinner only appears when there's no data yet, so this is
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
  const categoryById = new Map((categoryData?.categories ?? []).map((c) => [c.id, c]));
  const points = trendData?.points ?? [];

  return (
    <div className="page">
      {/* Hero metrics */}
      <div className="grid">
        <div style={{ gridColumn: "span 3", minWidth: 0 }}>
          <MetricCard
            label="Net worth"
            value={formatCentsWhole(netWorth)}
            hint="View accounts →"
            onClick={() => onNavigate("accounts")}
          />
        </div>
        <div style={{ gridColumn: "span 3", minWidth: 0 }}>
          <MetricCard
            label={`Income · ${monthLong(month)}`}
            value={formatCentsWhole(income)}
            hint="View income →"
            onClick={() => onNavigate("income")}
          />
        </div>
        <div style={{ gridColumn: "span 3", minWidth: 0 }}>
          <MetricCard
            label={`Spending · ${monthLong(month)}`}
            value={formatCentsWhole(spending)}
            hint="View reports →"
            onClick={() => onNavigate("reports")}
          />
        </div>
        <div style={{ gridColumn: "span 3", minWidth: 0 }}>
          <MetricCard
            label="Savings rate"
            value={savingsRate !== null ? `${savingsRate}%` : "—"}
            deltaTone={savingsRate !== null && savingsRate >= 0 ? "up" : "down"}
            hint="of income kept"
          />
        </div>
      </div>

      {/* Flagship cash-flow Sankey */}
      {loading && !sankeyData ? (
        <Panel>
          <div className="skeleton" style={{ height: 360 }} />
        </Panel>
      ) : hasData ? (
        <SankeyCard nodes={sankeyData!.nodes} links={sankeyData!.links} month={sankeyData!.month} onNavigate={onNavigate} />
      ) : (
        <GetStarted onNavigate={onNavigate} hasAccounts={accounts.length > 0} />
      )}

      {/* Net worth · income · spending — past months + forward projection */}
      <div className="grid">
        <div style={{ gridColumn: "span 4", minWidth: 0 }}>
          <TrendCard label="Net worth" points={points} pick={(p) => p.netWorthCents} color="var(--color-positive)" goodWhenUp onViewAll={() => onNavigate("accounts")} />
        </div>
        <div style={{ gridColumn: "span 4", minWidth: 0 }}>
          <TrendCard label="Income" points={points} pick={(p) => p.incomeCents} color="#6f8ef2" goodWhenUp onViewAll={() => onNavigate("income")} />
        </div>
        <div style={{ gridColumn: "span 4", minWidth: 0 }}>
          <TrendCard label="Spending" points={points} pick={(p) => p.spendingCents} color="var(--color-accent)" goodWhenUp={false} onViewAll={() => onNavigate("reports")} />
        </div>
      </div>

      {/* Budgets · bills · investments */}
      <div className="grid">
        <div style={{ gridColumn: "span 4", minWidth: 0 }}>
          <BudgetOverview data={budgetData} month={month} categoryById={categoryById} onViewAll={() => onNavigate("budgets")} />
        </div>
        <div style={{ gridColumn: "span 4", minWidth: 0 }}>
          <UpcomingBills bills={billData?.bills ?? []} onViewAll={() => onNavigate("bills")} />
        </div>
        <div style={{ gridColumn: "span 4", minWidth: 0 }}>
          <InvestmentsCard data={investData} onViewAll={() => onNavigate("investments")} />
        </div>
      </div>

      {/* Recent activity · goals */}
      <div className="grid">
        <div style={{ gridColumn: "span 8", minWidth: 0 }}>
          <RecentActivity
            transactions={recent}
            accountName={(id) => accountById.get(id)?.name ?? "—"}
            onViewAll={() => onNavigate("transactions")}
          />
        </div>
        <div style={{ gridColumn: "span 4", minWidth: 0 }}>
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
  const pctBase = Math.abs(first) || 1;
  const pct = (delta / pctBase) * 100;
  const projEnd = projected[projected.length - 1] ?? current;
  const spanLabel = points.length > 0 ? `${monthShort(points[0]!.month)}–${monthShort(points[points.length - 1]!.month)} · +3 mo` : "";
  return (
    <Panel title={label} subtitle={spanLabel} actions={<SeeAll onClick={onViewAll} />}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span className="metric-value" style={{ fontSize: 24 }}>{formatCentsWhole(current)}</span>
        {history.length >= 2 && (
          <span className={`num ${good ? "pos" : "neg"}`} style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}>
            {delta >= 0 ? "▲" : "▼"} {formatCentsWhole(Math.abs(delta))} ({pct >= 0 ? "+" : ""}{pct.toFixed(0)}%)
          </span>
        )}
      </div>
      <div style={{ marginTop: 10 }}>
        <TrendChart history={history} projected={projected} color={color} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--color-neutral-500)", marginTop: 4 }}>
        <span>{points.length > 0 ? monthShort(points[0]!.month) : ""}</span>
        <span style={{ opacity: 0.7 }}>projected {formatCentsWhole(projEnd)}</span>
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
  data: { budgets: { categoryId: string; amountCents: number; spentCents: number }[]; totalBudgetedCents: number; totalSpentCents: number } | null;
  month: string;
  categoryById: Map<string, { name: string; color: string }>;
  onViewAll: () => void;
}) {
  const budgeted = data?.totalBudgetedCents ?? 0;
  const spent = data?.totalSpentCents ?? 0;
  const pct = budgeted > 0 ? Math.min(1, spent / budgeted) : 0;
  const over = budgeted > 0 && spent > budgeted;
  const top = [...(data?.budgets ?? [])].sort((a, b) => b.spentCents - a.spentCents).slice(0, 3);
  return (
    <Panel title="Budgets" subtitle={monthLong(month)} actions={<SeeAll onClick={onViewAll} />}>
      {budgeted === 0 ? (
        <p className="card-meta">No budgets set this month.</p>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <span className="metric-value" style={{ fontSize: 22 }}>{formatCentsWhole(spent)}</span>
            <span style={{ fontSize: 12.5, color: "var(--color-neutral-500)" }}>of {formatCentsWhole(budgeted)}</span>
          </div>
          <div style={{ height: 8, borderRadius: 99, background: "color-mix(in srgb, var(--color-text) 8%, transparent)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct * 100}%`, borderRadius: 99, background: over ? "var(--color-negative)" : "var(--color-accent)", transition: "width .4s var(--ease)" }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 11, marginTop: 14 }}>
            {top.map((b) => {
              const cat = categoryById.get(b.categoryId);
              const p = b.amountCents > 0 ? Math.min(1, b.spentCents / b.amountCents) : 0;
              const o = b.spentCents > b.amountCents;
              return (
                <div key={b.categoryId}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: cat?.color ?? "var(--color-accent)", flex: "none" }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cat?.name ?? "Category"}</span>
                    </span>
                    <span className="num" style={{ color: o ? "var(--color-negative)" : "var(--color-neutral-500)", flex: "none" }}>
                      {formatCentsWhole(b.spentCents)} / {formatCentsWhole(b.amountCents)}
                    </span>
                  </div>
                  <div style={{ height: 6, borderRadius: 99, background: "color-mix(in srgb, var(--color-text) 8%, transparent)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${p * 100}%`, borderRadius: 99, background: o ? "var(--color-negative)" : (cat?.color ?? "var(--color-accent)"), transition: "width .4s var(--ease)" }} />
                  </div>
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
    <Panel title="Upcoming bills" subtitle="Soonest first" actions={<SeeAll onClick={onViewAll} />}>
      {next.length === 0 ? (
        <p className="card-meta">No bills tracked yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {next.map((b) => {
            const due = dueLabel(b.daysUntilDue);
            return (
              <div key={b.id} className="row-div" style={{ display: "flex", alignItems: "center", gap: 11, padding: "9px 2px", fontSize: 13.5 }}>
                <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: b.color, flex: "none" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: toneColor(due.tone) }}>{due.text}</div>
                </div>
                <span className="num" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{formatCentsWhole(b.amountCents)}</span>
              </div>
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
  data: { totalValueCents: number; totalCostBasisCents: number; allocation: { symbol: string; share: number }[] } | null;
  onViewAll: () => void;
}) {
  const value = data?.totalValueCents ?? 0;
  const cost = data?.totalCostBasisCents ?? 0;
  const gain = value - cost;
  const gainPct = cost > 0 ? (gain / cost) * 100 : 0;
  const top = data?.allocation?.[0];
  return (
    <Panel title="Investments" subtitle="Portfolio value" actions={<SeeAll onClick={onViewAll} />}>
      {value === 0 ? (
        <p className="card-meta">No holdings yet.</p>
      ) : (
        <>
          <div className="metric-value" style={{ fontSize: 26 }}>{formatCentsWhole(value)}</div>
          <div className={`num ${gain >= 0 ? "pos" : "neg"}`} style={{ fontSize: 12.5, fontWeight: 600, marginTop: 2 }}>
            {gain >= 0 ? "+" : "−"}
            {formatCentsWhole(Math.abs(gain))} ({gainPct >= 0 ? "+" : ""}{gainPct.toFixed(1)}%)
          </div>
          {top && (
            <div style={{ fontSize: 12.5, color: "var(--color-neutral-500)", marginTop: 12 }}>
              Largest holding · <b style={{ color: "var(--color-text)" }}>{top.symbol}</b> {Math.round(top.share * 100)}%
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
    <Panel
      title="Recent activity"
      actions={
        <button className="panel-link" onClick={onViewAll}>
          See all →
        </button>
      }
    >
      {transactions.length === 0 ? (
        <p className="card-meta">No transactions yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {transactions.map((t) => (
            <div
              key={t.id}
              className="row-div"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 2px",
                fontSize: 13.5,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                  {t.merchantName}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--color-neutral-500)" }}>
                  {t.postedAt.slice(5)} · {accountName(t.accountId)}
                </div>
              </div>
              <span
                className="num"
                style={{
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  color: t.amountCents > 0 ? "var(--color-positive)" : "var(--color-text)",
                }}
              >
                {formatCents(t.amountCents, { signed: true })}
              </span>
            </div>
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
    <Panel
      title="Goals"
      actions={
        <button className="panel-link" onClick={onViewAll}>
          See all →
        </button>
      }
    >
      {top.length === 0 ? (
        <p className="card-meta">No savings goals yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {top.map((g) => {
            const pct = g.targetCents > 0 ? Math.min(1, g.savedCents / g.targetCents) : 0;
            return (
              <div key={g.id}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
                  <span style={{ fontWeight: 500 }}>{g.name}</span>
                  <span className="num" style={{ color: "var(--color-neutral-500)" }}>
                    {formatCentsWhole(g.savedCents)} / {formatCentsWhole(g.targetCents)}
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 99, background: "color-mix(in srgb, var(--color-text) 8%, transparent)", overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${pct * 100}%`,
                      borderRadius: 99,
                      background: g.color,
                      transition: "width .4s var(--ease)",
                    }}
                  />
                </div>
              </div>
            );
          })}
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
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 14,
      }}
    >
      <Card kicker="Get started" title={hasAccounts ? "Record transactions" : "Add your first account"}>
        <p className="card-body">
          {hasAccounts
            ? "Add or import this month's income and spending — the cash-flow diagram appears here as soon as there's a flow to draw."
            : "Checking, savings, credit cards, loans — accounts are where every transaction lives."}
        </p>
        <div>
          <Button
            variant="primary"
            onClick={() => onNavigate(hasAccounts ? "transactions" : "accounts")}
          >
            {hasAccounts ? "Open Transactions" : "Open Accounts"}
          </Button>
        </div>
      </Card>
      {aiVisible ? (
        <Card kicker="Anytime" title="Ask the assistant">
          <p className="card-body">
            Your assistant can explain spending, forecast cash flow, and
            summarize your month.
          </p>
          <div>
            <Button variant="secondary" onClick={() => onNavigate("assistant")}>
              Open AI Assistant
            </Button>
          </div>
        </Card>
      ) : (
        <Card kicker="Optional" title="Add an AI assistant">
          <p className="card-body">
            Off by default. Connect OpenAI, Anthropic, or a local Ollama in
            Settings to get spending explanations and monthly summaries.
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
