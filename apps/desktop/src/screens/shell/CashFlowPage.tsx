import { formatCentsWhole, type CashflowSummaryResponse } from "@vault/shared";
import { MetricCard, Panel, Spinner } from "@vault/ui";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";

function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: "short",
    timeZone: "UTC",
  });
}

/** Income vs. spending bars for the last six months, per the design. */
export function CashFlowPage() {
  const client = useApp((s) => s.client);
  const { data, loading } = useData<CashflowSummaryResponse>(
    () => client.cashflowSummary(6),
    [client],
  );

  if (loading && !data) return <Spinner label="Loading cash flow" />;
  const months = data?.months ?? [];
  const max = Math.max(1, ...months.map((m) => Math.max(m.incomeCents, m.spendingCents)));

  const withData = months.filter((m) => m.incomeCents > 0 || m.spendingCents > 0);
  const avgNet =
    withData.length > 0
      ? Math.round(withData.reduce((s, m) => s + m.netCents, 0) / withData.length)
      : 0;
  const rates = withData.map((m) => m.savingsRate).filter((r): r is number => r !== null);
  const avgRate = rates.length > 0 ? rates.reduce((s, r) => s + r, 0) / rates.length : null;
  const totalSaved = withData.reduce((s, m) => s + Math.max(0, m.netCents), 0);

  return (
    <div className="page">
      <Panel
        flush
        title="Income vs. spending"
        subtitle="Last 6 months"
        actions={
          <div style={{ display: "flex", gap: 14, fontSize: 11.5, color: "var(--color-neutral-500)" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--color-positive)" }} />
              In
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--color-accent)" }} />
              Out
            </span>
          </div>
        }
      >
        <div
          style={{
            padding: "8px 18px 18px",
            display: "flex",
            gap: 14,
            alignItems: "flex-end",
            height: 220,
          }}
        >
          {months.map((m) => (
            <div
              key={m.month}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
                alignItems: "center",
                gap: 6,
                height: "100%",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 5,
                  alignItems: "flex-end",
                  width: "100%",
                  justifyContent: "center",
                  flex: 1,
                }}
              >
                <div
                  title={`Income ${formatCentsWhole(m.incomeCents)}`}
                  style={{
                    width: "26%",
                    maxWidth: 30,
                    height: `${(m.incomeCents / max) * 100}%`,
                    minHeight: m.incomeCents > 0 ? 3 : 0,
                    borderRadius: "5px 5px 2px 2px",
                    background: "linear-gradient(180deg, #3ecf8e, #2a9a69)",
                  }}
                />
                <div
                  title={`Spending ${formatCentsWhole(m.spendingCents)}`}
                  style={{
                    width: "26%",
                    maxWidth: 30,
                    height: `${(m.spendingCents / max) * 100}%`,
                    minHeight: m.spendingCents > 0 ? 3 : 0,
                    borderRadius: "5px 5px 2px 2px",
                    background: "linear-gradient(180deg, #9184d9, #6a5fb0)",
                  }}
                />
              </div>
              <div style={{ fontSize: 11.5, color: "var(--color-neutral-500)" }}>
                {monthName(m.month)}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: m.netCents >= 0 ? "var(--color-positive)" : "var(--color-negative)",
                }}
              >
                {formatCentsWhole(m.netCents)}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid">
        <div style={{ gridColumn: "span 4" }}>
          <MetricCard label="Avg monthly net" value={formatCentsWhole(avgNet)} hint="months with activity" />
        </div>
        <div style={{ gridColumn: "span 4" }}>
          <MetricCard
            label="Avg savings rate"
            value={avgRate !== null ? `${Math.round(avgRate * 100)}%` : "—"}
            hint="of income kept"
          />
        </div>
        <div style={{ gridColumn: "span 4" }}>
          <MetricCard label="Saved over period" value={formatCentsWhole(totalSaved)} hint="sum of positive months" />
        </div>
      </div>
    </div>
  );
}
