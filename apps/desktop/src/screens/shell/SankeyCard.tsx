import { formatCents, formatCentsWhole, type SankeyLink, type SankeyNode, type Transaction } from "@vault/shared";
import { Button, Sankey, Spinner } from "@vault/ui";
import { useEffect, useState } from "react";
import { useApp } from "../../state/store.js";
import type { NavFilter, Navigate } from "./AppShell.js";

type Period = "weekly" | "monthly" | "yearly";
const PERIOD_FACTOR: Record<Period, number> = {
  weekly: 12 / 52,
  monthly: 1,
  yearly: 12,
};

/**
 * The one Sankey presentation used across the app: a card with a title, a
 * weekly/monthly/yearly period toggle, and click-to-drill focus panels (opening
 * on the side opposite the clicked node). Both the dashboard cash-flow diagram
 * and the budget planner render through this so they read as one experience;
 * their node/link structure comes from the same category tree.
 */
export function SankeyCard({
  nodes,
  links,
  month,
  onNavigate,
  title = "Cash flow",
  hint = "Click any node to drill in",
  compact = false,
}: {
  nodes: SankeyNode[];
  links: SankeyLink[];
  month: string;
  onNavigate: Navigate;
  title?: string;
  hint?: string;
  /** Side-by-side mode: drop the period toggle and hint so the card can halve. */
  compact?: boolean;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("monthly");
  const pf = PERIOD_FACTOR[period];

  const focusNode = focus ? (nodes.find((n) => n.id === focus) ?? null) : null;
  const isIncomeSide = !!focusNode && (focusNode.kind === "income" || focusNode.kind === "hub");
  const panelSide: "left" | "right" = isIncomeSide ? "right" : "left";

  return (
    <div className="panel panel-flush elev-md" style={{ position: "relative" }}>
      <div
        className="row-between wrap"
        style={{ padding: "var(--card-pad) var(--card-pad) var(--space-2)" }}
      >
        <div className="panel-title">{title}</div>
        {!compact && (
          <div className="row" style={{ gap: "var(--space-4)" }}>
            <span className="t-xs t-tertiary">{hint}</span>
            <div className="seg">
              {(["weekly", "monthly", "yearly"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  className="seg-opt"
                  onClick={() => setPeriod(p)}
                  {...(period === p ? { "data-on": "true" } : {})}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ padding: "0 var(--space-1) var(--space-2)" }}>
        <Sankey
          nodes={nodes.map((n) => ({ id: n.id, label: n.label, value: n.valueCents, color: n.color, depth: n.depth, kind: n.kind }))}
          links={links.map((l) => ({ from: l.from, to: l.to, value: l.valueCents }))}
          format={(v) => formatCentsWhole(v * pf)}
          focus={focus}
          onFocus={setFocus}
          ariaLabel={`${title} Sankey diagram for ${month}`}
        />
      </div>

      {focus && focusNode && (
        <FocusPanel
          side={panelSide}
          month={month}
          node={focusNode}
          isIncome={isIncomeSide}
          periodFactor={pf}
          onClose={() => setFocus(null)}
          onViewAll={(filter) => onNavigate("transactions", filter)}
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
  node: {
    id: string;
    label: string;
    valueCents: number;
    color: string;
    categoryId: string | null;
    accountId?: string | null | undefined;
  };
  isIncome: boolean;
  periodFactor: number;
  onClose: () => void;
  onViewAll: (filter: NavFilter) => void;
}) {
  const client = useApp((s) => s.client);
  const [txns, setTxns] = useState<Transaction[] | null>(null);

  useEffect(() => {
    // "Saved", the hub, and planned group headers have no direct transactions.
    if (node.id === "saved" || node.id === "hub" || node.id === "bills:hub" || node.id === "debt:hub") {
      setTxns([]);
      return;
    }
    let cancelled = false;
    const [y, m] = month.split("-").map(Number) as [number, number];
    const from = `${month}-01`;
    const to = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
    const filter = node.accountId ? { accountId: node.accountId } : { categoryId: node.categoryId ?? "none" };
    client
      .transactions({ ...filter, from, to, limit: 8 })
      .then((res) => {
        if (!cancelled) setTxns(res.transactions.filter((t) => (isIncome ? t.amountCents > 0 : t.amountCents < 0)));
      })
      .catch(() => {
        if (!cancelled) setTxns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, node.id, node.categoryId, node.accountId, month, isIncome]);

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
        ...(side === "left" ? { borderRight: "1px solid var(--color-divider)" } : { borderLeft: "1px solid var(--color-divider)" }),
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
          <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: "var(--radius-sm)", background: node.color, flex: "none" }} />
          <span style={{ fontSize: "var(--text-2xs)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--content-tertiary)", fontWeight: 600 }}>
            {node.id === "saved" ? "kept this month" : isIncome ? "money in" : "spending"}
          </span>
        </div>
        <h3 style={{ margin: "6px 0 2px", fontSize: "var(--text-xl)", fontWeight: 600 }}>{node.label}</h3>
        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: "var(--text-3xl)", letterSpacing: "-.02em" }}>
          {formatCentsWhole(node.valueCents * periodFactor)}
        </div>
        <div style={{ height: 1, background: "var(--color-divider)", margin: "14px 0" }} />
        {txns === null ? (
          <Spinner label="Loading transactions" />
        ) : txns.length > 0 ? (
          <>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {txns.map((t) => (
                <div key={t.id} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "7px 0", borderBottom: "1px solid color-mix(in srgb, var(--color-text) 8%, transparent)", fontSize: "var(--text-sm)" }}>
                  <span style={{ color: "var(--content-tertiary)", flex: "none", width: 44 }}>{t.postedAt.slice(5)}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.merchantName}</span>
                  <span style={{ fontWeight: 600, whiteSpace: "nowrap", color: t.amountCents > 0 ? "var(--color-positive)" : "var(--color-text)" }}>
                    {formatCents(t.amountCents, { signed: true })}
                  </span>
                </div>
              ))}
            </div>
            <Button
              variant="ghost"
              style={{ marginTop: 12 }}
              onClick={() => onViewAll(node.accountId ? { accountId: node.accountId } : { categoryId: node.categoryId ?? "none" })}
            >
              View in Transactions →
            </Button>
          </>
        ) : (
          <p style={{ fontSize: "var(--text-sm)", color: "var(--content-tertiary)", lineHeight: 1.6 }}>
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
