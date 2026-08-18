import { describe, expect, it } from "vitest";
import { daysFor, monthOf, outOfRange, parseISO, shiftMonth, toISO } from "./DateField.js";

/**
 * The calendar grid is the kind of code that looks correct until February, a
 * leap year, or a month starting on a Sunday. These pin the alignment and the
 * UTC handling — the app stores bare YYYY-MM-DD calendar dates, so any drift
 * into local time would move a date by a day for anyone west of UTC.
 */

const first = (year: number, monthIndex: number) => new Date(Date.UTC(year, monthIndex, 1));
const days = (cursor: Date) => daysFor(cursor).filter((c) => c !== null);
const lead = (cursor: Date) => daysFor(cursor).findIndex((c) => c !== null);

describe("date parsing", () => {
  it("round-trips an ISO date without timezone drift", () => {
    const d = parseISO("2026-12-24");
    expect(d).not.toBeNull();
    expect(toISO(d!)).toBe("2026-12-24");
    expect(d!.getUTCDate()).toBe(24);
  });

  it("rejects anything that isn't a plain calendar date", () => {
    for (const bad of ["", "2026-12", "24/12/2026", "2026-12-24T10:00:00Z", "nope"]) {
      expect(parseISO(bad)).toBeNull();
    }
  });

  it("falls back to the current month when there's no value", () => {
    const now = new Date();
    const m = monthOf("");
    expect(m.getUTCFullYear()).toBe(now.getUTCFullYear());
    expect(m.getUTCMonth()).toBe(now.getUTCMonth());
    expect(m.getUTCDate()).toBe(1);
  });

  it("snaps a value to the first of its own month", () => {
    expect(toISO(monthOf("2026-12-24"))).toBe("2026-12-01");
  });
});

describe("month paging", () => {
  it("rolls across year boundaries in both directions", () => {
    expect(toISO(shiftMonth(first(2026, 11), 1))).toBe("2027-01-01");
    expect(toISO(shiftMonth(first(2026, 0), -1))).toBe("2025-12-01");
  });

  it("doesn't overflow when paging out of a long month", () => {
    // Naive date maths turns 31 Jan + 1 month into 3 March.
    expect(toISO(shiftMonth(monthOf("2026-01-31"), 1))).toBe("2026-02-01");
  });
});

describe("grid layout", () => {
  it("gives every month its real length", () => {
    expect(days(first(2026, 0))).toHaveLength(31); // January
    expect(days(first(2026, 1))).toHaveLength(28); // February, common year
    expect(days(first(2026, 3))).toHaveLength(30); // April
  });

  it("handles leap years", () => {
    expect(days(first(2028, 1))).toHaveLength(29);
    expect(days(first(2000, 1))).toHaveLength(29); // divisible by 400
    expect(days(first(1900, 1))).toHaveLength(28); // divisible by 100, not 400
  });

  it("pads Monday-first so each day lands in the right column", () => {
    // 1 Jan 2026 is a Thursday → three blanks before it (Mon, Tue, Wed).
    expect(lead(first(2026, 0))).toBe(3);
    // 1 Feb 2026 is a Sunday → six blanks, not zero. Sunday-first padding is
    // the classic off-by-one here.
    expect(lead(first(2026, 1))).toBe(6);
    // 1 Jun 2026 is a Monday → no padding at all.
    expect(lead(first(2026, 5))).toBe(0);
  });

  it("numbers days sequentially from the first cell", () => {
    const cells = daysFor(first(2026, 1));
    const real = cells.filter((c) => c !== null);
    expect(real[0]).toEqual({ iso: "2026-02-01", day: 1 });
    expect(real[real.length - 1]).toEqual({ iso: "2026-02-28", day: 28 });
  });
});

describe("bounds", () => {
  it("only disables days outside the range", () => {
    expect(outOfRange("2026-06-15", "2026-06-01", "2026-06-30")).toBe(false);
    expect(outOfRange("2026-05-31", "2026-06-01", undefined)).toBe(true);
    expect(outOfRange("2026-07-01", undefined, "2026-06-30")).toBe(true);
  });

  it("is unbounded when no range is given", () => {
    expect(outOfRange("1999-01-01")).toBe(false);
    expect(outOfRange("2099-12-31")).toBe(false);
  });
});
