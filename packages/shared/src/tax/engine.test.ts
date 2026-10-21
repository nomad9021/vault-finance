import { describe, expect, it } from "vitest";
import { bracketTax, estimateTaxes, type TaxInput } from "./engine.js";

/** Expected values are worked by hand from IRS Rev. Proc. 2025-32 and the state tables. */
const one = (state: string, gross: number, extra: Partial<TaxInput> = {}, earner: object = {}) =>
  estimateTaxes({ filingStatus: "single", state, earners: [{ name: "A", grossAnnualCents: gross * 100, ...earner }], ...extra });
const line = (e: ReturnType<typeof estimateTaxes>, id: string) => (e.lines.find((l) => l.id === id)?.amountCents ?? 0) / 100;

describe("tax engine (2026)", () => {
  it("brackets: matches the IRS table's own running totals", () => {
    // Table 3: over $50,400 → $5,800 plus 22% of the excess.
    expect(bracketTax([[10, 0], [12, 12_400], [22, 50_400], [24, 105_700]], 83_900).tax).toBeCloseTo(5_800 + 0.22 * 33_500, 6);
  });

  it("single in Colorado on $100k", () => {
    const e = one("CO", 100_000);
    expect(line(e, "federal")).toBe(13_170); // 16,100 std → 83,900 taxable
    expect(line(e, "social_security")).toBe(6_200);
    expect(line(e, "medicare")).toBe(1_450);
    expect(line(e, "state")).toBe(3_691.6); // 4.4% of 83,900
    expect(e.takeHomeCents / 100).toBe(75_488.4);
    expect(e.marginalFederalPct).toBe(22);
  });

  it("Texas has no state tax", () => {
    const e = one("TX", 50_000);
    expect(line(e, "federal")).toBe(3_820);
    expect(line(e, "state")).toBe(0);
    expect(e.takeHomeCents / 100).toBe(50_000 - 3_820 - 3_825);
  });

  it("Social Security stops at the wage base; extra Medicare over $200k", () => {
    const e = one("FL", 250_000);
    expect(line(e, "social_security")).toBe(11_439);
    expect(line(e, "medicare")).toBe(3_625 + 450);
  });

  it("Maryland county tax uses Maryland taxable income", () => {
    const e = one("MD", 80_000, { locality: "md_montgomery" });
    // 80,000 − 3,350 std − 3,200 exemption = 73,450
    expect(line(e, "state")).toBeCloseTo(20 + 30 + 40 + 0.0475 * 70_450, 1);
    expect(line(e, "local")).toBeCloseTo(0.032 * 73_450, 2);
  });

  it("New York City brackets on NY taxable income, Yonkers as a share of state tax", () => {
    const nyc = one("NY", 100_000, { locality: "nyc" }); // 100,000 − 8,000 = 92,000
    expect(line(nyc, "local")).toBeCloseTo(12_000 * 0.03078 + 13_000 * 0.03762 + 25_000 * 0.03819 + 42_000 * 0.03876, 2);
    const yk = one("NY", 100_000, { locality: "yonkers" });
    expect(line(yk, "local")).toBeCloseTo(line(yk, "state") * 0.1675, 1);
    expect(line(nyc, "ny_pfl")).toBe(411.91); // capped
    expect(line(nyc, "ny_dbl")).toBe(31.2);
  });

  it("401(k) cuts federal tax but still counts in Pennsylvania; Philadelphia taxes wages", () => {
    const e = one("PA", 100_000, { locality: "philadelphia" }, { retirementPct: 10 });
    expect(line(e, "retirement")).toBe(10_000);
    expect(line(e, "federal")).toBe(bracketTax([[10, 0], [12, 12_400], [22, 50_400]], 73_900).tax);
    expect(line(e, "state")).toBe(3_070); // 3.07% of the full 100,000
    expect(line(e, "local")).toBe(3_740);
    expect(line(e, "social_security")).toBe(6_200); // 401(k) doesn't skip FICA
  });

  it("health premiums skip FICA too", () => {
    const e = one("TX", 60_000, {}, { healthPremiumCents: 300_000 });
    expect(line(e, "social_security")).toBe(0.062 * 57_000);
  });

  it("married couple in California with kids: SDI, credit, per-earner split", () => {
    const e = estimateTaxes({
      filingStatus: "married_joint",
      state: "CA",
      dependents: 2,
      earners: [
        { name: "A", grossAnnualCents: 15_000_000, retirementPct: 10 },
        { name: "B", grossAnnualCents: 9_000_000 },
      ],
    });
    expect(line(e, "ca_sdi")).toBe(3_120);
    const fedBefore = bracketTax([[10, 0], [12, 24_800], [22, 100_800], [24, 211_400]], 240_000 - 15_000 - 32_200).tax;
    expect(line(e, "federal")).toBeCloseTo(fedBefore - 4_400, 2);
    expect(e.perEarner.map((p) => p.grossCents)).toEqual([15_000_000, 9_000_000]);
    const sum = e.perEarner.reduce((s, p) => s + p.takeHomeCents, 0);
    expect(Math.abs(sum - e.takeHomeCents)).toBeLessThanOrEqual(2);
  });

  it("Washington wages aren't taxed; unconfirmed payroll programs are flagged", () => {
    const e = one("WA", 90_000);
    expect(line(e, "state")).toBe(0);
    expect(e.notes.join(" ")).toMatch(/paid-leave/);
    expect(line(one("WA", 90_000, { otherPayrollPct: 0.8 }), "payroll_other")).toBe(720);
  });

  it("rejects unknown places", () => {
    expect(() => one("ZZ", 1)).toThrow(/Unknown state/);
    expect(() => one("TX", 1, { locality: "nyc" })).toThrow(/in NY/);
  });
});
