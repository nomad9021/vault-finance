import {
  ACCOUNT_TYPE_LABELS,
  formatCentsWhole,
  type Account,
  type AccountType,
} from "@vault/shared";
import { EmptyState, MetricCard, Panel, Segmented, Spinner } from "@vault/ui";
import { useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { Navigate } from "./AppShell.js";
import { TrendChart, project } from "./TrendChart.js";

const RANGES = [
  { value: "6" as const, label: "6 months" },
  { value: "12" as const, label: "12 months" },
  { value: "24" as const, label: "24 months" },
];

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

/**
 * Net worth — assets minus liabilities, and how that number got here.
 *
 * The dashboard shows net worth as a single sparkline, which answers "is it up?"
 * but not "why?". This page splits the number into what you own and what you
 * owe, breaks each side down by account, and puts the month-over-month change
 * next to it — so a jump is traceable to the account that caused it rather than
 * being a mystery line going up.
 *
 * The history is reconstructed from transaction flows (see /cashflow/trends),
 * so it moves with money in and out but not with market re-pricing that was
 * never transacted — worth knowing before reading an investment dip into it.
 */
export function NetWorthPage({ onNavigate }: { onNavigate: Navigate }) {
  const client = useApp((s) => s.client);
  const [range, setRange] = useState<"6" | "12" | "24">("12");
  const { data: acctData, loading } = useData(() => client.accounts(), [client]);
  const { data: trendData } = useData(() => client.trends(Number(range)), [client, range]);

  if (loading && !acctData) return <Spinner label="Loading net worth" />;

  const accounts = acctData?.accounts ?? [];
  const assets = accounts.filter((a) => !a.isLiability);
  const liabilities = accounts.filter((a) => a.isLiability);
  const assetTotal = assets.reduce((s, a) => s + a.balanceCents, 0);
  // Liability balances are stored negative; owed is the magnitude.
  const owedTotal = liabilities.reduce((s, a) => s + Math.abs(a.balanceCents), 0);
  const netWorth = assetTotal - owedTotal;

  const points = trendData?.points ?? [];
  const history = points.map((p) => p.netWorthCents);
  const first = history[0];
  const last = history[history.length - 1];
  const change = first !== undefined && last !== undefined ? last - first : 0;
  const prev = history[history.length - 2];
  const monthChange = prev !== undefined && last !== undefined ? last - prev : 0;

  if (accounts.length === 0) {
    return (
      <div className="page">
        <div className="panel">
          <EmptyState
            icon="scale"
            title="No accounts yet"
            body="Net worth is everything you own minus everything you owe. Add your accounts and this page fills itself in."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="grid">
        <div className="col-6">
          <MetricCard
            large
            label="Net worth"
            value={formatCentsWhole(netWorth)}
            delta={`${monthChange >= 0 ? "+" : "−"}${formatCentsWhole(Math.abs(monthChange))} this month`}
            deltaTone={monthChange >= 0 ? "up" : "down"}
            hint={`${accounts.length} accounts`}
          />
        </div>
        <div className="col-3">
          <MetricCard
            label="Assets"
            value={formatCentsWhole(assetTotal)}
            deltaTone="up"
            hint={`${assets.length} accounts`}
            onClick={() => onNavigate("accounts")}
          />
        </div>
        <div className="col-3">
          <MetricCard
            label="Liabilities"
            value={formatCentsWhole(owedTotal)}
            deltaTone={owedTotal > 0 ? "down" : "up"}
            hint={`${liabilities.length} accounts`}
            onClick={() => onNavigate("cashflow", { tab: "debt" })}
          />
        </div>
      </div>

      <Panel
        flush
        title="Net worth over time"
        subtitle={
          history.length > 1
            ? `${change >= 0 ? "Up" : "Down"} ${formatCentsWhole(Math.abs(change))} over ${range} months · dashed line is a projection`
            : "Not enough history yet"
        }
        actions={<Segmented options={RANGES} value={range} onChange={setRange} aria-label="Time range" />}
      >
        <div style={{ padding: "4px 18px 12px" }}>
          <TrendChart
            history={history}
            projected={project(history, 3)}
            color={change >= 0 ? "var(--color-positive)" : "var(--color-negative)"}
            height={180}
          />
          {points.length > 1 && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 6,
                fontSize: "var(--text-2xs)",
                color: "var(--content-tertiary)",
              }}
            >
              <span>{monthLabel(points[0]!.month)}</span>
              <span>{monthLabel(points[points.length - 1]!.month)}</span>
            </div>
          )}
        </div>
      </Panel>

      <div className="grid">
        <div className="col-6">
          <BalanceBreakdown
            title="What you own"
            subtitle="Assets by account"
            accounts={assets}
            total={assetTotal}
            tone="var(--color-positive)"
            onNavigate={onNavigate}
          />
        </div>
        <div className="col-6">
          <BalanceBreakdown
            title="What you owe"
            subtitle="Liabilities by account"
            accounts={liabilities}
            total={owedTotal}
            tone="var(--color-negative)"
            onNavigate={onNavigate}
          />
        </div>
      </div>
    </div>
  );
}

function BalanceBreakdown({
  title,
  subtitle,
  accounts,
  total,
  tone,
  onNavigate,
}: {
  title: string;
  subtitle: string;
  accounts: Account[];
  total: number;
  tone: string;
  onNavigate: Navigate;
}) {
  // Grouped by type so "three savings accounts" reads as one line of the story
  // rather than three, while individual accounts stay visible underneath.
  const byType = new Map<AccountType, Account[]>();
  for (const account of accounts) {
    const list = byType.get(account.type) ?? [];
    list.push(account);
    byType.set(account.type, list);
  }
  const groups = [...byType.entries()]
    .map(([type, list]) => ({
      type,
      list: [...list].sort((a, b) => Math.abs(b.balanceCents) - Math.abs(a.balanceCents)),
      total: list.reduce((s, a) => s + Math.abs(a.balanceCents), 0),
    }))
    .sort((a, b) => b.total - a.total);

  return (
    <Panel title={title} subtitle={subtitle}>
      {groups.length === 0 ? (
        <p className="card-meta">Nothing here — which is good news on the liabilities side.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          {groups.map((group) => (
            <div key={group.type}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 10,
                }}
              >
                <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>
                  {ACCOUNT_TYPE_LABELS[group.type]}
                </span>
                <span className="num" style={{ fontWeight: 600 }}>
                  {formatCentsWhole(group.total)}
                </span>
              </div>
              <div
                style={{
                  height: 6,
                  borderRadius: 99,
                  marginTop: 6,
                  background: "color-mix(in srgb, var(--color-text) 8%, transparent)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${total > 0 ? (group.total / total) * 100 : 0}%`,
                    borderRadius: 99,
                    background: tone,
                    transition: "width .4s var(--ease)",
                  }}
                />
              </div>
              <div style={{ marginTop: 4 }}>
                {group.list.map((account) => (
                  <button
                    key={account.id}
                    onClick={() => onNavigate("transactions", { accountId: account.id })}
                    title="View this account's transactions"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      width: "100%",
                      gap: 10,
                      background: "none",
                      border: 0,
                      padding: "4px 0",
                      font: "inherit",
                      cursor: "pointer",
                      color: "var(--content-tertiary)",
                      fontSize: "var(--text-xs)",
                    }}
                  >
                    <span className="truncate">
                      {account.name}
                      {account.mask ? ` ····${account.mask}` : ""}
                    </span>
                    <span className="num">{formatCentsWhole(Math.abs(account.balanceCents))}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
