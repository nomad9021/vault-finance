import {
  formatCentsWhole,
  type MonthlyReport,
  type YearlyReport,
} from "@vault/shared";
import { Button, Card, Spinner, Tag } from "@vault/ui";
import { useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function ReportsPage() {
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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        maxWidth: 860,
        margin: "0 auto",
        animation: "fadeUp .3s both",
      }}
    >
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
        <MonthDetail month={selectedMonth} onClose={() => setSelectedMonth(null)} />
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
function MonthDetail({ month, onClose }: { month: string; onClose: () => void }) {
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
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
              {report.topCategories.map((c) => {
                const maxSpent = report.topCategories[0]!.spentCents;
                return (
                  <div key={c.categoryId ?? "none"} style={{ fontSize: 12.5 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <span
                          style={{ width: 7, height: 7, borderRadius: "50%", background: c.color }}
                        />
                        {c.name}
                      </span>
                      <span style={{ color: "var(--color-neutral-500)" }}>
                        {formatCentsWhole(c.spentCents)}
                      </span>
                    </div>
                    <div
                      style={{
                        height: 5,
                        borderRadius: 99,
                        background: "var(--color-neutral-900)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${(c.spentCents / maxSpent) * 100}%`,
                          background: c.color,
                          borderRadius: 99,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
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
