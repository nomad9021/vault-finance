import {
  formatCents,
  formatCentsWhole,
  type Category,
  type Transaction,
} from "@vault/shared";
import { Button, Card, Select, Spinner } from "@vault/ui";
import { useMemo, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { Navigate } from "./AppShell.js";

const SOURCE_COLORS = ["#3ecf8e", "#43cfc0", "#6f8ef2", "#b47ef0", "#ec6a9c", "#d8b23c", "#4db6d0"];

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
function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/**
 * Income sources — the counterpart to spending categories. Income-kind
 * categories are the "sources" (Salary, Side Income, Gifts…); every income
 * transaction can be assigned to one, and the totals link straight through to
 * the underlying transactions. This is also where sources are created/reordered.
 */
export function IncomePage({ onNavigate }: { onNavigate: Navigate }) {
  const client = useApp((s) => s.client);
  const [month, setMonth] = useState(currentMonth());
  const { from, to } = monthBounds(month);

  const { data: catData, reload: reloadCats } = useData(() => client.categories(), [client]);
  const {
    data: txnData,
    loading,
    reload: reloadTxns,
  } = useData(() => client.transactions({ from, to, limit: 200 }), [client, from, to]);
  const { data: acctData } = useData(() => client.accounts(true), [client]);

  const categories = (catData?.categories ?? []) as Category[];
  const sources = categories
    .filter((c) => c.kind === "income")
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const accountById = new Map((acctData?.accounts ?? []).map((a) => [a.id, a]));
  const incomeTxns = useMemo(
    () => (txnData?.transactions ?? []).filter((t) => t.amountCents > 0),
    [txnData],
  );

  // Per-source totals for the month + the unassigned ("Other income") bucket.
  const totals = new Map<string, number>();
  let otherCents = 0;
  const sourceIds = new Set(sources.map((s) => s.id));
  for (const t of incomeTxns) {
    if (t.categoryId && sourceIds.has(t.categoryId)) {
      totals.set(t.categoryId, (totals.get(t.categoryId) ?? 0) + t.amountCents);
    } else {
      otherCents += t.amountCents;
    }
  }
  const totalIncome = incomeTxns.reduce((s, t) => s + t.amountCents, 0);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch {
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const addSource = () =>
    run(async () => {
      await client.createCategory({
        name: "New source",
        color: SOURCE_COLORS[sources.length % SOURCE_COLORS.length]!,
        kind: "income",
      });
      await reloadCats();
    }, "Couldn't add the source.");
  const renameSource = (id: string, name: string) =>
    run(async () => {
      await client.updateCategory(id, { name });
      await reloadCats();
    }, "Couldn't rename.");
  const removeSource = (id: string) =>
    run(async () => {
      await client.deleteCategory(id);
      await reloadCats();
    }, "That source is in use — reassign its income first.");
  const moveSource = (id: string, direction: "up" | "down") =>
    run(async () => {
      await client.moveCategory(id, direction);
      await reloadCats();
    }, "Couldn't reorder.");
  const assign = (txnId: string, categoryId: string) =>
    run(async () => {
      await client.updateTransaction(txnId, { categoryId: categoryId || null });
      await reloadTxns();
    }, "Couldn't assign that income.");

  if (loading && !txnData) return <Spinner label="Loading income" />;

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="ghost" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
          ‹
        </Button>
        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15, minWidth: 150, textAlign: "center" }}>
          {monthLabel(month)}
        </div>
        <Button variant="ghost" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
          ›
        </Button>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--color-neutral-500)", fontWeight: 600 }}>
            Total income
          </div>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 22, color: "var(--color-positive)" }}>
            {formatCentsWhole(totalIncome)}
          </div>
        </div>
      </div>

      {/* Income by source */}
      <Card kicker="Income" title="By source">
        <p className="card-meta">
          Each source is an income category — rename them to match your world (a person’s job, a
          side gig, gifts). Totals link straight to the transactions behind them.
        </p>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
          {sources.length === 0 && otherCents === 0 ? (
            <p className="card-meta">No income this month.</p>
          ) : (
            <>
              {sources.map((s) => (
                <SourceRow
                  key={s.id}
                  name={s.name}
                  color={s.color}
                  cents={totals.get(s.id) ?? 0}
                  onView={() => onNavigate("transactions", { categoryId: s.id })}
                />
              ))}
              {otherCents > 0 && (
                <SourceRow
                  name="Other income (unassigned)"
                  color="#9aa0ab"
                  cents={otherCents}
                  onView={() => onNavigate("transactions", { categoryId: "none" })}
                />
              )}
            </>
          )}
        </div>
      </Card>

      {/* Itemized income transactions with a source picker */}
      <Card kicker="This month" title="Income items">
        {incomeTxns.length === 0 ? (
          <p className="card-meta">No income recorded for {monthLabel(month)}.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
            {incomeTxns.map((t) => (
              <IncomeItem
                key={t.id}
                txn={t}
                accountName={accountById.get(t.accountId)?.name ?? "—"}
                sources={sources}
                busy={busy}
                onAssign={(cid) => assign(t.id, cid)}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Manage sources */}
      <Card kicker="Sources" title="Manage income sources">
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
          {sources.map((s, i) => (
            <ManageRow
              key={s.id}
              source={s}
              isFirst={i === 0}
              isLast={i === sources.length - 1}
              busy={busy}
              onRename={(name) => renameSource(s.id, name)}
              onRemove={() => removeSource(s.id)}
              onMove={(dir) => moveSource(s.id, dir)}
            />
          ))}
        </div>
        <div style={{ marginTop: 10 }}>
          <Button variant="secondary" onClick={() => void addSource()} disabled={busy}>
            ＋ Add income source
          </Button>
        </div>
        {error && (
          <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)", marginTop: 8 }}>
            {error}
          </div>
        )}
      </Card>
    </div>
  );
}

function SourceRow({
  name,
  color,
  cents,
  onView,
}: {
  name: string;
  color: string;
  cents: number;
  onView: () => void;
}) {
  return (
    <button
      onClick={onView}
      title="View this source's transactions"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 4px",
        borderTop: "1px solid color-mix(in srgb, var(--color-text) 7%, transparent)",
        background: "none",
        border: 0,
        borderTopStyle: "solid",
        font: "inherit",
        color: "inherit",
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
      }}
    >
      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: color, flex: "none" }} />
      <span style={{ flex: 1, minWidth: 0, fontWeight: 500, fontSize: 13.5 }}>{name}</span>
      <span style={{ fontWeight: 600, fontSize: 14, color: "var(--color-positive)" }}>
        {formatCentsWhole(cents)}
      </span>
      <span style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>→</span>
    </button>
  );
}

