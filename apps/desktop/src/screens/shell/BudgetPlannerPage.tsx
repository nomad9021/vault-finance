import {
  formatCentsWhole,
  parseAmountToCents,
  type BudgetWithSpend,
  type Category,
  type SankeyLink,
  type SankeyNode,
} from "@vault/shared";
import { Button, Panel, Spinner } from "@vault/ui";
import { useEffect, useRef, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { Navigate } from "./AppShell.js";
import { SankeyCard } from "./SankeyCard.js";

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Build the budget-planner Sankey with the same hierarchical structure as the
 * main cash-flow diagram — income → hub → the category tree (each node weighted
 * by its subtree's budgeted amount) → an "Unallocated / savings" leaf. Because
 * it walks the same `parentCategoryId` tree, editing the tree in Settings
 * reshapes this diagram and the cash-flow one identically.
 */
function buildBudgetSankey(
  incomeCents: number,
  expenseCats: Category[],
  budgetByCatAmount: Map<string, number>,
): { nodes: SankeyNode[]; links: SankeyLink[]; allocated: number } {
  const childrenOf = (id: string | null) =>
    expenseCats
      .filter((c) => (c.parentCategoryId ?? null) === id)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const subtree = new Map<string, number>();
  const compute = (id: string, seen: Set<string>): number => {
    if (subtree.has(id)) return subtree.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    let total = budgetByCatAmount.get(id) ?? 0;
    for (const ch of childrenOf(id)) total += compute(ch.id, seen);
    subtree.set(id, total);
    return total;
  };
  for (const c of expenseCats) compute(c.id, new Set());

  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];
  const emit = (cat: Category, depth: number) => {
    nodes.push({ id: `cat:${cat.id}`, label: cat.name, valueCents: subtree.get(cat.id) ?? 0, color: cat.color, depth, kind: "category", categoryId: cat.id });
    const kids = childrenOf(cat.id).filter((k) => (subtree.get(k.id) ?? 0) > 0);
    for (const k of kids) {
      links.push({ from: `cat:${cat.id}`, to: `cat:${k.id}`, valueCents: subtree.get(k.id) ?? 0 });
      emit(k, depth + 1);
    }
    const direct = budgetByCatAmount.get(cat.id) ?? 0;
    if (kids.length > 0 && direct > 0) {
      nodes.push({ id: `cat:${cat.id}:direct`, label: `${cat.name} (direct)`, valueCents: direct, color: cat.color, depth: depth + 1, kind: "category", categoryId: cat.id });
      links.push({ from: `cat:${cat.id}`, to: `cat:${cat.id}:direct`, valueCents: direct });
    }
  };

  const tops = childrenOf(null).filter((c) => (subtree.get(c.id) ?? 0) > 0);
  const allocated = tops.reduce((s, c) => s + (subtree.get(c.id) ?? 0), 0);

  nodes.push({ id: "income", label: "Planned income", valueCents: incomeCents, color: "#3ecf8e", depth: 0, kind: "income", categoryId: null });
  nodes.push({ id: "hub", label: "To allocate", valueCents: incomeCents, color: "#9397ab", depth: 1, kind: "hub", categoryId: null });
  links.push({ from: "income", to: "hub", valueCents: incomeCents });
  for (const c of tops) {
    links.push({ from: "hub", to: `cat:${c.id}`, valueCents: subtree.get(c.id) ?? 0 });
    emit(c, 2);
  }
  const unallocated = Math.max(0, incomeCents - allocated);
  if (unallocated > 0) {
    nodes.push({ id: "saved", label: "Unallocated / savings", valueCents: unallocated, color: "#43cfc0", depth: 2, kind: "saved", categoryId: null });
    links.push({ from: "hub", to: "saved", valueCents: unallocated });
  }
  return { nodes, links, allocated };
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
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15, minWidth: 150, textAlign: "center" }}>
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
              <span style={{ color: "var(--color-neutral-500)", fontSize: 18 }}>$</span>
              <input
                className="input"
                value={income}
                onChange={(e) => setIncome(e.target.value)}
                inputMode="decimal"
                placeholder="5000"
                style={{ width: 130, fontSize: 18, fontWeight: 600 }}
              />
            </div>
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 4 }}>Allocated</div>
            <div className="metric-value" style={{ fontSize: 20 }}>{formatCentsWhole(allocated)}</div>
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 4 }}>{over ? "Over budget" : "Unallocated / savings"}</div>
            <div
              className="metric-value"
              style={{ fontSize: 20, color: over ? "var(--color-negative)" : "var(--color-positive)" }}
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
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 2px", fontSize: 13 }}
    >
      <span
        aria-hidden
        style={{ width: 9, height: 9, borderRadius: "50%", background: category.color, flex: "none" }}
      />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {category.name}
      </span>
      <span style={{ color: "var(--color-neutral-500)" }}>$</span>
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
