import {
  formatCents,
  type BudgetListResponse,
  type Category,
  type PreIncome,
  type PreIncomeKind,
  type SankeyLink,
  type SankeyNode,
  type TaxEstimate,
  type TaxGroup,
} from "@vault/shared";
import type { SankeyCardLink, SankeyCardNode } from "./SankeyCard.js";

/**
 * Build the budget-planner Sankey with the same hierarchical structure as the
 * main cash-flow diagram — income → hub → the category tree (each node weighted
 * by its subtree's budgeted amount) → an "Unallocated / savings" leaf. Because
 * it walks the same `parentCategoryId` tree, editing the tree in Settings
 * reshapes this diagram and the cash-flow one identically.
 *
 * Lives here rather than in the planner page because the dashboard draws the
 * same plan diagram alongside the actual one.
 */
export function buildBudgetSankey(
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
    nodes.push({
      id: `cat:${cat.id}`,
      label: cat.name,
      valueCents: subtree.get(cat.id) ?? 0,
      color: cat.color,
      depth,
      kind: "category",
      categoryId: cat.id,
    });
    const kids = childrenOf(cat.id).filter((k) => (subtree.get(k.id) ?? 0) > 0);
    for (const k of kids) {
      links.push({ from: `cat:${cat.id}`, to: `cat:${k.id}`, valueCents: subtree.get(k.id) ?? 0 });
      emit(k, depth + 1);
    }
    const direct = budgetByCatAmount.get(cat.id) ?? 0;
    if (kids.length > 0 && direct > 0) {
      nodes.push({
        id: `cat:${cat.id}:direct`,
        label: `${cat.name} (direct)`,
        valueCents: direct,
        color: cat.color,
        depth: depth + 1,
        kind: "category",
        categoryId: cat.id,
      });
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

const TAX_BRANCH: Record<TaxGroup, { label: string; color: string }> = {
  pretax: { label: "Pre-tax savings", color: "#43cfc0" },
  federal: { label: "Federal tax", color: "#6f8ef2" },
  fica: { label: "Social Security & Medicare", color: "#b47ef0" },
  state: { label: "State tax", color: "#ec6a9c" },
  local: { label: "Local tax", color: "#d8b23c" },
  payroll: { label: "State payroll programs", color: "#4db6d0" },
};

export const PRE_INCOME_COLOR: Record<PreIncomeKind, string> = {
  tax: "#6f8ef2",
  pretax: "#43cfc0",
  deduction: "#d8b23c",
};

/** One monthly amount taken out of pay before it reaches income. */
export interface PreIncomeBranch {
  id: string;
  label: string;
  valueCents: number;
  color: string;
}

/**
 * What comes out before income, per month: the tax profile's estimated taxes
 * and pre-tax savings (unless the user turned them off because their own
 * items are the real figures), then the items they entered themselves.
 */
export function preIncomeBranches(estimate: TaxEstimate | null, pre: PreIncome | null): PreIncomeBranch[] {
  const out: PreIncomeBranch[] = [];
  if (estimate && (pre?.useEstimate ?? true)) {
    const groups = new Map<TaxGroup, number>();
    for (const l of estimate.lines) groups.set(l.group, (groups.get(l.group) ?? 0) + Math.max(0, l.amountCents));
    for (const [g, c] of groups) {
      const monthly = Math.round(c / 12);
      if (monthly > 0) out.push({ id: `tax:${g}`, label: TAX_BRANCH[g].label, valueCents: monthly, color: TAX_BRANCH[g].color });
    }
  }
  for (const item of pre?.items ?? []) {
    if (item.monthlyCents > 0) {
      out.push({ id: `pre:${item.id}`, label: item.name, valueCents: item.monthlyCents, color: item.color ?? PRE_INCOME_COLOR[item.kind] });
    }
  }
  return out;
}

const branchNode = (b: PreIncomeBranch): SankeyNode => ({
  id: b.id,
  label: b.label,
  valueCents: b.valueCents,
  color: b.color,
  depth: 1,
  kind: "category",
  categoryId: null,
  section: "taxes",
});

/**
 * The before-income add-on: start the budget Sankey from gross pay. "Planned
 * income" becomes "Gross pay", which splits into the monthly taxes and
 * deductions (leaves beside the hub) and the take-home that flows on into
 * the budget exactly as before. Gross is those branches + the planned
 * income, so the diagram still balances when planned income isn't synced.
 */
export function withTaxBranch(
  sankey: { nodes: SankeyNode[]; links: SankeyLink[] },
  branches: PreIncomeBranch[],
): { nodes: SankeyNode[]; links: SankeyLink[] } {
  const income = sankey.nodes.find((n) => n.id === "income");
  if (!income || !branches.length) return sankey;
  const gross = income.valueCents + branches.reduce((s, b) => s + b.valueCents, 0);
  const nodes = sankey.nodes.map((n) =>
    n.id === "income" ? { ...n, label: "Gross pay", valueCents: gross, color: "#6f8ef2" } : n.id === "hub" ? { ...n, label: "Take-home to allocate" } : n,
  );
  const links = [...sankey.links];
  for (const b of branches) {
    nodes.push(branchNode(b));
    links.push({ from: "income", to: b.id, valueCents: b.valueCents });
  }
  return { nodes, links };
}

/**
 * The before-income add-on for the actual cash-flow Sankey (real deposits and
 * spending): every column moves one to the right and a "Gross pay" column
 * goes first, feeding the month's taxes and deductions and the income that
 * actually arrived. Gross is income + those monthly amounts, so the diagram
 * balances; it's "(est.)" whenever any of them come from the estimate.
 */
export function withGrossBranch(
  sankey: { nodes: SankeyNode[]; links: SankeyLink[] },
  branches: PreIncomeBranch[],
): { nodes: SankeyNode[]; links: SankeyLink[] } {
  const incomes = sankey.nodes.filter((n) => n.depth === 0 && n.valueCents > 0);
  if (!incomes.length || !branches.length) return sankey;
  const gross = incomes.reduce((s, n) => s + n.valueCents, 0) + branches.reduce((s, b) => s + b.valueCents, 0);
  const estimated = branches.some((b) => b.id.startsWith("tax:"));
  const nodes: SankeyNode[] = [
    { id: "gross", label: estimated ? "Gross pay (est.)" : "Gross pay", valueCents: gross, color: "#6f8ef2", depth: 0, kind: "income", categoryId: null, section: "taxes" },
    ...branches.map(branchNode),
    ...sankey.nodes.map((n) => ({ ...n, depth: n.depth + 1 })),
  ];
  const links: SankeyLink[] = [
    ...branches.map((b) => ({ from: "gross", to: b.id, valueCents: b.valueCents })),
    ...incomes.map((n) => ({ from: "gross", to: n.id, valueCents: n.valueCents })),
    ...sankey.links,
  ];
  return { nodes, links };
}

/** One category's month, as compared on the budget-vs-actual Sankey. */
export interface BudgetVsActualRow {
  /** Null for uncategorized spending. */
  categoryId: string | null;
  label: string;
  color: string;
  budgetedCents: number;
  actualCents: number;
}

export interface BudgetVsActual {
  rows: BudgetVsActualRow[];
  nodes: SankeyCardNode[];
  links: SankeyCardLink[];
  budgetedCents: number;
  actualCents: number;
  /** Spending beyond budgets, unbudgeted categories included. */
  overCents: number;
  /** Budget left unspent, added up per category. */
  unspentCents: number;
}

const OVER_COLOR = "#ec6a6a";
const UNSPENT_COLOR = "#43cfc0";
const BUDGETED_COLOR = "#6f8ef2";
const ACTUAL_COLOR = "#9397ab";

/**
 * Budget and actual on one Sankey, and it balances. The left column is where
 * each category's money was supposed to come from: its budget, plus an "Over
 * budget" stream for anything beyond it. The right column is what happened to
 * it: spent, or still unspent. So a category's left ribbon is its budget and its
 * right ribbon (to "Actual spent") is its spending, side by side at the same
 * scale, and Budgeted + Over budget = Actual spent + Left unspent to the cent.
 *
 * Spending in a sub-category with no budget of its own counts against the
 * nearest budgeted parent, because that is the budget meant to cover it. Income
 * categories are left out unless they were given a budget.
 */
export function buildBudgetVsActual(
  budgets: Pick<BudgetListResponse, "budgets" | "unbudgetedSpending">,
  categories: Category[],
): BudgetVsActual {
  const catById = new Map(categories.map((c) => [c.id, c]));
  const budgeted = new Map(budgets.budgets.map((b) => [b.categoryId, b.amountCents]));

  const ownerOf = (categoryId: string): string => {
    const seen = new Set<string>();
    let id: string | null | undefined = categoryId;
    while (id && !seen.has(id)) {
      if (budgeted.has(id)) return id;
      seen.add(id);
      id = catById.get(id)?.parentCategoryId;
    }
    return categoryId;
  };

  const actual = new Map<string | null, number>();
  const addSpend = (categoryId: string | null, cents: number) => {
    const owner = categoryId ? ownerOf(categoryId) : null;
    actual.set(owner, (actual.get(owner) ?? 0) + cents);
  };
  for (const b of budgets.budgets) addSpend(b.categoryId, b.spentCents);
  for (const u of budgets.unbudgetedSpending ?? []) {
    if (u.categoryId && catById.get(u.categoryId)?.kind === "income") continue;
    addSpend(u.categoryId, u.spentCents);
  }

  const ids = new Set<string | null>([...budgeted.keys(), ...actual.keys()]);
  const rows: BudgetVsActualRow[] = [...ids]
    .map((id) => {
      const cat = id ? catById.get(id) : undefined;
      return {
        categoryId: id,
        label: id ? (cat?.name ?? "Unknown category") : "Uncategorized",
        color: cat?.color ?? ACTUAL_COLOR,
        budgetedCents: id ? (budgeted.get(id) ?? 0) : 0,
        actualCents: actual.get(id) ?? 0,
      };
    })
    .filter((r) => r.budgetedCents > 0 || r.actualCents > 0)
    .sort(
      (a, b) =>
        Math.max(b.budgetedCents, b.actualCents) - Math.max(a.budgetedCents, a.actualCents) ||
        a.label.localeCompare(b.label),
    );

  const nodes: SankeyCardNode[] = [];
  const links: SankeyCardLink[] = [];
  let budgetedCents = 0;
  let actualCents = 0;
  let overCents = 0;
  let unspentCents = 0;
  for (const r of rows) {
    const id = `cat:${r.categoryId ?? "none"}`;
    const over = Math.max(0, r.actualCents - r.budgetedCents);
    const unspent = Math.max(0, r.budgetedCents - r.actualCents);
    budgetedCents += r.budgetedCents;
    actualCents += r.actualCents;
    overCents += over;
    unspentCents += unspent;
    nodes.push({
      id,
      label: r.label,
      valueCents: Math.max(r.budgetedCents, r.actualCents),
      color: r.color,
      depth: 1,
      kind: "category",
      categoryId: r.categoryId,
      section: "spending",
      caption: `${r.budgetedCents > 0 ? `${formatCents(r.budgetedCents)} budgeted` : "No budget"} · ${formatCents(r.actualCents)} actual`,
      comparison: { budgetedCents: r.budgetedCents, actualCents: r.actualCents },
    });
    if (r.budgetedCents > 0) links.push({ from: "budgeted", to: id, valueCents: r.budgetedCents, color: r.color });
    if (over > 0) links.push({ from: "over", to: id, valueCents: over, color: OVER_COLOR });
    if (r.actualCents > 0) links.push({ from: id, to: "actual", valueCents: r.actualCents, color: r.color });
    if (unspent > 0) links.push({ from: id, to: "unspent", valueCents: unspent, color: UNSPENT_COLOR });
  }

  const total = (id: string, label: string, valueCents: number, color: string, depth: number, note: string): void => {
    if (valueCents <= 0) return;
    nodes.push({
      id,
      label,
      valueCents,
      color,
      depth,
      kind: "category",
      categoryId: null,
      caption: formatCents(valueCents),
      note,
    });
  };
  total("budgeted", "Budgeted", budgetedCents, BUDGETED_COLOR, 0, "Everything you budgeted this month, across all categories.");
  total("over", "Over budget", overCents, OVER_COLOR, 0, "Spending beyond each category's budget, including categories with no budget at all.");
  total("actual", "Actual spent", actualCents, ACTUAL_COLOR, 2, "Everything spent this month, across all categories.");
  total("unspent", "Left unspent", unspentCents, UNSPENT_COLOR, 2, "Budget not spent yet, added up across the categories still under budget.");

  return { rows, nodes, links, budgetedCents, actualCents, overCents, unspentCents };
}
