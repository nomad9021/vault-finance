/**
 * Bill due-date maths, shared so nothing can disagree about when a bill lands.
 *
 * Insights used to compute this itself as `dueDay - todayDate`, which is right
 * for most of the month and wrong exactly when it matters: on the 28th, a bill
 * due on the 2nd is five days away, but that subtraction returns −26 and the
 * warning never fires. Anything that needs "how far away is this bill" imports
 * from here.
 *
 * `today` is injectable so the month-boundary cases can actually be tested.
 */

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Next occurrence of a day-of-month from today (UTC), clamped to month length. */
export function nextDueDate(dueDay: number, today = new Date()): string {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const d = today.getUTCDate();
  const thisMonthDay = Math.min(dueDay, daysInMonth(y, m));
  if (thisMonthDay >= d) {
    return new Date(Date.UTC(y, m, thisMonthDay)).toISOString().slice(0, 10);
  }
  // Roll into next month (Date normalizes December → January of next year).
  const nextMonth = new Date(Date.UTC(y, m + 1, 1));
  const ny = nextMonth.getUTCFullYear();
  const nmi = nextMonth.getUTCMonth();
  const dayNext = Math.min(dueDay, daysInMonth(ny, nmi));
  return new Date(Date.UTC(ny, nmi, dayNext)).toISOString().slice(0, 10);
}

/** Whole days from today (UTC) until a bill's next occurrence. Never negative. */
export function daysUntilDue(dueDay: number, today = new Date()): number {
  const next = nextDueDate(dueDay, today);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((Date.parse(`${next}T00:00:00Z`) - todayUtc) / 86_400_000);
}
