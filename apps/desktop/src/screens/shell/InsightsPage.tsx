import { formatCentsWhole, type Insight, type InsightSeverity } from "@vault/shared";
import { Button, EmptyState, Icon, MetricCard, Panel, Spinner, type IconName } from "@vault/ui";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { NavFilter, Navigate, PageId } from "./AppShell.js";

const SEVERITY: Record<
  InsightSeverity,
  { icon: IconName; color: string; label: string }
> = {
  critical: { icon: "alert", color: "var(--color-negative)", label: "Needs attention" },
  warning: { icon: "alert", color: "var(--color-accent)", label: "Worth a look" },
  info: { icon: "info", color: "var(--content-tertiary)", label: "For information" },
  good: { icon: "check", color: "var(--color-positive)", label: "Going well" },
};

const ORDER: InsightSeverity[] = ["critical", "warning", "info", "good"];

/**
 * Insights — everything the app noticed, in the order it matters.
 *
 * This exists because the rest of the app is organized by *thing* (bills,
 * budgets, goals) and nobody visits all of them every week. A budget quietly
 * going 40% over is only visible if you happen to open Budgets. Here it comes
 * to you, with the number that makes it real and a button to the page that
 * fixes it.
 *
 * Every card is a plain rule over stored data, not an AI summary — so it works
 * on a server with no AI configured, and the reasoning is always shown.
 */
export function InsightsPage({ onNavigate }: { onNavigate: Navigate }) {
  const client = useApp((s) => s.client);
  const { data, loading } = useData(() => client.insights(), [client]);

  if (loading && !data) return <Spinner label="Looking for anything worth flagging" />;

  const insights = data?.insights ?? [];
  const good = insights.filter((i) => i.severity === "good");

  return (
    <div className="page">
      <div className="page-head">
        <div className="grid" style={{ flex: 1, minWidth: 0 }}>
          <div className="col-4">
            <MetricCard
              label="Needs attention"
              value={String(data?.criticalCount ?? 0)}
              deltaTone={(data?.criticalCount ?? 0) > 0 ? "down" : "up"}
              hint="urgent items"
            />
          </div>
          <div className="col-4">
            <MetricCard
              label="Worth a look"
              value={String(data?.warningCount ?? 0)}
              hint="not urgent yet"
            />
          </div>
          <div className="col-4">
            <MetricCard
              label="Going well"
              value={String(good.length)}
              deltaTone="up"
              hint="wins to keep"
            />
          </div>
        </div>
      </div>

      {insights.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon="check"
            title="Nothing needs your attention"
            body="No overspent budgets, underfunded bills or stalled goals. Add some budgets and bills and this page will start watching them for you."
          />
        </div>
      ) : (
        ORDER.map((severity) => {
          const group = insights.filter((i) => i.severity === severity);
          if (group.length === 0) return null;
          return (
            <Panel key={severity} title={SEVERITY[severity].label} subtitle={`${group.length} item${group.length === 1 ? "" : "s"}`}>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {group.map((insight) => (
                  <InsightRow key={insight.id} insight={insight} onNavigate={onNavigate} />
                ))}
              </div>
            </Panel>
          );
        })
      )}
    </div>
  );
}

function InsightRow({ insight, onNavigate }: { insight: Insight; onNavigate: Navigate }) {
  const style = SEVERITY[insight.severity];
  const filter: NavFilter = {
    ...(insight.categoryId ? { categoryId: insight.categoryId } : {}),
    ...(insight.accountId ? { accountId: insight.accountId } : {}),
  };

  return (
    <div
      className="row-div"
      style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "13px 2px" }}
    >
      <span
        aria-hidden="true"
        style={{
          flex: "none",
          display: "grid",
          placeItems: "center",
          width: 28,
          height: 28,
          borderRadius: "var(--radius-md)",
          color: style.color,
          background: `color-mix(in srgb, ${style.color} 12%, transparent)`,
          marginTop: 1,
        }}
      >
        <Icon name={style.icon} size={16} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: "var(--text-base)" }}>{insight.title}</div>
        <p
          style={{
            margin: "3px 0 0",
            fontSize: "var(--text-sm)",
            color: "var(--content-tertiary)",
            lineHeight: 1.55,
          }}
        >
          {insight.detail}
        </p>
      </div>
      {insight.amountCents !== null && (
        <div className="num" style={{ flex: "none", fontWeight: 600, color: style.color }}>
          {formatCentsWhole(insight.amountCents)}
        </div>
      )}
      <Button
        variant="secondary"
        size="sm"
        iconEnd="arrowRight"
        style={{ flex: "none" }}
        onClick={() => onNavigate(insight.page as PageId, filter)}
      >
        Open
      </Button>
    </div>
  );
}
