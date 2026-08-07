import {
  formatCentsWhole,
  parseAmountToCents,
  type BudgetWithSpend,
  type Category,
} from "@vault/shared";
import { Button, Panel, Spinner } from "@vault/ui";
import { useEffect, useRef, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { Navigate } from "./AppShell.js";
import { buildBudgetSankey } from "./budgetSankey.js";
import { SankeyCard } from "./SankeyCard.js";

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}
function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Budget planner — a forward-looking view: set one fixed monthly income, split
 * it across category budgets, and watch the Sankey balance the plan (income →
 * each budgeted category → unallocated/savings). Pure plan, independent of what
 * has actually been spent. The planned income persists via /budget-plan; the
 * per-category allocations are the same budgets as the Budgets page.
 */
export function BudgetPlannerPage({ onNavigate }: { onNavigate: Navigate }) {
  const client = useApp((s) => s.client);
  const [month, setMonth] = useState(currentMonth());
  const { data: planData } = useData(() => client.budgetPlan(), [client]);
  const { data: budgetData, loading, reload } = useData(() => client.budgets(month), [client, month]);
  const { data: catData } = useData(() => client.categories(), [client]);

  const categories = catData?.categories ?? [];
  const expenseCats = categories.filter((c) => c.kind === "expense");
  const budgets = budgetData?.budgets ?? [];
  const budgetByCat = new Map(budgets.map((b) => [b.categoryId, b]));

  // Planned income: hydrate once, persist debounced + on unmount.
  const [income, setIncome] = useState("");
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !planData) return;
    hydrated.current = true;
    setIncome(planData.plannedIncomeCents ? (planData.plannedIncomeCents / 100).toFixed(0) : "");
  }, [planData]);
  const incomeCents = parseAmountToCents(income) ?? 0;
  const incomeRef = useRef(incomeCents);
  incomeRef.current = incomeCents;
  useEffect(() => {
    if (!hydrated.current) return;
    const t = setTimeout(() => void client.updateBudgetPlan({ plannedIncomeCents: incomeCents }), 500);
    return () => clearTimeout(t);
  }, [client, incomeCents]);
  useEffect(() => {
    return () => {
      if (hydrated.current) void client.updateBudgetPlan({ plannedIncomeCents: incomeRef.current });
    };
  }, [client]);

  const allocated = budgets.reduce((s, b) => s + b.amountCents, 0);
  const unallocated = Math.max(0, incomeCents - allocated);
  const over = allocated > incomeCents;

  const setAllocation = async (categoryId: string, amountCents: number) => {
    const existing = budgetByCat.get(categoryId);
    if (existing) {
      if (amountCents > 0) await client.updateBudget(existing.id, { amountCents });
      else await client.deleteBudget(existing.id);
    } else if (amountCents > 0) {
      await client.createBudget({ categoryId, amountCents, rollover: false, month });
    }
    reload();
  };

  // Hierarchical budget Sankey, built from the same category tree as the main
  // cash-flow diagram so both are shaped by the Settings category editor.
  const budgetByCatAmount = new Map(budgets.map((b) => [b.categoryId, b.amountCents]));
  const { nodes, links } = buildBudgetSankey(incomeCents, expenseCats, budgetByCatAmount);
  const hasFlow = incomeCents > 0 || allocated > 0;

  return (
    <div className="page" style={{ maxWidth: 1040 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="ghost" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
          ←
        </Button>
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: "var(--text-md)", minWidth: 150, textAlign: "center" }}>
          {monthLabel(month)}
        </span>
        <Button variant="ghost" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
          →
        </Button>
        <div style={{ marginLeft: "auto" }}>
          <Button variant="secondary" onClick={() => onNavigate("budgets")}>
            Track vs. actual →
          </Button>
        </div>
      </div>

      <Panel
        kicker="Plan"
        title="Budget planner"
        subtitle="Set your monthly income, then allocate it across categories"
      >
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 6 }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 4 }}>Fixed monthly income</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--content-tertiary)", fontSize: "var(--text-xl)" }}>$</span>
              <input
                className="input"
                value={income}
                onChange={(e) => setIncome(e.target.value)}
                inputMode="decimal"
                placeholder="5000"
                style={{ width: 130, fontSize: "var(--text-xl)", fontWeight: 600 }}
              />
            </div>
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 4 }}>Allocated</div>
            <div className="metric-value" style={{ fontSize: "var(--text-xl)" }}>{formatCentsWhole(allocated)}</div>
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 4 }}>{over ? "Over budget" : "Unallocated / savings"}</div>
            <div
              className="metric-value"
              style={{ fontSize: "var(--text-xl)", color: over ? "var(--color-negative)" : "var(--color-positive)" }}
            >
              {over ? `-${formatCentsWhole(allocated - incomeCents)}` : formatCentsWhole(unallocated)}
            </div>
          </div>
        </div>

      </Panel>

      {hasFlow ? (
        <SankeyCard
          nodes={nodes}
          links={links}
          month={month}
          onNavigate={onNavigate}
          title="Budget plan"
          hint="Click a category to see this month's actual spending"
        />
      ) : (
        <Panel title="Budget plan">
          <p className="card-meta" style={{ padding: "12px 0" }}>
            {incomeCents <= 0
              ? "Enter your fixed monthly income above to start planning."
              : "Add an allocation below and the plan will flow through here."}
          </p>
        </Panel>
      )}

      <Panel title="Allocations" subtitle="How much of your income each category gets this month">
        {loading && !budgetData ? (
          <Spinner label="Loading budgets" />
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {expenseCats.map((c) => (
              <AllocationRow
                key={c.id}
                category={c}
                budget={budgetByCat.get(c.id)}
                onSave={(cents) => void setAllocation(c.id, cents)}
              />
            ))}
            {expenseCats.length === 0 && (
              <p className="card-meta">
                No expense categories yet. Add some in Settings, then allocate here.
              </p>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}

function AllocationRow({
  category,
  budget,
  onSave,
}: {
  category: Category;
  budget: BudgetWithSpend | undefined;
  onSave: (amountCents: number) => void;
}) {
  const [val, setVal] = useState(budget ? (budget.amountCents / 100).toFixed(0) : "");
  useEffect(() => {
    setVal(budget ? (budget.amountCents / 100).toFixed(0) : "");
  }, [budget?.amountCents]);

  const commit = () => {
    const cents = parseAmountToCents(val) ?? 0;
    if (cents !== (budget?.amountCents ?? 0)) onSave(cents);
  };

  return (
    <div
      className="row-div"
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 2px", fontSize: "var(--text-sm)" }}
    >
      <span
        aria-hidden
        style={{ width: 9, height: 9, borderRadius: "50%", background: category.color, flex: "none" }}
      />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {category.name}
      </span>
      <span style={{ color: "var(--content-tertiary)" }}>$</span>
      <input
        className="input num"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        inputMode="numeric"
        placeholder="0"
        style={{ width: 96, textAlign: "right", padding: "5px 8px" }}
      />
    </div>
  );
}
