import { describe, expect, it } from "vitest";
import { formatCents, formatCentsWhole, parseAmountToCents } from "./money.js";

/**
 * Everything over the wire is integer cents. These are the only places cents
 * become display strings and back, so a rounding slip here misstates money
 * everywhere at once.
 */

describe("parseAmountToCents", () => {
  it("parses plain and decimal amounts", () => {
    expect(parseAmountToCents("12")).toBe(1200);
    expect(parseAmountToCents("12.34")).toBe(1234);
    expect(parseAmountToCents("0.05")).toBe(5);
  });

  it("strips currency symbols, commas and spaces", () => {
    expect(parseAmountToCents("$1,234.56")).toBe(123456);
    expect(parseAmountToCents(" 1 234 ")).toBe(123400);
  });

  it("handles negatives, including the unicode minus the UI renders", () => {
    expect(parseAmountToCents("-3.50")).toBe(-350);
    expect(parseAmountToCents("−3.50")).toBe(-350);
  });

  it("rejects anything that isn't a clean number", () => {
    expect(parseAmountToCents("")).toBeNull();
    expect(parseAmountToCents("abc")).toBeNull();
    expect(parseAmountToCents("1.2.3")).toBeNull();
    // More than two decimal places isn't a cent amount.
    expect(parseAmountToCents("1.234")).toBeNull();
  });

  it("does not lose a cent to float error", () => {
    // 0.1 + 0.2 territory: naive parseFloat*100 gives 1109.9999999999998.
    expect(parseAmountToCents("11.10")).toBe(1110);
    expect(parseAmountToCents("1.15")).toBe(115);
    expect(parseAmountToCents("8.87")).toBe(887);
  });

  it("round-trips through formatCents", () => {
    for (const cents of [0, 5, 100, 123456, -4200]) {
      expect(parseAmountToCents(formatCents(cents))).toBe(cents);
    }
  });
});

describe("formatCents", () => {
  it("always shows two decimal places", () => {
    expect(formatCents(100)).toMatch(/1\.00/);
    expect(formatCents(5)).toMatch(/0\.05/);
  });

  it("marks negatives", () => {
    expect(formatCents(-100)).toMatch(/^−/);
  });

  it("adds an explicit sign when asked", () => {
    expect(formatCents(100, { signed: true })).toMatch(/^\+/);
    expect(formatCents(-100, { signed: true })).toMatch(/^−/);
  });
});

describe("formatCentsWhole", () => {
  it("drops the decimals", () => {
    expect(formatCentsWhole(123456)).not.toMatch(/\./);
  });

  it("rounds rather than truncates", () => {
    // $12.60 must read as $13, not $12 — a truncating stat card understates
    // every figure on the dashboard.
    expect(formatCentsWhole(1260)).toMatch(/13/);
    expect(formatCentsWhole(1240)).toMatch(/12/);
  });

  it("marks negatives", () => {
    expect(formatCentsWhole(-5000)).toMatch(/^−/);
  });
});
