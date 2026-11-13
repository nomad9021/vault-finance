import { describe, expect, it } from "vitest";
import { currentPeriod, daysInMonth, monthlyAmountCents, weekBounds } from "../src/modules/budgets/period.js";

/**
 * Weekly budgets reset every week but still have to add up in month views,
 * so the week maths and the monthly equivalent are pinned here with fixed
 * dates (2026-11-13 is a Friday).
 */
describe("budget periods", () => {
  it("finds the week for either week start", () => {
    expect(weekBounds("2026-11-13", "monday")).toEqual({ start: "2026-11-09", end: "2026-11-16" });
    expect(weekBounds("2026-11-13", "sunday")).toEqual({ start: "2026-11-08", end: "2026-11-15" });
    // The first day of the week is its own start.
    expect(weekBounds("2026-11-09", "monday").start).toBe("2026-11-09");
    expect(weekBounds("2026-11-08", "sunday").start).toBe("2026-11-08");
    // Sunday belongs to the week that started the Monday before.
    expect(weekBounds("2026-11-15", "monday")).toEqual({ start: "2026-11-09", end: "2026-11-16" });
  });

  it("crosses month and year boundaries", () => {
    expect(weekBounds("2026-12-31", "monday")).toEqual({ start: "2026-12-28", end: "2027-01-04" });
    expect(weekBounds("2027-03-01", "monday")).toEqual({ start: "2027-03-01", end: "2027-03-08" });
  });

  it("counts days per month, leap years included", () => {
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(daysInMonth("2026-11")).toBe(30);
    expect(daysInMonth("2026-12")).toBe(31);
  });

  it("converts weekly budgets to a monthly equivalent", () => {
    expect(monthlyAmountCents({ amountCents: 10_000, period: "weekly" }, "2026-11")).toBe(42_857);
    expect(monthlyAmountCents({ amountCents: 10_000, period: "weekly" }, "2026-02")).toBe(40_000);
    expect(monthlyAmountCents({ amountCents: 10_000, period: "monthly" }, "2026-11")).toBe(10_000);
  });

  it("picks this week for the current month and the last week for past months", () => {
    expect(currentPeriod("weekly", "2026-11", "monday", "2026-11-13")).toEqual({ start: "2026-11-09", end: "2026-11-16" });
    expect(currentPeriod("weekly", "2026-10", "monday", "2026-11-13")).toEqual({ start: "2026-10-26", end: "2026-11-02" });
    expect(currentPeriod("monthly", "2026-11", "monday", "2026-11-13")).toEqual({ start: "2026-11-01", end: "2026-12-01" });
    expect(currentPeriod("monthly", "2026-12", "sunday", "2026-11-13")).toEqual({ start: "2026-12-01", end: "2027-01-01" });
  });
});
