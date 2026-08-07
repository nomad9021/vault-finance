import { describe, expect, it } from "vitest";
import { project } from "./TrendChart.js";

/**
 * `project` draws the dashed forward line on every trend card and produces the
 * "projected $X" figure beside it. It is a least-squares fit, so a sign or
 * off-by-one error still yields a smooth, believable-looking line.
 */
describe("project", () => {
  it("continues a perfectly linear series exactly", () => {
    expect(project([0, 10, 20, 30], 3)).toEqual([40, 50, 60]);
  });

  it("continues a falling series downward", () => {
    expect(project([100, 90, 80], 2)).toEqual([70, 60]);
  });

  it("holds a flat series flat", () => {
    expect(project([50, 50, 50, 50], 3)).toEqual([50, 50, 50]);
  });

  it("repeats the only value when given a single point", () => {
    // One observation carries no slope; inventing a trend would be a lie.
    expect(project([42], 3)).toEqual([42, 42, 42]);
  });

  it("returns zeroes for an empty series", () => {
    expect(project([], 2)).toEqual([0, 0]);
  });

  it("returns exactly `count` points", () => {
    expect(project([1, 2, 3], 5)).toHaveLength(5);
    expect(project([1, 2, 3], 0)).toHaveLength(0);
  });

  it("returns integers — these are cents and must not carry fractions", () => {
    for (const v of project([0, 7, 11, 18], 4)) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("fits a best line through noise rather than following the last point", () => {
    // Upward overall despite a dip at the end: the fit should still rise.
    const [next] = project([0, 10, 20, 30, 25], 1);
    expect(next!).toBeGreaterThan(25);
  });

  it("handles negative values (net worth can be underwater)", () => {
    expect(project([-30, -20, -10], 2)).toEqual([0, 10]);
  });
});
