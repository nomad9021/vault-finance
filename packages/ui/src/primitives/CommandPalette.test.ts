import { describe, expect, it } from "vitest";
import { filterCommands, type Command } from "./CommandPalette.js";

const cmd = (label: string, group = "Money", keywords?: string): Command => ({
  id: label,
  label,
  group,
  ...(keywords ? { keywords } : {}),
  run: () => {},
});

const all = [
  cmd("Dashboard", "Home", "overview net worth"),
  cmd("Accounts", "Money", "balances checking savings"),
  cmd("Transactions", "Money", "spending ledger"),
  cmd("Budgets", "Plan", "budget planner allocate"),
  cmd("Savings Goals", "Grow", "targets"),
  cmd("Settings", "More", "preferences theme"),
];

describe("filterCommands", () => {
  it("returns everything for an empty query", () => {
    expect(filterCommands(all, "")).toHaveLength(all.length);
    expect(filterCommands(all, "   ")).toHaveLength(all.length);
  });

  it("ranks a prefix match first", () => {
    // "Budgets" must beat "Accounts", which only matches via its keywords.
    expect(filterCommands(all, "bud")[0]?.label).toBe("Budgets");
  });

  it("matches on keywords, not just the label", () => {
    const labels = filterCommands(all, "checking").map((c) => c.label);
    expect(labels).toContain("Accounts");
  });

  it("finds a page by its old name via keywords", () => {
    // "Budget Planner" was a separate page; typing it must still land you
    // somewhere sensible now that it's a tab inside Budgets.
    const labels = filterCommands(all, "planner").map((c) => c.label);
    expect(labels).toContain("Budgets");
  });

  it("supports subsequence matching on the label", () => {
    // "svgl" -> "SaVinGs goaLs"
    const labels = filterCommands(all, "svgl").map((c) => c.label);
    expect(labels).toContain("Savings Goals");
  });

  it("is case-insensitive", () => {
    expect(filterCommands(all, "DASH")[0]?.label).toBe("Dashboard");
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(filterCommands(all, "zzzzqqq")).toEqual([]);
  });

  it("does not throw on regex metacharacters", () => {
    // The query goes into a RegExp for word-boundary scoring.
    expect(() => filterCommands(all, "a(b")).not.toThrow();
    expect(() => filterCommands(all, "*")).not.toThrow();
    expect(() => filterCommands(all, "[")).not.toThrow();
  });
});