function IncomeItem({
  txn,
  accountName,
  sources,
  busy,
  onAssign,
}: {
  txn: Transaction;
  accountName: string;
  sources: Category[];
  busy: boolean;
  onAssign: (categoryId: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 0",
        borderTop: "1px solid color-mix(in srgb, var(--color-text) 7%, transparent)",
        fontSize: 13,
      }}
    >
      <span style={{ color: "var(--color-neutral-500)", flex: "none", width: 44 }}>
        {txn.postedAt.slice(5)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {txn.merchantName}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--color-neutral-500)" }}>{accountName}</div>
      </div>
      <Select
        aria-label="Income source"
        value={txn.categoryId ?? ""}
        disabled={busy}
        onChange={(e) => onAssign(e.target.value)}
        style={{ width: 150, fontSize: 12.5 }}
      >
        <option value="">Unassigned</option>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
      <span style={{ fontWeight: 600, whiteSpace: "nowrap", color: "var(--color-positive)", width: 88, textAlign: "right" }}>
        {formatCents(txn.amountCents, { signed: true })}
      </span>
    </div>
  );
}

function ManageRow({
  source,
  isFirst,
  isLast,
  busy,
  onRename,
  onRemove,
  onMove,
}: {
  source: Category;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
  onMove: (direction: "up" | "down") => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(source.name);
  const iconBtn = {
    border: 0,
    background: "none",
    cursor: "pointer",
    color: "var(--color-neutral-400)",
    font: "inherit",
    fontSize: 14,
    padding: "0 3px",
  } as const;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 9px",
        border: "1px solid var(--color-divider)",
        borderRadius: 8,
        background: "var(--color-surface)",
      }}
    >
      <span style={{ width: 10, height: 10, borderRadius: 3, background: source.color, flex: "none" }} />
      {editing ? (
        <input
          autoFocus
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft.trim() && draft.trim() !== source.name) onRename(draft.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setDraft(source.name);
              setEditing(false);
            }
          }}
          style={{ width: 180, padding: "2px 6px", fontSize: 13 }}
        />
      ) : (
        <button
          onClick={() => {
            setDraft(source.name);
            setEditing(true);
          }}
          title="Rename"
          style={{ background: "none", border: 0, font: "inherit", fontWeight: 600, fontSize: 13, cursor: "text", color: "var(--color-text)", flex: 1, textAlign: "left" }}
        >
          {source.name}
        </button>
      )}
      <button title="Move up" disabled={isFirst} onClick={() => onMove("up")} style={{ ...iconBtn, opacity: isFirst ? 0.25 : 1 }}>
        ▲
      </button>
      <button title="Move down" disabled={isLast} onClick={() => onMove("down")} style={{ ...iconBtn, opacity: isLast ? 0.25 : 1 }}>
        ▼
      </button>
      <button title="Delete" disabled={busy} onClick={onRemove} style={{ ...iconBtn, color: "var(--color-negative)" }}>
        ×
      </button>
    </div>
  );
}
