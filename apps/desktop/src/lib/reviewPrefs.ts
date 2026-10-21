import type { ReviewPeriod } from "@vault/shared";

/**
 * What the weekly / monthly finance review presents, chosen in Settings →
 * Finance reviews. Kept per device (like the theme) — it's a viewing
 * preference, not household data.
 */

export const REVIEW_SLIDES = [
  "overview",
  "categories",
  "daily",
  "merchants",
  "largest",
  "budgets",
  "bills",
  "goals",
  "ai",
] as const;
export type ReviewSlideId = (typeof REVIEW_SLIDES)[number];

export const REVIEW_SLIDE_LABELS: Record<ReviewSlideId, { title: string; hint: string }> = {
  overview: { title: "Overview", hint: "Income, spending and saved, vs the period before" },
  categories: { title: "Spending by category", hint: "Pie chart and the biggest movers" },
  daily: { title: "Day by day", hint: "A bar for each day's spending" },
  merchants: { title: "Top merchants", hint: "Where the money went most often" },
  largest: { title: "Largest purchases", hint: "The five biggest single charges" },
  budgets: { title: "Budgets", hint: "This month's budgets — spent vs planned" },
  bills: { title: "Upcoming bills", hint: "What's due in the next period" },
  goals: { title: "Savings goals", hint: "Progress and on-track status" },
  ai: { title: "AI summary", hint: "Assistant commentary (closed months, AI on)" },
};

export interface ReviewPrefs {
  defaultPeriod: ReviewPeriod;
  weekStartsOn: "monday" | "sunday";
  /** Presentation order; disabled slides are skipped. */
  slides: { id: ReviewSlideId; enabled: boolean }[];
  /** Show "vs last week/month" deltas. */
  compare: boolean;
  /** 0 = advance manually. */
  autoAdvanceSeconds: number;
  /** Open the presenter straight into full screen. */
  startFullscreen: boolean;
}

export const DEFAULT_REVIEW_PREFS: ReviewPrefs = {
  defaultPeriod: "month",
  weekStartsOn: "monday",
  slides: REVIEW_SLIDES.map((id) => ({ id, enabled: true })),
  compare: true,
  autoAdvanceSeconds: 0,
  startFullscreen: false,
};

/** Parse stored prefs, tolerating old/partial/garbled values; new slides are appended enabled. */
export function parseReviewPrefs(raw: string | null): ReviewPrefs {
  if (!raw) return DEFAULT_REVIEW_PREFS;
  let v: Partial<ReviewPrefs>;
  try {
    v = JSON.parse(raw) as Partial<ReviewPrefs>;
  } catch {
    return DEFAULT_REVIEW_PREFS;
  }
  const known = new Set<string>(REVIEW_SLIDES);
  const seen = new Set<string>();
  const slides = (Array.isArray(v.slides) ? v.slides : [])
    .filter((s) => s && known.has(s.id) && !seen.has(s.id) && seen.add(s.id))
    .map((s) => ({ id: s.id, enabled: s.enabled !== false }));
  for (const id of REVIEW_SLIDES) if (!seen.has(id)) slides.push({ id, enabled: true });
  return {
    defaultPeriod: v.defaultPeriod === "week" ? "week" : "month",
    weekStartsOn: v.weekStartsOn === "sunday" ? "sunday" : "monday",
    slides,
    compare: v.compare !== false,
    autoAdvanceSeconds:
      typeof v.autoAdvanceSeconds === "number" && v.autoAdvanceSeconds > 0
        ? Math.min(120, Math.round(v.autoAdvanceSeconds))
        : 0,
    startFullscreen: v.startFullscreen === true,
  };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** First day of the period containing `day` (UTC, matching the server). */
export function periodStart(
  period: ReviewPeriod,
  day: Date,
  weekStartsOn: ReviewPrefs["weekStartsOn"],
): string {
  if (period === "month") return `${isoDay(day).slice(0, 7)}-01`;
  const offset = weekStartsOn === "monday" ? (day.getUTCDay() + 6) % 7 : day.getUTCDay();
  const d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - offset));
  return isoDay(d);
}

/** Step a period start forward/back by whole periods. */
export function shiftPeriod(period: ReviewPeriod, start: string, by: number): string {
  const [y, m, d] = start.split("-").map(Number) as [number, number, number];
  const next =
    period === "month" ? new Date(Date.UTC(y, m - 1 + by, 1)) : new Date(Date.UTC(y, m - 1, d + 7 * by));
  return isoDay(next);
}

/** "Week of Oct 13 – 19, 2026" / "October 2026". */
export function periodLabel(period: ReviewPeriod, start: string): string {
  const [y, m, d] = start.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1, d));
  if (period === "month") {
    return first.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  }
  const last = new Date(Date.UTC(y, m - 1, d + 6));
  const fmt = (x: Date, opts: Intl.DateTimeFormatOptions) =>
    x.toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
  return `Week of ${fmt(first, { month: "short", day: "numeric" })} – ${fmt(last, {
    month: last.getUTCMonth() === first.getUTCMonth() ? undefined : "short",
    day: "numeric",
    year: "numeric",
  })}`;
}
