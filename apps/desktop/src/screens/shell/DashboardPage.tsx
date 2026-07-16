import {
  formatCents,
  formatCentsWhole,
  type SankeyResponse,
  type Transaction,
} from "@vault/shared";
import { Button, Card, Sankey, Spinner } from "@vault/ui";
import { useEffect, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { PageId } from "./AppShell.js";

type Period = "weekly" | "monthly" | "yearly";
const PERIOD_FACTOR: Record<Period, number> = {
  weekly: 12 / 52,
  monthly: 1,
  yearly: 12,
};

export function DashboardPage({
  onNavigate,
}: {
  onNavigate: (page: PageId, categoryId?: string) => void;
}) {
  const client = useApp((s) => s.client);
  const { data: accountData } = useData(() => client.accounts(), [client]);
  const { data: sankeyData, loading } = useData<SankeyResponse>(
    () => client.sankey(),
    [client],
  );

  const accounts = accountData?.accounts ?? [];
  const netWorth = accounts.reduce((sum, a) => sum + a.balanceCents, 0);
  const hasData = (sankeyData?.incomes.length ?? 0) > 0 || (sankeyData?.leaves.length ?? 0) > 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        maxWidth: 1100,
        margin: "0 auto",
        animation: "fadeUp .3s both",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 14,
        }}
      >
        <StatCard label="Net worth" value={formatCentsWhole(netWorth)} />
        <StatCard
          label="Income this month"
          value={formatCentsWhole(sankeyData?.totalIncomeCents ?? 0)}
        />
        <StatCard
          label="Spending this month"
          value={formatCentsWhole(sankeyData?.totalSpendingCents ?? 0)}
        />
      </div>

      {loading && !sankeyData ? (
        <Spinner label="Loading cash flow" />
      ) : hasData ? (
        <SankeyCard data={sankeyData!} onNavigate={onNavigate} />
      ) : (
        <GetStarted onNavigate={onNavigate} hasAccounts={accounts.length > 0} />
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-divider)",
        borderRadius: 12,
        padding: "16px 18px",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: ".04em",
          textTransform: "uppercase",
          color: "var(--color-neutral-500)",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-heading)",
          fontWeight: 600,
          fontSize: 24,
          letterSpacing: "-.02em",
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * The flagship card: Sankey with click-to-drill focus panel (panel opens on
 * the side opposite the clicked node, per the design) and a display-only
 * weekly/monthly/yearly period toggle.
 */
function SankeyCard({
  data,
  onNavigate,
}: {
  data: SankeyResponse;
  onNavigate: (page: PageId, categoryId?: string) => void;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("monthly");
  const pf = PERIOD_FACTOR[period];

  const allNodes = [...data.incomes, ...data.leaves];
  const focusNode = focus && focus !== "hub" ? allNodes.find((n) => n.id === focus) : null;
  // Income nodes sit on the left → panel opens right; leaves → left.
  const panelSide: "left" | "right" =
    focus && focus !== "hub" && data.leaves.some((n) => n.id === focus) ? "left" : "right";

  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-divider)",
        borderRadius: 14,
        position: "relative",
        overflow: "hidden",
        boxShadow: "var(--shadow-md)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "16px 20px 8px",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            fontSize: 15,
            letterSpacing: "-.01em",
          }}
        >
          Cash flow
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>
            Click any node to drill in
          </span>
          <div
            style={{
              display: "flex",
              background: "var(--color-neutral-900)",
              border: "1px solid var(--color-divider)",
              borderRadius: 8,
              padding: 2,
              gap: 2,
            }}
          >
            {(["weekly", "monthly", "yearly"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                style={{
                  border: 0,
                  cursor: "pointer",
                  fontFamily: "var(--font-body)",
                  fontWeight: 600,
                  fontSize: 12,
                  padding: "4px 12px",
                  borderRadius: 6,
                  background: period === p ? "var(--color-accent-800)" : "transparent",
                  color: period === p ? "var(--color-accent-100)" : "var(--color-neutral-400)",
                  transition: "background .15s",
                }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ padding: "0 4px 8px" }}>
        <Sankey
          incomes={data.incomes.map((n) => ({
            id: n.id,
            label: n.label,
            value: n.valueCents,
            color: n.color,
          }))}
          leaves={data.leaves.map((n) => ({
            id: n.id,
            label: n.label,
            value: n.valueCents,
            color: n.color,
          }))}
          hubLabel={`TOTAL INCOME · ${formatCentsWhole(data.totalIncomeCents * pf)}`}
          format={(v) => formatCentsWhole(v * pf)}
          focus={focus}
          onFocus={setFocus}
          ariaLabel={`Sankey diagram of ${data.month} cash flow`}
        />
      </div>

      {focus && (
        <FocusPanel
          side={panelSide}
          month={data.month}
          node={
            focus === "hub"
              ? {
                  id: "hub",
                  label: "Total income",
                  valueCents: data.totalIncomeCents,
                  color: "#9397ab",
                  categoryId: null,
                }
              : focusNode!
          }
          isIncome={focus === "hub" || data.incomes.some((n) => n.id === focus)}
          periodFactor={pf}
          onClose={() => setFocus(null)}
          onViewAll={(categoryId) => onNavigate("transactions", categoryId)}
        />
      )}
    </div>
  );
}

