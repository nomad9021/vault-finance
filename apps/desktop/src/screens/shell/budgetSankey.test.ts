import type { Category } from "@vault/shared";
import { describe, expect, it } from "vitest";
import { estimateTaxes } from "@vault/shared";
import { buildBudgetSankey, withGrossBranch, withTaxBranch } from "./budgetSankey.js";

/**
 * The budget Sankey must conserve money: every cent of planned income leaves
 * the hub exactly once, into a category subtree or into savings. A leak here
 * draws a diagram that looks fine and quietly misstates the plan.
 */

const cat = (id: string, name: string, parent: string | null = null, sortOrder = 0): Category =>
  ({
    id,
    name,
    color: "#888888",
    parentCategoryId: parent,
    sortOrder,
    kind: "expense",
    icon: null,
    isSystem: false,
  }) as Category;

function sumLinksFrom(links: { from: string; valueCents: number }[], from: string): number {
  return links.filter((l) => l.from === from).reduce((s, l) => s + l.valueCents, 0);
}

describe("buildBudgetSankey", () => {
  it("routes all income out of the hub, allocated plus savings", () => {
    const cats = [cat("g", "Groceries"), cat("t", "Transport")];
    const budgets = new Map([
      ["g", 40_000],
      ["t", 20_000],
    ]);
    const { links, allocated } = buildBudgetSankey(100_000, cats, budgets);

    expect(allocated).toBe(60_000);
    // Nothing may vanish between income and its destinations.
    expect(sumLinksFrom(links, "hub")).toBe(100_000);
    expect(sumLinksFrom(links, "income")).toBe(100_000);
  });

  it("emits an unallocated/savings leaf for the remainder", () => {
    const { nodes } = buildBudgetSankey(100_000, [cat("g", "Groceries")], new Map([["g", 30_000]]));
    const saved = nodes.find((n) => n.id === "saved");
    expect(saved?.valueCents).toBe(70_000);
  });

  it("omits the savings leaf when income is fully allocated", () => {
    const { nodes } = buildBudgetSankey(50_000, [cat("g", "Groceries")], new Map([["g", 50_000]]));
    expect(nodes.find((n) => n.id === "saved")).toBeUndefined();
  });

  it("never emits negative savings when over-allocated", () => {
    // Allocating more than you earn is a real state the planner allows; the
    // diagram must not try to draw a negative ribbon.
    const { nodes, allocated } = buildBudgetSankey(
      50_000,
      [cat("g", "Groceries")],
      new Map([["g", 80_000]]),
    );
    expect(allocated).toBe(80_000);
    expect(nodes.find((n) => n.id === "saved")).toBeUndefined();
  });

  it("rolls child budgets up into the parent's subtree total", () => {
    const cats = [cat("f", "Food"), cat("g", "Groceries", "f"), cat("d", "Dining", "f")];
    const budgets = new Map([
      ["g", 30_000],
      ["d", 10_000],
    ]);
    const { nodes } = buildBudgetSankey(100_000, cats, budgets);
    expect(nodes.find((n) => n.id === "cat:f")?.valueCents).toBe(40_000);
  });

  it("splits a parent's own allocation into a (direct) child node", () => {
    const cats = [cat("f", "Food"), cat("g", "Groceries", "f")];
    const budgets = new Map([
      ["f", 5_000],
      ["g", 30_000],
    ]);
    const { nodes } = buildBudgetSankey(100_000, cats, budgets);
    expect(nodes.find((n) => n.id === "cat:f")?.valueCents).toBe(35_000);
    expect(nodes.find((n) => n.id === "cat:f:direct")?.valueCents).toBe(5_000);
  });

  it("drops categories with no allocation", () => {
    const cats = [cat("g", "Groceries"), cat("z", "Unused")];
    const { nodes } = buildBudgetSankey(100_000, cats, new Map([["g", 10_000]]));
    expect(nodes.find((n) => n.id === "cat:z")).toBeUndefined();
  });

  it("survives a cyclic parent reference without hanging", () => {
    // Defensive: a corrupt tree must not spin forever behind the UI.
    const a = cat("a", "A", "b");
    const b = cat("b", "B", "a");
    const { nodes } = buildBudgetSankey(10_000, [a, b], new Map([["a", 1_000]]));
    expect(Array.isArray(nodes)).toBe(true);
  });

  it("produces an empty plan for zero income and no budgets", () => {
    const { links, allocated } = buildBudgetSankey(0, [], new Map());
    expect(allocated).toBe(0);
    expect(sumLinksFrom(links, "hub")).toBe(0);
  });
});

