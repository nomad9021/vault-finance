import type { Category, SankeyLink, SankeyNode, TaxEstimate, TaxGroup } from "@vault/shared";

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

/**
 * The tax add-on: start the budget Sankey from gross pay. "Planned income"
 * becomes "Gross pay", which splits into the monthly taxes and pre-tax
 * savings (leaves beside the hub) and the take-home that flows on into the
 * budget exactly as before. Gross is taxes + pre-tax + the planned income,
 * so the diagram still balances when planned income isn't synced.
 */
export function withTaxBranch(
  sankey: { nodes: SankeyNode[]; links: SankeyLink[] },
  estimate: TaxEstimate,
): { nodes: SankeyNode[]; links: SankeyLink[] } {
  const groups = new Map<TaxGroup, number>();
  for (const l of estimate.lines) groups.set(l.group, (groups.get(l.group) ?? 0) + Math.max(0, l.amountCents));
  const monthly = [...groups].map(([g, c]) => [g, Math.round(c / 12)] as const).filter(([, c]) => c > 0);
  const income = sankey.nodes.find((n) => n.id === "income");
  if (!income || !monthly.length) return sankey;
  const gross = income.valueCents + monthly.reduce((s, [, c]) => s + c, 0);
  const nodes = sankey.nodes.map((n) =>
    n.id === "income" ? { ...n, label: "Gross pay", valueCents: gross, color: "#6f8ef2" } : n.id === "hub" ? { ...n, label: "Take-home to allocate" } : n,
  );
  const links = [...sankey.links];
  for (const [g, c] of monthly) {
    nodes.push({ id: `tax:${g}`, label: TAX_BRANCH[g].label, valueCents: c, color: TAX_BRANCH[g].color, depth: 1, kind: "category", categoryId: null });
    links.push({ from: "income", to: `tax:${g}`, valueCents: c });
  }
  return { nodes, links };
}
