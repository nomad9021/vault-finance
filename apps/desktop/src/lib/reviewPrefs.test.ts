import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_PREFS,
  REVIEW_SLIDES,
  parseReviewPrefs,
  periodStart,
  shiftPeriod,
} from "./reviewPrefs.js";

describe("parseReviewPrefs", () => {
  it("falls back to defaults on missing or garbled input", () => {
    expect(parseReviewPrefs(null)).toEqual(DEFAULT_REVIEW_PREFS);
    expect(parseReviewPrefs("{nope")).toEqual(DEFAULT_REVIEW_PREFS);
  });

  it("keeps the saved order, drops unknown slides, appends new ones", () => {
    const prefs = parseReviewPrefs(
      JSON.stringify({ slides: [{ id: "goals", enabled: false }, { id: "bogus" }, { id: "overview" }] }),
    );
    expect(prefs.slides.slice(0, 2)).toEqual([
      { id: "goals", enabled: false },
      { id: "overview", enabled: true },
    ]);
    expect(prefs.slides).toHaveLength(REVIEW_SLIDES.length);
  });
});

describe("period dates", () => {
  const wed = new Date(Date.UTC(2026, 9, 21)); // Wed 21 Oct 2026

  it("finds the week start for Monday and Sunday weeks", () => {
    expect(periodStart("week", wed, "monday")).toBe("2026-10-19");
    expect(periodStart("week", wed, "sunday")).toBe("2026-10-18");
    expect(periodStart("month", wed, "monday")).toBe("2026-10-01");
  });

  it("steps across month and year boundaries", () => {
    expect(shiftPeriod("month", "2026-01-01", -1)).toBe("2025-12-01");
    expect(shiftPeriod("week", "2026-12-28", 1)).toBe("2027-01-04");
  });
});