function FocusPanel({
  side,
  month,
  node,
  isIncome,
  periodFactor,
  onClose,
  onViewAll,
}: {
  side: "left" | "right";
  month: string;
  node: { id: string; label: string; valueCents: number; color: string; categoryId: string | null };
  isIncome: boolean;
  periodFactor: number;
  onClose: () => void;
  onViewAll: (categoryId?: string) => void;
}) {
  const client = useApp((s) => s.client);
  const [txns, setTxns] = useState<Transaction[] | null>(null);

  useEffect(() => {
    // "Saved" and the hub have no direct transactions to list.
    if (node.id === "saved" || node.id === "hub") {
      setTxns([]);
      return;
    }
    let cancelled = false;
    const [y, m] = month.split("-").map(Number) as [number, number];
    const from = `${month}-01`;
    const to = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
    client
      .transactions({ categoryId: node.categoryId ?? "none", from, to, limit: 8 })
      .then((res) => {
        if (!cancelled) {
          setTxns(
            res.transactions.filter((t) => (isIncome ? t.amountCents > 0 : t.amountCents < 0)),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setTxns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, node.id, node.categoryId, month, isIncome]);

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        ...(side === "left" ? { left: 0 } : { right: 0 }),
        width: 340,
        maxWidth: "100%",
        background: "color-mix(in srgb, var(--color-surface) 92%, transparent)",
        backdropFilter: "blur(14px)",
        ...(side === "left"
          ? { borderRight: "1px solid var(--color-divider)" }
          : { borderLeft: "1px solid var(--color-divider)" }),
        boxShadow: "var(--shadow-lg)",
        display: "flex",
        flexDirection: "column",
        animation: `${side === "left" ? "slideInL" : "slideIn"} .25s both`,
      }}
    >
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--color-divider)" }}>
        <Button variant="ghost" onClick={onClose}>
          ← All flows
        </Button>
      </div>
      <div style={{ padding: "16px 18px", overflow: "auto", flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            aria-hidden="true"
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              background: node.color,
              flex: "none",
            }}
          />
          <span
            style={{
              fontSize: 11,
              letterSpacing: ".05em",
              textTransform: "uppercase",
              color: "var(--color-neutral-500)",
              fontWeight: 600,
            }}
          >
            {node.id === "saved" ? "kept this month" : isIncome ? "money in" : "spending"}
          </span>
        </div>
        <h3 style={{ margin: "6px 0 2px", fontSize: 19, fontWeight: 600 }}>{node.label}</h3>
        <div
          style={{
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            fontSize: 28,
            letterSpacing: "-.02em",
          }}
        >
          {formatCentsWhole(node.valueCents * periodFactor)}
        </div>
        <div style={{ height: 1, background: "var(--color-divider)", margin: "14px 0" }} />
        {txns === null ? (
          <Spinner label="Loading transactions" />
        ) : txns.length > 0 ? (
          <>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {txns.map((t) => (
                <div
                  key={t.id}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 10,
                    padding: "7px 0",
                    borderBottom:
                      "1px solid color-mix(in srgb, var(--color-text) 8%, transparent)",
                    fontSize: 12.5,
                  }}
                >
                  <span style={{ color: "var(--color-neutral-500)", flex: "none", width: 44 }}>
                    {t.postedAt.slice(5)}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.merchantName}
                  </span>
                  <span
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
            <Button
              variant="ghost"
              style={{ marginTop: 12 }}
              onClick={() => onViewAll(node.categoryId ?? "none")}
            >
              View in Transactions →
            </Button>
          </>
        ) : (
          <p style={{ fontSize: 13, color: "var(--color-neutral-400)", lineHeight: 1.6 }}>
            {node.id === "saved"
              ? "Money that came in and didn't go out — this is what moved your net worth up this month."
              : node.id === "hub"
                ? "Everything that flowed in this month, before spending."
                : "No individual transactions to show here."}
          </p>
        )}
      </div>
    </div>
  );
}

function GetStarted({
  onNavigate,
  hasAccounts,
}: {
  onNavigate: (page: PageId) => void;
  hasAccounts: boolean;
}) {
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
      <Card kicker="Anytime" title="Ask the assistant">
        <p className="card-body">
          The AI runs on your own server. Once transactions exist it can
          explain spending, forecast cash flow, and more.
        </p>
        <div>
          <Button variant="secondary" onClick={() => onNavigate("assistant")}>
            Open AI Assistant
          </Button>
        </div>
      </Card>
    </div>
  );
}
