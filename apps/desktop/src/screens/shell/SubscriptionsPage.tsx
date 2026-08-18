import { formatCentsWhole, type Subscription } from "@vault/shared";
import { Button, EmptyState, MetricCard, Panel, Spinner, Tag } from "@vault/ui";
import { useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { Navigate } from "./AppShell.js";

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Subscriptions — recurring charges found in the ledger, not typed in by hand.
 *
 * The household already paid for these; making someone re-enter them would be
 * busywork and would go stale the moment a price changed. So the server groups
 * spending by merchant, looks for a regular interval, and reports candidates.
 *
 * Because detection is a guess, the evidence rides along: how many charges it
 * saw and how regular they were. A row that hasn't charged when it should have
 * is called out as possibly cancelled rather than silently dropped, and a price
 * rise since the previous charge is flagged — that's the thing people actually
 * want to catch and never do.
 */
export function SubscriptionsPage({ onNavigate }: { onNavigate: Navigate }) {
  const client = useApp((s) => s.client);
  const { data, loading, reload: reloadSubs } = useData(() => client.subscriptions(), [client]);
  const { data: billData, reload: reloadBills } = useData(() => client.bills(), [client]);
  const [tracking, setTracking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (loading && !data) return <Spinner label="Scanning for recurring charges" />;

  const subs = data?.subscriptions ?? [];
  const active = subs.filter((s) => !s.stale);
  const stale = subs.filter((s) => s.stale);
  const increases = subs.filter((s) => s.priceIncreaseCents !== null && !s.stale);
  // How many of THESE rows are already tracked — not how many bills exist. The
  // latter read as "4 of these are handled" when none of them were.
  const trackedCount = subs.filter((s) => s.billId).length;

  // Promote a detected charge into a tracked bill so it joins the Bills branch
  // of the cash-flow diagram and gets due-date reminders.
  const trackAsBill = async (sub: Subscription) => {
    setTracking(sub.id);
    setError(null);
    try {
      await client.createBill({
        name: sub.merchantName,
        amountCents: sub.amountCents,
        dueDay: Number(sub.nextExpectedAt.slice(8, 10)),
        cadence: sub.cadence,
        ...(sub.categoryId ? { categoryId: sub.categoryId } : {}),
        ...(sub.accountId ? { accountId: sub.accountId } : {}),
      });
      // The "tracked as a bill" badge is computed server-side inside the
      // subscriptions response, so refreshing only the bills list left the row
      // looking untouched — the click appeared to do nothing at all.
      reloadSubs();
      reloadBills();
    } catch (err) {
      // Without this the rejection vanished into the void and the button simply
      // stopped spinning, which reads as "it worked".
      setError(err instanceof Error ? err.message : "Couldn't track that as a bill.");
    } finally {
      setTracking(null);
    }
  };

  return (
    <div className="page">
      {error && (
        <div role="alert" className="panel" style={{ color: "var(--color-negative)" }}>
          {error}
        </div>
      )}
      <div className="page-head">
        <div className="grid" style={{ flex: 1, minWidth: 0 }}>
          <div className="col-4">
            <MetricCard
              label="Recurring per month"
              value={formatCentsWhole(data?.monthlyTotalCents ?? 0)}
              hint={`${active.length} active`}
            />
          </div>
          <div className="col-4">
            <MetricCard
              label="Per year"
              value={formatCentsWhole(data?.yearlyTotalCents ?? 0)}
              hint="if nothing changes"
            />
          </div>
          <div className="col-4">
            <MetricCard
              label="Price rises"
              value={String(increases.length)}
              deltaTone={increases.length > 0 ? "down" : "up"}
              hint="since the previous charge"
            />
          </div>
        </div>
      </div>

      {subs.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon="refresh"
            title="No recurring charges detected"
            body="This page reads your transaction history and looks for merchants that charge on a regular schedule. Import a few months of transactions and subscriptions will appear here on their own."
            action={
              <Button variant="primary" onClick={() => onNavigate("transactions")}>
                Go to Transactions
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <Panel
            title="Active subscriptions"
            subtitle={`Detected from your history · ${trackedCount} of ${subs.length} already tracked as bills`}
          >
            {active.length === 0 ? (
              <p className="card-meta">Nothing currently charging on a schedule.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {active.map((s) => (
                  <SubscriptionRow
                    key={s.id}
                    sub={s}
                    busy={tracking === s.id}
                    onTrack={() => void trackAsBill(s)}
                    onView={() => onNavigate("transactions", s.accountId ? { accountId: s.accountId } : {})}
                  />
                ))}
              </div>
            )}
          </Panel>

          {stale.length > 0 && (
            <Panel
              title="Possibly cancelled"
              subtitle="These charged regularly, then stopped — worth confirming they're really gone"
            >
              <div style={{ display: "flex", flexDirection: "column" }}>
                {stale.map((s) => (
                  <SubscriptionRow
                    key={s.id}
                    sub={s}
                    busy={tracking === s.id}
                    onTrack={() => void trackAsBill(s)}
                    onView={() => onNavigate("transactions", s.accountId ? { accountId: s.accountId } : {})}
                  />
                ))}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

function SubscriptionRow({
  sub,
  busy,
  onTrack,
  onView,
}: {
  sub: Subscription;
  busy: boolean;
  onTrack: () => void;
  onView: () => void;
}) {
  return (
    <div
      className="row-div"
      style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 2px" }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: "var(--text-base)" }}>{sub.merchantName}</span>
          {sub.billId && <Tag variant="positive">tracked as a bill</Tag>}
          {sub.stale && <Tag variant="warning">no recent charge</Tag>}
          {sub.priceIncreaseCents !== null && !sub.stale && (
            <Tag variant="negative">up {formatCentsWhole(sub.priceIncreaseCents)}</Tag>
          )}
        </div>
        <div
          style={{ fontSize: "var(--text-xs)", color: "var(--content-tertiary)", marginTop: 2 }}
        >
          {sub.cadence} · last charged {shortDate(sub.lastChargedAt)} ·{" "}
          {sub.stale ? "was due" : "next"} {shortDate(sub.nextExpectedAt)}
        </div>
        <div
          style={{ fontSize: "var(--text-2xs)", color: "var(--content-tertiary)", marginTop: 2 }}
        >
          Based on {sub.occurrences} charges · {Math.round(sub.confidence * 100)}% regular
        </div>
      </div>

      <div style={{ textAlign: "right", flex: "none" }}>
        <div className="num" style={{ fontWeight: 600, fontSize: "var(--text-md)" }}>
          {formatCentsWhole(sub.amountCents)}
        </div>
        <div style={{ fontSize: "var(--text-2xs)", color: "var(--content-tertiary)" }}>
          {formatCentsWhole(sub.monthlyCents)}/mo
        </div>
      </div>

      {!sub.billId && (
        <Button variant="secondary" size="sm" onClick={onTrack} disabled={busy}>
          {busy ? <Spinner label="Adding" /> : "Track as bill"}
        </Button>
      )}
      <Button variant="ghost" size="sm" iconEnd="arrowRight" onClick={onView}>
        Charges
      </Button>
    </div>
  );
}
