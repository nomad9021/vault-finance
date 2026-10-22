import type { Category, PreIncome, PreIncomeKind, SankeyLink, SankeyNode, TaxEstimate, TaxGroup } from "@vault/shared";

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
