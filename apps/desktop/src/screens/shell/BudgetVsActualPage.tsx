import { formatCents } from "@vault/shared";
import { Button, EmptyState, Panel, SkeletonList } from "@vault/ui";
import { useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { Navigate } from "./AppShell.js";
import { buildBudgetVsActual } from "./budgetSankey.js";
import { SankeyCard } from "./SankeyCard.js";

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Budget and actual for one month on a single Sankey, with the same figures in
 * a table underneath for reading off the exact cents.
 */
export function BudgetVsActualPage({ onNavigate }: { onNavigate: Navigate }) {
  const client = useApp((s) => s.client);
  const [month, setMonth] = useState(currentMonth());
  const { data, loading } = useData(() => client.budgets(month), [client, month]);
  const { data: catData } = useData(() => client.categories(), [client]);

  const view = buildBudgetVsActual(data ?? { budgets: [] }, catData?.categories ?? []);
  const difference = view.budgetedCents - view.actualCents;

  return (
    <div className="page" style={{ width: "100%", maxWidth: 1180 }}>
      <div className="row" style={{ gap: "var(--space-1)" }}>
        <Button variant="ghost" icon="chevronLeft" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month" />
        <span className="t-md t-semibold" style={{ minWidth: 150, textAlign: "center", fontFamily: "var(--font-heading)" }}>
          {monthLabel(month)}
        </span>
        <Button variant="ghost" icon="chevronRight" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month" />
      </div>

      {loading && !data ? (
        <Panel title="Budget vs actual">
          <SkeletonList rows={4} height={52} />
        </Panel>
      ) : view.rows.length === 0 ? (
        <Panel title="Budget vs actual">
          <EmptyState
            compact
            icon="target"
            title={`Nothing to compare for ${monthLabel(month)}`}
            body="Add a budget, or record some spending, and it will flow through here."
          />
        </Panel>
      ) : (
        <>
          <SankeyCard
            precise
            singlePeriod
            title="Budget vs actual"
            hint="Budget flows in on the left, spending out on the right"
            nodes={view.nodes}
            links={view.links}
            month={month}
            onNavigate={onNavigate}
          />
          <Panel title="By category">
            <div
              role="table"
              aria-label="Budget and actual by category"
              style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) repeat(3, auto)", columnGap: "var(--space-6)", rowGap: "var(--space-2)" }}
            >
              <Row cells={["Category", "Budgeted", "Actual", "Left"]} header />
              {view.rows.map((r) => (
                <Row
                  key={r.categoryId ?? "none"}
                  color={r.color}
                  over={r.actualCents > r.budgetedCents}
                  cells={[
                    r.label,
                    r.budgetedCents > 0 ? formatCents(r.budgetedCents) : "—",
                    formatCents(r.actualCents),
                    formatCents(r.budgetedCents - r.actualCents),
                  ]}
                />
              ))}
              <Row
                header
                over={difference < 0}
                cells={["Total", formatCents(view.budgetedCents), formatCents(view.actualCents), formatCents(difference)]}
              />
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function Row({ cells, header = false, over = false, color }: { cells: string[]; header?: boolean; over?: boolean; color?: string }) {
  return (
    <div role="row" style={{ display: "contents" }}>
      {cells.map((text, i) => (
        <div
          key={i}
          role={header ? "columnheader" : "cell"}
          className={i === 0 ? "t-sm" : "t-sm num"}
          style={{
            ...(i === 0 ? { display: "flex", alignItems: "center", gap: 7, minWidth: 0 } : { textAlign: "right" }),
            ...(header ? { fontWeight: 600 } : {}),
            ...(over && i === 3 ? { color: "var(--color-negative)" } : {}),
          }}
        >
          {i === 0 && color && (
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: color, flex: "none" }} />
          )}
          {text}
        </div>
      ))}
    </div>
  );
}
