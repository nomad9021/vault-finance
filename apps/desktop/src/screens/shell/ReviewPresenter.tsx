import { useKeepUnlocked } from "../../lib/autoLock.js";
import {
  formatCents,
  formatCentsWhole,
  type Bill,
  type BudgetListResponse,
  type Category,
  type Goal,
  type PeriodReview,
  type ReviewPeriod,
  type ReviewTotals,
} from "@vault/shared";
import { Button, PieChart, Segmented, Spinner } from "@vault/ui";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  periodLabel,
  periodStart,
  shiftPeriod,
  type ReviewSlideId,
} from "../../lib/reviewPrefs.js";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";

/**
 * The weekly / monthly finance review, presented as a full-window slideshow.
 * Which slides appear (and in what order) comes from Settings → Finance
 * reviews. Keys: ← → / Space to move, F for full screen, Esc to leave.
 */
export function ReviewPresenter({
  initialPeriod,
  fullscreen: startFullscreen,
  onClose,
}: {
  initialPeriod: ReviewPeriod;
  fullscreen: boolean;
  onClose: () => void;
}) {
  // Presenting counts as activity (slides can auto-advance untouched).
  useKeepUnlocked();
  const client = useApp((s) => s.client);
  const platform = useApp((s) => s.platform);
  const prefs = useApp((s) => s.reviewPrefs);
  const aiVisible = useApp((s) => s.aiVisible);

  const [period, setPeriod] = useState<ReviewPeriod>(initialPeriod);
  const [start, setStart] = useState(() => periodStart(initialPeriod, new Date(), prefs.weekStartsOn));
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(prefs.autoAdvanceSeconds > 0);
  const [fullscreen, setFullscreen] = useState(false);

  const currentStart = periodStart(period, new Date(), prefs.weekStartsOn);
  const isCurrent = start >= currentStart;
  const reviewMonth = start.slice(0, 7);

  const { data: review, loading, error } = useData<PeriodReview>(
    () => client.periodReview(period, start),
    [client, period, start],
  );
  const { data: extras } = useData(
    async () => {
      const [budgets, cats, bills, goals] = await Promise.all([
        client.budgets(reviewMonth).catch(() => null),
        client.categories().catch(() => null),
        client.bills().catch(() => null),
        client.goals().catch(() => null),
      ]);
      return { budgets, categories: cats?.categories ?? [], bills: bills?.bills ?? [], goals: goals?.goals ?? [] };
    },
    [client, reviewMonth],
  );
  const wantsAi = aiVisible && period === "month" && prefs.slides.some((s) => s.id === "ai" && s.enabled);
  const { data: monthly } = useData(
    () => (wantsAi ? client.monthlyReport(reviewMonth) : Promise.resolve(null)),
    [client, reviewMonth, wantsAi],
  );

  // Enabled slides, minus any with nothing to show for this period.
  const slides = useMemo(() => {
    return prefs.slides
      .filter((s) => s.enabled)
      .map((s) => s.id)
      .filter((id) => {
        if (id === "ai") return !!monthly?.aiSummary;
        if (id === "budgets") return (extras?.budgets?.budgets.length ?? 0) > 0;
        if (id === "goals") return (extras?.goals.length ?? 0) > 0;
        return true;
      });
  }, [prefs.slides, monthly, extras]);
  const count = slides.length;
  const safeIndex = Math.min(index, Math.max(0, count - 1));

  const go = useCallback(
    (by: number) => setIndex((i) => Math.max(0, Math.min(count - 1, Math.min(i, count - 1) + by))),
    [count],
  );

  const toggleFullscreen = useCallback(async () => {
    const next = !fullscreen;
    try {
      await platform.setFullscreen(next);
      setFullscreen(next);
    } catch (err) {
      console.error("full screen toggle failed", err);
    }
  }, [fullscreen, platform]);

  const close = useCallback(async () => {
    if (fullscreen) await platform.setFullscreen(false).catch(() => {});
    onClose();
  }, [fullscreen, platform, onClose]);

  useEffect(() => {
    if (startFullscreen) void toggleFullscreen();
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The browser leaves full screen on its own Esc; keep our state honest.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && platform.kind === "browser") setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [platform]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "Home") setIndex(0);
      else if (e.key === "End") setIndex(count - 1);
      else if (e.key.toLowerCase() === "f") void toggleFullscreen();
      else if (e.key === "Escape") void close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, count, toggleFullscreen, close]);

  // Auto-advance; stops on the last slide.
  useEffect(() => {
    if (!playing || prefs.autoAdvanceSeconds <= 0 || safeIndex >= count - 1) return;
    const t = window.setTimeout(() => go(1), prefs.autoAdvanceSeconds * 1000);
    return () => window.clearTimeout(t);
  }, [playing, prefs.autoAdvanceSeconds, safeIndex, count, go]);

  const changePeriod = (p: ReviewPeriod) => {
    setPeriod(p);
    setStart(periodStart(p, new Date(`${start}T00:00:00Z`), prefs.weekStartsOn));
    setIndex(0);
  };
  const stepPeriod = (by: number) => {
    setStart((s) => shiftPeriod(period, s, by));
    setIndex(0);
  };

  const slideId = slides[safeIndex];
  const label = periodLabel(period, start);
  const prevWord = period === "week" ? "last week" : "last month";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${period === "week" ? "Weekly" : "Monthly"} finance review`}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        background:
          "linear-gradient(160deg, var(--color-bg) 0%, color-mix(in srgb, var(--color-section) 35%, var(--color-bg)) 120%)",
        color: "var(--content-primary)",
        fontFamily: "var(--font-body)",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          padding: "12px 20px",
          borderBottom: "1px solid var(--color-divider)",
        }}
      >
        <Segmented
          aria-label="Review period"
          options={[
            { value: "week", label: "Weekly" },
            { value: "month", label: "Monthly" },
          ]}
          value={period}
          onChange={changePeriod}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Button variant="ghost" size="sm" icon="chevronLeft" aria-label={`Previous ${period}`} onClick={() => stepPeriod(-1)} />
          <span style={{ fontWeight: 600, minWidth: 0 }}>{label}</span>
          <Button
            variant="ghost"
            size="sm"
            icon="chevronRight"
            aria-label={`Next ${period}`}
            disabled={isCurrent}
            onClick={() => stepPeriod(1)}
          />
        </div>
        <div style={{ flex: 1 }} />
        {prefs.autoAdvanceSeconds > 0 && (
          <Button
            variant="ghost"
            size="sm"
            icon={playing ? "pause" : "play"}
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? "Pause" : "Play"}
          </Button>
        )}
        <Button variant="ghost" size="sm" icon={fullscreen ? "shrink" : "expand"} onClick={() => void toggleFullscreen()}>
          {fullscreen ? "Exit full screen" : "Full screen"}
        </Button>
        <Button variant="secondary" size="sm" icon="close" onClick={() => void close()}>
          Close
        </Button>
      </div>

      {/* Slide */}
      <div
        style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", padding: "clamp(16px, 4vw, 48px)" }}
        onClick={(e) => {
          // Click the empty stage to advance, like a deck.
          if (e.target === e.currentTarget) go(1);
        }}
      >
        <div style={{ margin: "auto", width: "100%", maxWidth: 1040 }}>
          {error ? (
            <SlideFrame kicker={label} title="Couldn't load this review">
              <p className="text-muted">{error.message}</p>
            </SlideFrame>
          ) : !review || (loading && review.start !== start) ? (
            <div style={{ display: "grid", placeItems: "center", minHeight: 240 }}>
              <Spinner label="Loading review" />
            </div>
          ) : count === 0 ? (
            <SlideFrame kicker={label} title="No slides selected">
              <p className="text-muted">Turn some on in Settings → Finance reviews.</p>
            </SlideFrame>
          ) : slideId ? (
            <Slide
              key={`${slideId}:${start}`}
              id={slideId}
              review={review}
              label={label}
              prevWord={prevWord}
              compare={prefs.compare}
              budgets={extras?.budgets ?? null}
              categories={extras?.categories ?? []}
              bills={extras?.bills ?? []}
              goals={extras?.goals ?? []}
              aiSummary={monthly?.aiSummary ?? null}
            />
          ) : null}
        </div>
      </div>

      {/* Bottom bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 20px",
          borderTop: "1px solid var(--color-divider)",
        }}
      >
        <Button variant="secondary" icon="arrowLeft" disabled={safeIndex === 0} onClick={() => go(-1)}>
          Back
        </Button>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }} aria-label={`Slide ${safeIndex + 1} of ${count}`}>
          {slides.map((id, i) => (
            <button
              key={id}
              aria-label={`Go to slide ${i + 1}`}
              aria-current={i === safeIndex}
              onClick={() => setIndex(i)}
              style={{
                width: i === safeIndex ? 22 : 8,
                height: 8,
                padding: 0,
                border: 0,
                borderRadius: 99,
                cursor: "pointer",
                background: i === safeIndex ? "var(--color-accent)" : "var(--color-divider)",
                transition: "width .2s",
              }}
            />
          ))}
        </div>
        <Button variant="primary" iconEnd="arrowRight" disabled={safeIndex >= count - 1} onClick={() => go(1)}>
          Next
        </Button>
      </div>
    </div>,
    document.body,
  );
}

// ── Slides ──────────────────────────────────────────────────────────────

interface SlideProps {
  id: ReviewSlideId;
  review: PeriodReview;
  label: string;
  prevWord: string;
  compare: boolean;
  budgets: BudgetListResponse | null;
  categories: Category[];
  bills: Bill[];
  goals: Goal[];
  aiSummary: string | null;
}

function Slide(props: SlideProps) {
  const { id, review, label } = props;
  switch (id) {
    case "overview":
      return <OverviewSlide {...props} />;
    case "categories":
      return <CategoriesSlide {...props} />;
    case "daily":
      return (
        <SlideFrame kicker={label} title="Day by day">
          <DailyBars review={review} />
        </SlideFrame>
      );
    case "merchants":
      return (
        <SlideFrame kicker={label} title="Top merchants">
          {review.topMerchants.length === 0 ? (
            <Empty>No spending this {review.period}.</Empty>
          ) : (
            <RankList
              rows={review.topMerchants.map((m) => ({
                key: m.name,
                name: m.name,
                meta: `${m.count} ${m.count === 1 ? "charge" : "charges"}`,
                cents: m.spentCents,
              }))}
              total={review.spendingCents}
            />
          )}
        </SlideFrame>
      );
    case "largest":
      return (
        <SlideFrame kicker={label} title="Largest purchases">
          {review.largestPurchases.length === 0 ? (
            <Empty>No purchases this {review.period}.</Empty>
          ) : (
            <RankList
              rows={review.largestPurchases.map((t) => ({
                key: t.id,
                name: t.merchantName,
                meta: `${shortDate(t.postedAt)} · ${t.categoryName}`,
                cents: -t.amountCents,
                color: t.color,
              }))}
              total={review.spendingCents}
            />
          )}
        </SlideFrame>
      );
    case "budgets":
      return <BudgetsSlide {...props} />;
    case "bills":
      return <BillsSlide {...props} />;
    case "goals":
      return <GoalsSlide {...props} />;
    case "ai":
      return (
        <SlideFrame kicker={label} title="AI summary">
          <div style={{ fontSize: "clamp(1.05rem, 2vw, 1.4rem)", lineHeight: 1.65, whiteSpace: "pre-line", maxWidth: 760 }}>
            {props.aiSummary}
          </div>
        </SlideFrame>
      );
  }
}

function OverviewSlide({ review, label, prevWord, compare }: SlideProps) {
  const p = review.previous;
  return (
    <SlideFrame kicker={label} title={review.period === "week" ? "Your week in money" : "Your month in money"}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
        <BigStat label="Income" cents={review.incomeCents} prev={compare ? p.incomeCents : null} prevWord={prevWord} goodWhenUp />
        <BigStat label="Spending" cents={review.spendingCents} prev={compare ? p.spendingCents : null} prevWord={prevWord} />
        <BigStat label="Saved" cents={review.savedCents} prev={compare ? p.savedCents : null} prevWord={prevWord} goodWhenUp signed />
      </div>
      <p style={{ marginTop: 22, fontSize: "var(--text-base)", color: "var(--content-secondary)" }}>
        {headline(review, compare ? p : null, prevWord)}
      </p>
    </SlideFrame>
  );
}

function headline(review: PeriodReview, prev: ReviewTotals | null, prevWord: string): string {
  const parts: string[] = [];
  if (review.savingsRate != null) parts.push(`You kept ${Math.round(review.savingsRate * 100)}% of what came in.`);
  else if (review.incomeCents === 0 && review.spendingCents > 0) parts.push("No income recorded in this period yet.");
  if (prev && prev.spendingCents > 0) {
    const diff = review.spendingCents - prev.spendingCents;
    if (Math.abs(diff) >= 100)
      parts.push(`Spending was ${formatCentsWhole(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than ${prevWord}.`);
  }
  parts.push(`${review.transactionCount} ${review.transactionCount === 1 ? "transaction" : "transactions"}.`);
  return parts.join(" ");
}

function CategoriesSlide({ review, label, compare, prevWord }: SlideProps) {
  const top = review.categories.slice(0, 7);
  return (
    <SlideFrame kicker={label} title="Spending by category">
      {top.length === 0 ? (
        <Empty>No spending this {review.period}.</Empty>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 28, alignItems: "center" }}>
          <PieChart
            data={top.map((c) => ({ label: c.name, value: c.spentCents, color: c.color }))}
            format={formatCentsWhole}
            centerLabel="spent"
            ariaLabel={`${label} spending by category`}
          />
          <div style={{ display: "flex", flexDirection: "column" }}>
            {top.map((c) => (
              <div
                key={c.categoryId ?? c.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 2px",
                  borderTop: "1px solid color-mix(in srgb, var(--color-text) 7%, transparent)",
                }}
              >
                <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: "var(--radius-sm)", background: c.color, flex: "none" }} />
                <span style={{ flex: 1, minWidth: 0 }}>{c.name}</span>
                {compare && <Delta now={c.spentCents} prev={c.previousSpentCents} prevWord={prevWord} compact />}
                <span style={{ fontWeight: 600, minWidth: 80, textAlign: "right" }}>{formatCentsWhole(c.spentCents)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </SlideFrame>
  );
}

/** Single-series bar chart: one bar per day, hover for the figure. */
function DailyBars({ review }: { review: PeriodReview }) {
  const [hover, setHover] = useState<number | null>(null);
  const days = review.dailySpending;
  const max = Math.max(1, ...days.map((d) => d.spentCents));
  const week = review.period === "week";
  const avg = Math.round(review.spendingCents / Math.max(1, days.length));
  const shown = hover != null ? days[hover] : null;
  return (
    <div>
      <div style={{ display: "flex", gap: 24, marginBottom: 14, flexWrap: "wrap" }}>
        <MiniStat label="daily average" value={formatCentsWhole(avg)} />
        <MiniStat label="busiest day" value={busiest(days)} />
        <MiniStat
          label={shown ? longDate(shown.date) : "hover a bar"}
          value={shown ? formatCentsWhole(shown.spentCents) : "—"}
        />
      </div>
      <div
        role="img"
        aria-label={`Spending per day, ${review.start} to ${review.end}`}
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: week ? 10 : 2,
          height: "clamp(180px, 38vh, 340px)",
          borderBottom: "1px solid var(--color-divider)",
        }}
      >
        {days.map((d, i) => (
          <div
            key={d.date}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            title={`${longDate(d.date)}: ${formatCentsWhole(d.spentCents)}`}
            style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end", cursor: "default" }}
          >
            <div
              style={{
                width: "100%",
                height: `${Math.max(d.spentCents > 0 ? 1.5 : 0, (d.spentCents / max) * 100)}%`,
                background: "var(--color-accent)",
                opacity: hover == null || hover === i ? 1 : 0.45,
                borderRadius: "4px 4px 0 0",
                transition: "opacity .12s",
              }}
            />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: week ? 10 : 2, marginTop: 6 }}>
        {days.map((d, i) => (
          <div
            key={d.date}
            style={{ flex: 1, textAlign: "center", fontSize: "var(--text-2xs)", color: "var(--content-tertiary)" }}
          >
            {week ? weekday(d.date) : i === 0 || (i + 1) % 5 === 0 ? Number(d.date.slice(8)) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function BudgetsSlide({ budgets, categories, label, review }: SlideProps) {
  if (!budgets) return null;
  const names = new Map(categories.map((c) => [c.id, c]));
  const rows = [...budgets.budgets].sort((a, b) => b.spentCents / b.amountCents - a.spentCents / a.amountCents);
  const monthName = periodLabel("month", `${budgets.month}-01`);
  return (
    <SlideFrame kicker={review.period === "week" ? `${label} · ${monthName} budgets` : label} title="Budgets">
      <p style={{ marginTop: 0, color: "var(--content-secondary)" }}>
        {formatCents(budgets.totalSpentCents)} spent of {formatCents(budgets.totalBudgetedCents)} budgeted
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px 28px" }}>
        {rows.slice(0, 10).map((b) => {
          const cat = names.get(b.categoryId);
          const pct = b.amountCents > 0 ? b.spentCents / b.amountCents : 0;
          const over = pct > 1;
          return (
            <div key={b.id}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span>{cat?.name ?? "Category"}</span>
                <span style={{ fontWeight: 600, color: over ? "var(--color-negative)" : undefined }}>
                  {formatCents(b.spentCents)} / {formatCents(b.amountCents)}
                  {over ? " · over" : ""}
                </span>
              </div>
              <Bar pct={pct} color={over ? "var(--color-negative)" : (cat?.color ?? "var(--color-accent)")} />
            </div>
          );
        })}
      </div>
    </SlideFrame>
  );
}

function BillsSlide({ bills, review }: SlideProps) {
  const horizon = review.period === "week" ? 7 : 31;
  const upcoming = bills
    .filter((b) => b.daysUntilDue >= 0 && b.daysUntilDue <= horizon)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);
  const total = upcoming.reduce((s, b) => s + b.amountCents, 0);
  return (
    <SlideFrame kicker={`Next ${review.period === "week" ? "7" : "31"} days`} title="Upcoming bills">
      {upcoming.length === 0 ? (
        <Empty>Nothing due in the next {review.period}. 🎉</Empty>
      ) : (
        <>
          <p style={{ marginTop: 0, color: "var(--content-secondary)" }}>
            {upcoming.length} {upcoming.length === 1 ? "bill" : "bills"} · {formatCentsWhole(total)} due
          </p>
          <RankList
            rows={upcoming.map((b) => ({
              key: b.id,
              name: b.name,
              meta: `${b.daysUntilDue === 0 ? "due today" : `in ${b.daysUntilDue} ${b.daysUntilDue === 1 ? "day" : "days"}`} · ${shortDate(b.nextDueDate)}${b.autopay ? " · autopay" : ""}`,
              cents: b.amountCents,
              color: b.color,
            }))}
          />
        </>
      )}
    </SlideFrame>
  );
}

function GoalsSlide({ goals, label }: SlideProps) {
  return (
    <SlideFrame kicker={label} title="Savings goals">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "18px 28px" }}>
        {goals.map((g) => {
          const pct = g.targetCents > 0 ? g.savedCents / g.targetCents : 0;
          const target = g.targetDate?.slice(0, 7) ?? null;
          const status =
            pct >= 1
              ? "Reached 🎉"
              : !target || !g.projectedCompletion
                ? null
                : g.projectedCompletion <= target
                  ? "On track"
                  : "Behind";
          return (
            <div key={g.id}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontWeight: 600 }}>{g.name}</span>
                {status && (
                  <span style={{ color: status === "Behind" ? "var(--color-negative)" : "var(--color-positive)", fontWeight: 600 }}>
                    {status}
                  </span>
                )}
              </div>
              <Bar pct={pct} color={g.color} />
              <div style={{ fontSize: "var(--text-xs)", color: "var(--content-tertiary)", marginTop: 4 }}>
                {formatCentsWhole(g.savedCents)} of {formatCentsWhole(g.targetCents)} ({Math.min(100, Math.round(pct * 100))}%)
                {g.projectedCompletion ? ` · projected ${g.projectedCompletion}` : ""}
              </div>
            </div>
          );
        })}
      </div>
    </SlideFrame>
  );
}

// ── Building blocks ─────────────────────────────────────────────────────

function SlideFrame({ kicker, title, children }: { kicker: string; title: string; children: ReactNode }) {
  return (
    <section style={{ animation: "fadeIn .25s ease" }}>
      <div
        style={{
          fontSize: "var(--text-xs)",
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: "var(--content-tertiary)",
          fontWeight: 600,
        }}
      >
        {kicker}
      </div>
      <h2
        style={{
          fontFamily: "var(--font-heading)",
          fontWeight: 600,
          fontSize: "clamp(1.6rem, 3.6vw, 2.6rem)",
          margin: "6px 0 24px",
          lineHeight: 1.15,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

const statCard: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-divider)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-sm)",
  padding: "18px 20px",
};

function BigStat({
  label,
  cents,
  prev,
  prevWord,
  goodWhenUp = false,
  signed = false,
}: {
  label: string;
  cents: number;
  prev: number | null;
  prevWord: string;
  goodWhenUp?: boolean;
  signed?: boolean;
}) {
  return (
    <div style={statCard}>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--content-tertiary)" }}>{label}</div>
      <div
        style={{
          fontFamily: "var(--font-heading)",
          fontWeight: 600,
          fontSize: "clamp(1.8rem, 4vw, 2.8rem)",
          margin: "4px 0 6px",
          color: signed ? (cents >= 0 ? "var(--color-positive)" : "var(--color-negative)") : undefined,
        }}
      >
        {formatCentsWhole(cents)}
      </div>
      {prev != null && <Delta now={cents} prev={prev} prevWord={prevWord} goodWhenUp={goodWhenUp} />}
    </div>
  );
}

/** "▲ 12% vs last month" — coloured by whether the change is good, with the arrow so it's never colour alone. */
function Delta({
  now,
  prev,
  prevWord,
  goodWhenUp = false,
  compact = false,
}: {
  now: number;
  prev: number;
  prevWord: string;
  goodWhenUp?: boolean;
  compact?: boolean;
}) {
  const diff = now - prev;
  let text: string;
  if (prev === 0 && now === 0) text = "–";
  else if (prev === 0 || Math.abs(prev) < 100) text = compact ? "new" : `${formatCentsWhole(diff)} vs ${prevWord}`;
  else {
    const pct = Math.round((diff / Math.abs(prev)) * 100);
    text = pct === 0 ? `same as ${prevWord}` : `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%${compact ? "" : ` vs ${prevWord}`}`;
  }
  const good = diff === 0 ? null : diff > 0 === goodWhenUp;
  return (
    <span
      title={`${prevWord}: ${formatCentsWhole(prev)}`}
      style={{
        fontSize: "var(--text-xs)",
        fontWeight: 600,
        color: good == null ? "var(--content-tertiary)" : good ? "var(--color-positive)" : "var(--color-negative)",
      }}
    >
      {text}
    </span>
  );
}

function RankList({
  rows,
  total,
}: {
  rows: { key: string; name: string; meta: string; cents: number; color?: string }[];
  total?: number;
}) {
  const max = Math.max(1, ...rows.map((r) => r.cents));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {rows.map((r, i) => (
        <div key={r.key} style={{ display: "grid", gridTemplateColumns: "28px 1fr auto", gap: "4px 12px", alignItems: "center" }}>
          <span style={{ color: "var(--content-tertiary)", fontWeight: 600 }}>{i + 1}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--content-tertiary)" }}>{r.meta}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontWeight: 600, fontSize: "var(--text-lg)" }}>{formatCentsWhole(r.cents)}</div>
            {total ? (
              <div style={{ fontSize: "var(--text-2xs)", color: "var(--content-tertiary)" }}>
                {Math.round((r.cents / total) * 100)}% of spending
              </div>
            ) : null}
          </div>
          <div style={{ gridColumn: "2 / 4" }}>
            <Bar pct={r.cents / max} color={r.color ?? "var(--color-accent)"} thin />
          </div>
        </div>
      ))}
    </div>
  );
}

function Bar({ pct, color, thin = false }: { pct: number; color: string; thin?: boolean }) {
  return (
    <div style={{ height: thin ? 4 : 7, borderRadius: 99, background: "var(--color-neutral-900)", overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${Math.min(100, Math.max(0, pct * 100))}%`, background: color, borderRadius: 99 }} />
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: "var(--text-xl)" }}>{value}</div>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--content-tertiary)" }}>{label}</div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p style={{ color: "var(--content-tertiary)", fontSize: "var(--text-base)" }}>{children}</p>;
}

function busiest(days: PeriodReview["dailySpending"]): string {
  const top = days.reduce<PeriodReview["dailySpending"][number] | null>(
    (best, d) => (d.spentCents > (best?.spentCents ?? 0) ? d : best),
    null,
  );
  return top ? `${shortDate(top.date)} · ${formatCentsWhole(top.spentCents)}` : "—";
}

const utc = (day: string) => new Date(`${day.slice(0, 10)}T00:00:00Z`);
const shortDate = (day: string) =>
  utc(day).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const longDate = (day: string) =>
  utc(day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const weekday = (day: string) => utc(day).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