describe("withTaxBranch", () => {
  const estimate = estimateTaxes({ filingStatus: "single", state: "CO", earners: [{ name: "A", grossAnnualCents: 10_000_000, retirementPct: 5 }] });
  const takeHome = Math.round(estimate.takeHomeCents / 12);
  const base = buildBudgetSankey(takeHome, [cat("g", "Groceries")], new Map([["g", 60_000]]));

  it("starts from gross pay and branches taxes off beside the take-home hub", () => {
    const out = withTaxBranch(base, estimate);
    const gross = out.nodes.find((n) => n.id === "income")!;
    expect(gross.label).toBe("Gross pay");
    const leaves = out.nodes.filter((n) => n.id.startsWith("tax:"));
    expect(leaves.map((n) => n.id).sort()).toEqual(["tax:federal", "tax:fica", "tax:pretax", "tax:state"]);
    expect(leaves.every((n) => n.depth === 1)).toBe(true);
    // Everything leaving gross adds back up to it.
    const out1 = out.links.filter((l) => l.from === "income").reduce((s, l) => s + l.valueCents, 0);
    expect(out1).toBe(gross.valueCents);
    expect(Math.abs(gross.valueCents - Math.round(10_000_000 / 12))).toBeLessThanOrEqual(6);
  });

  it("leaves the diagram alone without an income node", () => {
    const empty = { nodes: [], links: [] };
    expect(withTaxBranch(empty, estimate)).toBe(empty);
  });
});

describe("withGrossBranch", () => {
  const estimate = estimateTaxes({ filingStatus: "single", state: "MI", locality: "grand_rapids", earners: [{ name: "Me", grossAnnualCents: 6_000_000 }] });
  // A tiny actual diagram: one deposit account → hub → one category.
  const actual = {
    nodes: [
      { id: "income:acct", label: "Checking", valueCents: 400_000, color: "#3ecf8e", depth: 0, kind: "income" as const, categoryId: null },
      { id: "hub", label: "Total income", valueCents: 400_000, color: "#9397ab", depth: 1, kind: "hub" as const, categoryId: null },
      { id: "cat:g", label: "Groceries", valueCents: 400_000, color: "#ff0", depth: 2, kind: "category" as const, categoryId: "g" },
    ],
    links: [
      { from: "income:acct", to: "hub", valueCents: 400_000 },
      { from: "hub", to: "cat:g", valueCents: 400_000 },
    ],
  };

  it("puts gross pay first, with taxes beside the real income, and shifts the rest right", () => {
    const out = withGrossBranch(actual, estimate);
    const gross = out.nodes.find((n) => n.id === "gross")!;
    expect(gross).toMatchObject({ depth: 0, section: "taxes" });
    expect(out.nodes.find((n) => n.id === "income:acct")!.depth).toBe(1);
    expect(out.nodes.find((n) => n.id === "cat:g")!.depth).toBe(3);
    const taxes = out.nodes.filter((n) => n.id.startsWith("tax:"));
    expect(taxes.map((n) => n.id).sort()).toEqual(["tax:federal", "tax:fica", "tax:local", "tax:state"]);
    const fromGross = out.links.filter((l) => l.from === "gross").reduce((s, l) => s + l.valueCents, 0);
    expect(fromGross).toBe(gross.valueCents);
    expect(gross.valueCents - 400_000).toBe(taxes.reduce((s, n) => s + n.valueCents, 0));
  });

  it("does nothing without income", () => {
    const empty = { nodes: [], links: [] };
    expect(withGrossBranch(empty, estimate)).toBe(empty);
  });
});
