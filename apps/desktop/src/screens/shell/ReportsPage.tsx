import {
  formatCentsWhole,
  type Goal,
  type MonthlyReport,
  type YearlyReport,
} from "@vault/shared";
import { Button, Card, PieChart, Spinner, Tag } from "@vault/ui";
import { useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { Navigate } from "./AppShell.js";

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function ReportsPage({ onNavigate }: { onNavigate: Navigate }) {
  const client = useApp((s) => s.client);
  const year = new Date().getUTCFullYear();
  const { data: yearly, loading } = useData<YearlyReport>(
    () => client.yearlyReport(year),
    [client, year],
  );
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  if (loading && !yearly) return <Spinner label="Loading reports" />;

  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthsWithData = (yearly?.months ?? []).filter(
    (m) => (m.incomeCents > 0 || m.spendingCents > 0) && m.month <= currentMonth,
  );

  const exportCsv = async () => {
    setExporting(true);
    try {
      const csv = await client.exportCsv();
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "vault-transactions.csv";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="page">
      <div
        style={{
          background:
            "linear-gradient(160deg, var(--color-surface) 0%, color-mix(in srgb, var(--color-section) 45%, var(--color-surface)) 140%)",
          border: "1px solid var(--color-divider)",
          borderRadius: 12,
          padding: 18,
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: ".04em",
              textTransform: "uppercase",
              color: "var(--color-neutral-400)",
              fontWeight: 600,
            }}
          >
            {year} year to date
          </div>
          <Button variant="secondary" onClick={() => void exportCsv()} disabled={exporting}>
            {exporting ? <Spinner label="Exporting" /> : "Export all transactions (CSV)"}
          </Button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 28, marginTop: 10 }}>
          <Ytd value={formatCentsWhole(yearly?.totalIncomeCents ?? 0)} label="income" />
          <Ytd value={formatCentsWhole(yearly?.totalSpendingCents ?? 0)} label="spending" />
          <Ytd value={formatCentsWhole(yearly?.totalSavedCents ?? 0)} label="saved" />
          <Ytd
            value={yearly?.savingsRate != null ? `${Math.round(yearly.savingsRate * 100)}%` : "—"}
            label="savings rate"
          />
        </div>
      </div>

      <div
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-divider)",
          borderRadius: 12,
          boxShadow: "var(--shadow-sm)",
          overflowX: "auto",
        }}
      >
        <div style={{ padding: "14px 18px 6px", fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 14 }}>
          Monthly reports
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <Th>Month</Th>
              <Th align="right">Income</Th>
              <Th align="right">Spending</Th>
              <Th align="right">Saved</Th>
              <Th align="right">Savings rate</Th>
            </tr>
          </thead>
          <tbody>
            {monthsWithData.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted" style={{ padding: 20, textAlign: "center" }}>
                  No activity recorded in {year} yet.
                </td>
              </tr>
            ) : (
              monthsWithData.map((m) => (
                <tr
                  key={m.month}
                  onClick={() => setSelectedMonth(m.month)}
                  style={{
                    borderTop: "1px solid color-mix(in srgb, var(--color-text) 7%, transparent)",
                    cursor: "pointer",
                  }}
                >
                  <td style={{ padding: "9px 18px", fontWeight: 500 }}>{monthLabel(m.month)}</td>
                  <td style={{ padding: "9px 18px", textAlign: "right" }}>
                    {formatCentsWhole(m.incomeCents)}
                  </td>
                  <td style={{ padding: "9px 18px", textAlign: "right" }}>
                    {formatCentsWhole(m.spendingCents)}
                  </td>
                  <td
                    style={{
                      padding: "9px 18px",
                      textAlign: "right",
                      color: m.netCents >= 0 ? "var(--color-positive)" : "var(--color-negative)",
                      fontWeight: 600,
                    }}
                  >
                    {formatCentsWhole(m.netCents)}
                  </td>
                  <td style={{ padding: "9px 18px", textAlign: "right", color: "var(--color-neutral-400)" }}>
                    {m.savingsRate != null ? `${Math.round(m.savingsRate * 100)}%` : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {selectedMonth && (
        <MonthDetail
          month={selectedMonth}
          onClose={() => setSelectedMonth(null)}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}

function Ytd({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 22 }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>{label}</div>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th
      style={{
        padding: "8px 18px",
        fontSize: 10.5,
        letterSpacing: ".05em",
        textTransform: "uppercase",
        color: "var(--color-neutral-500)",
        textAlign: align ?? "left",
        fontWeight: 600,
      }}
    >
      {children}
    </th>
  );
}

/** Month drill-in: top categories + AI commentary (cached server-side). */
function MonthDetail({
  month,
  onClose,
  onNavigate,
}: {
  month: string;
  onClose: () => void;
  onNavigate: Navigate;
}) {
  const client = useApp((s) => s.client);
  const { data: report, loading } = useData<MonthlyReport>(
    () => client.monthlyReport(month),
    [client, month],
  );

  return (
    <Card kicker={monthLabel(month)} title="Month in detail">
      {loading && !report ? (
        <Spinner label="Loading report" />
      ) : report ? (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
            <Ytd value={formatCentsWhole(report.incomeCents)} label="income" />
            <Ytd value={formatCentsWhole(report.spendingCents)} label="spending" />
            <Ytd value={formatCentsWhole(report.savedCents)} label="saved" />
          </div>
          {report.topCategories.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>Spending breakdown</div>
              <PieChart
                data={report.topCategories.map((c) => ({
                  label: c.name,
                  value: c.spentCents,
                  color: c.color,
                }))}
                format={formatCentsWhole}
                centerLabel="spent"
                ariaLabel={`${monthLabel(month)} spending by category`}
              />
              <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
                {report.topCategories.map((c) => (
                  <button
                    key={c.categoryId ?? c.name}
                    title="View this category's transactions"
                    onClick={() =>
                      onNavigate("transactions", { categoryId: c.categoryId ?? "none" })
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 4px",
                      border: 0,
                      borderTop: "1px solid color-mix(in srgb, var(--color-text) 7%, transparent)",
                      background: "none",
                      font: "inherit",
                      color: "inherit",
                      cursor: "pointer",
                      textAlign: "left",
                      width: "100%",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{ width: 9, height: 9, borderRadius: 2, background: c.color, flex: "none" }}
                    />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{c.name}</span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      {formatCentsWhole(c.spentCents)}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>→</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <GoalsTracker />
          {report.aiSummary ? (
            <div
              style={{
                marginTop: 10,
                padding: "12px 14px",
                borderRadius: 10,
                background: "color-mix(in srgb, var(--color-accent) 8%, transparent)",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              <Tag variant="accent" style={{ fontSize: 10, marginBottom: 6 }}>
                ✦ AI summary
              </Tag>
              <div style={{ whiteSpace: "pre-line" }}>{report.aiSummary}</div>
            </div>
          ) : (
            <p className="card-meta" style={{ marginTop: 8 }}>
              AI commentary appears here for closed months when the assistant
              is online.
            </p>
          )}
        </>
      ) : null}
      <div>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </Card>
  );
}

/** Goal progress with an on-track / behind read, driven by projected completion. */
function GoalsTracker() {
  const client = useApp((s) => s.client);
  const { data } = useData(() => client.goals(), [client]);
  const goals = data?.goals ?? [];
  if (goals.length === 0) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>Goals — on track?</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {goals.map((g) => (
          <GoalRow key={g.id} goal={g} />
        ))}
      </div>
    </div>
  );
}

function GoalRow({ goal }: { goal: Goal }) {
  const pct =
    goal.targetCents > 0 ? Math.min(100, Math.round((goal.savedCents / goal.targetCents) * 100)) : 0;
  const targetMonth = goal.targetDate ? goal.targetDate.slice(0, 7) : null;
  let status: { label: string; color: string };
  if (pct >= 100) status = { label: "Reached 🎉", color: "var(--color-positive)" };
  else if (!targetMonth) status = { label: "No deadline", color: "var(--color-neutral-400)" };
  else if (!goal.projectedCompletion)
    status = { label: "Add funds to project", color: "var(--color-neutral-400)" };
  else if (goal.projectedCompletion <= targetMonth)
    status = { label: "On track", color: "var(--color-positive)" };
  else status = { label: "Behind", color: "var(--color-negative)" };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 3 }}>
        <span style={{ display: "flex", gap: 7, alignItems: "center" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: goal.color }} />
          {goal.name}
        </span>
        <span style={{ color: status.color, fontWeight: 600 }}>{status.label}</span>
      </div>
      <div
        style={{ height: 5, borderRadius: 99, background: "var(--color-neutral-900)", overflow: "hidden" }}
      >
        <div style={{ height: "100%", width: `${pct}%`, background: goal.color, borderRadius: 99 }} />
      </div>
      <div style={{ fontSize: 11.5, color: "var(--color-neutral-500)", marginTop: 3 }}>
        {formatCentsWhole(goal.savedCents)} of {formatCentsWhole(goal.targetCents)} ({pct}%)
        {targetMonth ? ` · target ${targetMonth}` : ""}
        {goal.projectedCompletion ? ` · projected ${goal.projectedCompletion}` : ""}
      </div>
    </div>
  );
}
