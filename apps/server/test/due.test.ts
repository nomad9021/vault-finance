import { describe, expect, it } from "vitest";
import { daysUntilDue, nextDueDate } from "../src/modules/bills/due.js";

/**
 * Bill due dates across month boundaries.
 *
 * Insights used to compute this as `dueDay − todayDate`, which is correct for
 * most of the month and silently wrong for the last week of it: on the 28th a
 * bill due on the 2nd is five days away, but that subtraction gives −26, so the
 * "due soon and underfunded" warning never fired. That window is exactly when
 * the warning matters, and it can't be caught by a test that runs "today" —
 * hence the injected dates below.
 */

const on = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("nextDueDate", () => {
  it("stays in this month when the day is still ahead", () => {
    expect(nextDueDate(20, on("2026-08-14"))).toBe("2026-08-20");
  });

  it("returns today when the bill is due today", () => {
    expect(nextDueDate(14, on("2026-08-14"))).toBe("2026-08-14");
  });

  it("rolls into next month once the day has passed", () => {
    expect(nextDueDate(2, on("2026-08-28"))).toBe("2026-09-02");
  });

  it("rolls across the year boundary", () => {
    expect(nextDueDate(3, on("2026-12-29"))).toBe("2027-01-03");
  });

  it("clamps a 31st due day to short months", () => {
    expect(nextDueDate(31, on("2026-09-15"))).toBe("2026-09-30");
    expect(nextDueDate(31, on("2026-02-15"))).toBe("2026-02-28");
    expect(nextDueDate(31, on("2028-02-15"))).toBe("2028-02-29");
  });

  it("clamps when rolling into a short month", () => {
    expect(nextDueDate(31, on("2026-01-31"))).toBe("2026-01-31");
    expect(nextDueDate(30, on("2026-01-31"))).toBe("2026-02-28");
  });
});

describe("daysUntilDue", () => {
  it("counts forward within the month", () => {
    expect(daysUntilDue(20, on("2026-08-14"))).toBe(6);
  });

  it("is zero on the due day", () => {
    expect(daysUntilDue(14, on("2026-08-14"))).toBe(0);
  });

  it("counts across a month boundary instead of going negative", () => {
    // The regression: this used to be −26, hiding a bill five days out.
    expect(daysUntilDue(2, on("2026-08-28"))).toBe(5);
    expect(daysUntilDue(1, on("2026-08-31"))).toBe(1);
  });

  it("never returns a negative number", () => {
    for (let day = 1; day <= 31; day++) {
      for (const today of ["2026-01-01", "2026-02-27", "2026-08-14", "2026-12-31"]) {
        expect(daysUntilDue(day, on(today))).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
