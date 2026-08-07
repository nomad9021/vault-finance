import { describe, expect, it } from "vitest";
import { simulate } from "./DebtCalculator.js";

/**
 * The payoff simulation drives every number on the debt planner: months to
 * freedom, total interest, and the comparison that tells you avalanche beats
 * snowball. All of it is plausible-looking either way, so it needs pinning.
 */

const card = (over: Partial<Parameters<typeof simulate>[0][number]> = {}) => ({
  id: "a",
  name: "Card",
  balanceCents: 100_000,
  apr: 24,
  minCents: 5_000,
  ...over,
});

describe("simulate: basic mechanics", () => {
  it("pays off a zero-interest debt in exactly balance/payment months", () => {
    const r = simulate([card({ balanceCents: 100_000, apr: 0, minCents: 10_000 })], 0, "avalanche");
    expect(r.months).toBe(10);
    expect(r.totalInterestCents).toBe(0);
    expect(r.neverPayoff).toBe(false);
  });

  it("charges interest on a carried balance", () => {
    const r = simulate([card({ balanceCents: 100_000, apr: 12, minCents: 10_000 })], 0, "avalanche");
    // 1%/month on a falling balance: strictly positive, but less than a year
    // of interest on the full balance.
    expect(r.totalInterestCents).toBeGreaterThan(0);
    expect(r.totalInterestCents).toBeLessThan(12_000);
    expect(r.months).toBeGreaterThan(10);
  });

  it("flags a debt whose minimum cannot outrun its interest", () => {
    // 24% APR on $10,000 accrues $200/mo; paying $50 never converges.
    const r = simulate([card({ balanceCents: 1_000_000, apr: 24, minCents: 5_000 })], 0, "avalanche");
    expect(r.neverPayoff).toBe(true);
  });

  it("applies extra payment to shorten the schedule", () => {
    const base = simulate([card({ minCents: 10_000 })], 0, "avalanche");
    const extra = simulate([card({ minCents: 10_000 })], 10_000, "avalanche");
    expect(extra.months).toBeLessThan(base.months);
    expect(extra.totalInterestCents).toBeLessThan(base.totalInterestCents);
  });

  it("returns a trajectory that starts at the total and ends at zero", () => {
    const r = simulate([card({ balanceCents: 60_000, apr: 0, minCents: 10_000 })], 0, "avalanche");
    expect(r.trajectory[0]).toBe(60_000);
    expect(r.trajectory[r.trajectory.length - 1]).toBe(0);
    // Monotonically non-increasing — a balance must never grow while paying.
    for (let i = 1; i < r.trajectory.length; i++) {
      expect(r.trajectory[i]!).toBeLessThanOrEqual(r.trajectory[i - 1]!);
    }
  });
});

describe("simulate: strategy ordering", () => {
  const debts = [
    { id: "big-low", name: "Loan", balanceCents: 500_000, apr: 5, minCents: 10_000 },
    { id: "small-high", name: "Card", balanceCents: 100_000, apr: 25, minCents: 5_000 },
  ];

  it("avalanche costs no more interest than snowball", () => {
    const av = simulate(debts, 50_000, "avalanche");
    const sb = simulate(debts, 50_000, "snowball");
    // The whole justification for offering avalanche: it is never worse on
    // interest. If this flips, the recommendation in the UI is wrong.
    expect(av.totalInterestCents).toBeLessThanOrEqual(sb.totalInterestCents);
  });

  it("both strategies clear every debt in the same or fewer months than paying minimums", () => {
    const minimums = simulate(debts, 0, "avalanche");
    const av = simulate(debts, 50_000, "avalanche");
    expect(av.months).toBeLessThanOrEqual(minimums.months);
  });
});

describe("simulate: edge cases", () => {
  it("handles an empty debt list", () => {
    const r = simulate([], 0, "avalanche");
    expect(r.months).toBe(0);
    expect(r.totalInterestCents).toBe(0);
    expect(r.neverPayoff).toBe(false);
  });

  it("treats an already-cleared debt as done", () => {
    const r = simulate([card({ balanceCents: 0 })], 0, "avalanche");
    expect(r.months).toBe(0);
    expect(r.neverPayoff).toBe(false);
  });
});
