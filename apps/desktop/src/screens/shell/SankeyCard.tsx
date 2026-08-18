import {
  formatCents,
  formatCentsWhole,
  parseAmountToCents,
  type Account,
  type SankeyLink,
  type SankeyNode,
  type SankeySection,
  type Transaction,
} from "@vault/shared";
import { Button, Field, Sankey, Spinner } from "@vault/ui";
import { useEffect, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { NavFilter, Navigate, PageId } from "./AppShell.js";

type Period = "weekly" | "monthly" | "yearly";
const PERIOD_FACTOR: Record<Period, number> = {
  weekly: 12 / 52,
  monthly: 1,
  yearly: 12,
};

/**
 * Where each kind of node lives in the app, and what the drill-in panel offers
 * for it. This is the table that makes the diagram a control surface rather
 * than a picture: every branch on the Sankey has an owning page, and the ones
 * backed by a single editable row also get an inline amount field.
 */
const SECTION_TARGET: Record<
  SankeySection,
  { page: PageId; label: string; tab?: string }
> = {
  income: { page: "income", label: "Income" },
  spending: { page: "transactions", label: "Transactions" },
  bills: { page: "bills", label: "Bills" },
  debt: { page: "cashflow", label: "Debt payoff", tab: "debt" },
  savings: { page: "goals", label: "Savings goals" },
  giving: { page: "giving", label: "Giving" },
  saved: { page: "cashflow", label: "Cash flow" },
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
  onChanged,
  title = "Cash flow",
  hint = "Click any node to drill in",
  compact = false,
}: {
  nodes: SankeyNode[];
  links: SankeyLink[];
  month: string;
  onNavigate: Navigate;
  /** Called after an inline edit so the page can refetch the diagram. */
  onChanged?: () => void;
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
          onNavigate={onNavigate}
          {...(onChanged ? { onChanged } : {})}
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
  onNavigate,
  onChanged,
}: {
  side: "left" | "right";
  month: string;
  node: SankeyNode;
  isIncome: boolean;
  periodFactor: number;
  onClose: () => void;
  onNavigate: Navigate;
  onChanged?: () => void;
}) {
  const client = useApp((s) => s.client);
  const [txns, setTxns] = useState<Transaction[] | null>(null);

  // Group headers and aggregates ("Bills", "Total income", "Unspent") have no
  // transactions of their own — skip the request rather than showing a spinner
  // that resolves to nothing.
  //
  // Income is explicitly not in that set: an income source is an aggregate of
  // real deposits and listing them is the whole point of clicking it. Treating
  // every non-spending section as a header silently emptied that panel.
  const isPlannedHeader =
    node.section === "bills" ||
    node.section === "debt" ||
    node.section === "savings" ||
    node.section === "giving";
  const isAggregate =
    node.kind === "hub" || node.kind === "saved" || (isPlannedHeader && !node.entityId);

  useEffect(() => {
    if (isAggregate || (!node.accountId && !node.categoryId && node.section !== "spending")) {
      // "Other income" and the shortfall stub genuinely have no rows behind them.
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
  }, [client, node.id, node.categoryId, node.accountId, node.section, isAggregate, month, isIncome]);

  const target = node.section ? SECTION_TARGET[node.section] : null;
  const jumpFilter: NavFilter = {
    ...(node.section === "spending" || node.section === "income"
      ? node.accountId
        ? { accountId: node.accountId }
        : { categoryId: node.categoryId ?? "none" }
      : {}),
    ...(target?.tab ? { tab: target.tab } : {}),
  };

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
            {node.kind === "saved"
              ? "left over"
              : isIncome
                ? "money in"
                : node.section && node.section !== "spending"
                  ? `planned ${node.section}`
                  : "spending"}
          </span>
        </div>
        <h3 style={{ margin: "6px 0 2px", fontSize: "var(--text-xl)", fontWeight: 600 }}>{node.label}</h3>
        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: "var(--text-3xl)", letterSpacing: "-.02em" }}>
          {formatCentsWhole(node.valueCents * periodFactor)}
        </div>

        {node.section && node.entityId && (
          <SectionEditor
            section={node.section}
            entityId={node.entityId}
            onNavigate={onNavigate}
            {...(onChanged ? { onChanged } : {})}
          />
        )}

        {target && (
          <Button
            variant="secondary"
            size="sm"
            iconEnd="arrowRight"
            style={{ marginTop: "var(--space-3)", alignSelf: "flex-start" }}
            onClick={() => onNavigate(target.page, jumpFilter)}
          >
            {node.entityId || node.section === "spending" ? `Manage in ${target.label}` : `Open ${target.label}`}
          </Button>
        )}

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
              onClick={() => onNavigate("transactions", node.accountId ? { accountId: node.accountId } : { categoryId: node.categoryId ?? "none" })}
            >
              View in Transactions →
            </Button>
          </>
        ) : (
          <p style={{ fontSize: "var(--text-sm)", color: "var(--content-tertiary)", lineHeight: 1.6 }}>
            {node.kind === "saved"
              ? "Income that no plan has claimed yet — after spending, bills, debt, savings and giving. This is what's genuinely free to assign."
              : node.kind === "hub"
                ? "Everything that flowed in this month, before spending."
                : node.section && node.section !== "spending" && !node.entityId
                  ? "A planned group — open the section to change what's inside it."
                  : "No individual transactions to show here."}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Inline editor for the row behind a planned node.
 *
 * The point is to change a number without losing your place in the diagram: you
 * clicked "Groceries" on the Bills branch because it looked wrong, so fix it
 * here. Anything structural — adding a bill, deleting a goal, changing a
 * cadence — stays on the owning page, reached by the button below this.
 */
function SectionEditor({
  section,
  entityId,
  onNavigate,
  onChanged,
}: {
  section: SankeySection;
  entityId: string;
  onNavigate: Navigate;
  onChanged?: () => void;
}) {
  const client = useApp((s) => s.client);
  const [amount, setAmount] = useState("");
  // What's currently stored. Tracked separately from the fetched entity because
  // saving doesn't refetch it — comparing against the stale fetched value left
  // the form permanently "dirty", so Save stayed lit and the confirmation never
  // appeared even though the write had succeeded.
  const [baseline, setBaseline] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each section's editable amount means something slightly different, so the
  // entity is fetched rather than inferred from the node's rendered value —
  // a yearly bill's node shows a monthly twelfth, which is not what you edit.
  const { data: entity, loading } = useData(async () => {
    if (section === "bills") {
      const bill = (await client.bills()).bills.find((b) => b.id === entityId);
      return bill
        ? {
            label: bill.cadence === "monthly" ? "Amount per month" : `Amount per ${bill.cadence.replace("ly", "")}`,
            cents: bill.amountCents,
            note: `Due day ${bill.dueDay} · ${bill.cadence}${bill.autopay ? " · autopay" : ""}`,
            accountId: bill.accountId,
            save: (cents: number) => client.updateBill(entityId, { amountCents: cents }),
          }
        : null;
    }
    if (section === "savings") {
      const goal = (await client.goals()).goals.find((g) => g.id === entityId);
      return goal
        ? {
            label: "Contribution per month",
            cents: goal.monthlyCents,
            note: `${formatCentsWhole(goal.savedCents)} saved of ${formatCentsWhole(goal.targetCents)}`,
            accountId: goal.linkedAccountId,
            save: (cents: number) => client.updateGoal(entityId, { monthlyCents: cents }),
          }
        : null;
    }
    if (section === "giving") {
      const fund = (await client.giving()).funds.find((f) => f.id === entityId);
      return fund
        ? {
            label: fund.kind === "gift" ? "Set aside per month" : "Given per month",
            cents: fund.monthlyCents,
            note:
              fund.kind === "gift" && fund.targetCents
                ? `${formatCentsWhole(fund.savedCents)} saved of ${formatCentsWhole(fund.targetCents)}${fund.occasionDate ? ` by ${fund.occasionDate}` : ""}`
                : (fund.recipient ?? "Recurring giving"),
            accountId: fund.accountId,
            save: (cents: number) => client.updateGivingFund(entityId, { monthlyCents: cents }),
          }
        : null;
    }
    if (section === "debt") {
      const plan = await client.debtPlan();
      const override = plan.overrides[entityId];
      const account = (await client.accounts()).accounts.find((a) => a.id === entityId);
      if (!account && !override) return null;
      return {
        label: "Minimum payment per month",
        cents: override?.minCents ?? 0,
        note: account ? `${account.name} · ${formatCentsWhole(Math.abs(account.balanceCents))} owed` : "Planned debt payment",
        accountId: entityId,
        // Overrides are a single JSON blob, so a partial write would drop every
        // other debt's tweaks — merge into the fetched plan and send it whole.
        save: (cents: number) =>
          client.updateDebtPlan({
            ...plan,
            overrides: {
              ...plan.overrides,
              [entityId]: { ...(plan.overrides[entityId] ?? {}), minCents: cents },
            },
          }),
      };
    }
    return null;
  }, [client, section, entityId]);

  // Hydrate the field once the entity arrives; keep whatever the user has typed
  // if they got there first.
  useEffect(() => {
    if (!entity) return;
    setAmount((entity.cents / 100).toFixed(2));
    setBaseline(entity.cents);
  }, [entity]);

  const { data: accountData } = useData(
    () => (entity?.accountId ? client.accounts() : Promise.resolve(null)),
    [client, entity?.accountId],
  );
  const linkedAccount: Account | undefined = entity?.accountId
    ? accountData?.accounts.find((a) => a.id === entity.accountId)
    : undefined;

  if (loading && !entity) return <Spinner label="Loading" />;
  if (!entity) return null;

  const cents = parseAmountToCents(amount);
  const dirty = cents !== null && cents !== baseline;

  const save = async () => {
    if (cents === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await entity.save(cents);
      setBaseline(cents);
      setSaved(true);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <div className="t-sm t-tertiary">{entity.note}</div>
      <Field
        label={entity.label}
        value={amount}
        inputMode="decimal"
        onChange={(e) => {
          setAmount(e.target.value);
          setSaved(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
        }}
      />
      <div className="row" style={{ gap: "var(--space-2)", alignItems: "center" }}>
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={!dirty || busy}>
          {busy ? <Spinner label="Saving" /> : "Save"}
        </Button>
        {saved && !dirty && <span className="t-xs" style={{ color: "var(--color-positive)" }}>Saved</span>}
      </div>
      {linkedAccount && (
        <Button
          variant="ghost"
          size="sm"
          iconEnd="arrowRight"
          title="View this account's transactions"
          style={{ alignSelf: "flex-start" }}
          onClick={() => onNavigate("transactions", { accountId: linkedAccount.id })}
        >
          {linkedAccount.name} · {formatCentsWhole(linkedAccount.balanceCents)}
        </Button>
      )}
      {error && (
        <div role="alert" className="t-xs" style={{ color: "var(--color-negative)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
