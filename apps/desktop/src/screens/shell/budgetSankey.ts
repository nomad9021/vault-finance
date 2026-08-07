import type { Category, SankeyLink, SankeyNode } from "@vault/shared";

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
