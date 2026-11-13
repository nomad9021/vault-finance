import type { BudgetPeriod, WeekStart } from "@vault/shared";

/**
 * Budget periods. A budget row stores its amount per its own period (per week
 * or per month); everything that reasons about a month uses the monthly
 * equivalent, so a weekly budget fits month totals, Sankeys and insights.
 * Dates are calendar days (YYYY-MM-DD) in UTC, like transactions.postedAt.
 */

const DAY = 86_400_000;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseYmd(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** What the budget comes to over `month` (YYYY-MM). */
export function monthlyAmountCents(
  row: { amountCents: number; period: BudgetPeriod },
  month: string,
): number {
  if (row.period === "weekly") return Math.round((row.amountCents * daysInMonth(month)) / 7);
  return row.amountCents;
}

/** The week containing `day`: its first day and the day after its last. */
export function weekBounds(day: string, weekStart: WeekStart): { start: string; end: string } {
  const d = parseYmd(day);
  const offset = weekStart === "monday" ? (d.getUTCDay() + 6) % 7 : d.getUTCDay();
  const start = new Date(d.getTime() - offset * DAY);
  return { start: ymd(start), end: ymd(new Date(start.getTime() + 7 * DAY)) };
}

/**
 * The period a budget is "in" when viewing `month`: for a weekly budget the
 * week containing today if `month` is the current month, otherwise the week
 * containing that month's last day; for a monthly budget the month itself.
 */
export function currentPeriod(
  period: BudgetPeriod,
  month: string,
  weekStart: WeekStart,
  today: string = ymd(new Date()),
): { start: string; end: string } {
  const first = `${month}-01`;
  const lastDay = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  const next = ymd(new Date(parseYmd(lastDay).getTime() + DAY));
  if (period === "monthly") return { start: first, end: next };
  const anchor = today.slice(0, 7) === month ? today : lastDay;
  return weekBounds(anchor, weekStart);
}
