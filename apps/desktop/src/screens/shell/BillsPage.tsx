import {
  formatCents,
  formatCentsWhole,
  parseAmountToCents,
  type Account,
  type Bill,
  type BillCadence,
} from "@vault/shared";
import { Button, Dialog, Field, MetricCard, Panel, Select, Spinner } from "@vault/ui";
import { useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";

const BILL_COLORS = ["#6f8ef2", "#ef8354", "#3ecf8e", "#c96f9c", "#d8b23c", "#4db6d0", "#b47ef0"];
const CADENCES: BillCadence[] = ["weekly", "monthly", "quarterly", "yearly"];

function dueLabel(days: number): { text: string; tone: "over" | "soon" | "ok" } {
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, tone: "over" };
  if (days === 0) return { text: "Due today", tone: "over" };
  if (days === 1) return { text: "Due tomorrow", tone: "soon" };
  if (days <= 7) return { text: `Due in ${days} days`, tone: "soon" };
  return { text: `Due in ${days} days`, tone: "ok" };
}

function dueDateShort(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Bills — track recurring obligations, when each is next due, and how much has
 * been set aside toward it (a sinking fund). Set-aside progress is manual via
 * "Set aside" contributions.
 */
export function BillsPage() {
  const client = useApp((s) => s.client);
  const { data, loading, reload } = useData(() => client.bills(), [client]);
  const { data: acctData } = useData(() => client.accounts(true), [client]);
  const [editing, setEditing] = useState<Bill | "new" | null>(null);
  const [funding, setFunding] = useState<Bill | null>(null);

  if (loading && !data) return <Spinner label="Loading bills" />;

  const bills = data?.bills ?? [];
  const accounts = acctData?.accounts ?? [];
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const totalDue = data?.totalDueCents ?? 0;
  const totalSaved = data?.totalSavedCents ?? 0;
  const remaining = Math.max(0, totalDue - totalSaved);

  return (
    <div className="page">
      <div className="page-head">
        <div className="grid" style={{ flex: 1, minWidth: 0 }}>
          <div style={{ gridColumn: "span 4", minWidth: 0 }}>
            <MetricCard label="Upcoming bills" value={formatCentsWhole(totalDue)} hint={`${bills.length} tracked`} />
          </div>
          <div style={{ gridColumn: "span 4", minWidth: 0 }}>
            <MetricCard label="Set aside" value={formatCentsWhole(totalSaved)} deltaTone="up" hint="saved toward bills" />
          </div>
          <div style={{ gridColumn: "span 4", minWidth: 0 }}>
            <MetricCard label="Still needed" value={formatCentsWhole(remaining)} deltaTone={remaining > 0 ? "down" : "up"} hint="to fully fund" />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button variant="primary" onClick={() => setEditing("new")}>
          + Add bill
        </Button>
      </div>

      <Panel title="Upcoming bills" subtitle="Sorted by next due date">
        {bills.length === 0 ? (
          <p className="card-meta">
            No bills yet. Add your rent, utilities, subscriptions and loans to see when they’re due
            and track what you’ve set aside.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {bills.map((b) => {
              const due = dueLabel(b.daysUntilDue);
              const pct = b.amountCents > 0 ? Math.min(1, b.savedCents / b.amountCents) : 0;
              const funded = b.savedCents >= b.amountCents;
              const dueColor =
                due.tone === "over"
                  ? "var(--color-negative)"
                  : due.tone === "soon"
                    ? "var(--color-accent)"
                    : "var(--color-neutral-500)";
              return (
                <div
                  key={b.id}
                  className="row-div"
                  style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 2px" }}
                >
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: b.color, flex: "none" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button
                        onClick={() => setEditing(b)}
                        title="Edit bill"
                        style={{ background: "none", border: 0, font: "inherit", fontWeight: 600, fontSize: 14, cursor: "pointer", color: "var(--color-text)", padding: 0 }}
                      >
                        {b.name}
                      </button>
                      {b.autopay && (
                        <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--color-positive)", border: "1px solid color-mix(in srgb, var(--color-positive) 40%, transparent)", borderRadius: 6, padding: "1px 6px" }}>
                          autopay
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--color-neutral-500)", marginTop: 1 }}>
                      {dueDateShort(b.nextDueDate)} · {b.cadence}
                      {b.accountId ? ` · ${accountName.get(b.accountId) ?? ""}` : ""}
                    </div>
                    {/* set-aside progress */}
                    <div style={{ height: 6, borderRadius: 99, marginTop: 7, background: "color-mix(in srgb, var(--color-text) 8%, transparent)", overflow: "hidden", maxWidth: 340 }}>
                      <div style={{ height: "100%", width: `${pct * 100}%`, borderRadius: 99, background: funded ? "var(--color-positive)" : b.color, transition: "width .4s var(--ease)" }} />
                    </div>
                    <div style={{ fontSize: 11, color: "var(--color-neutral-500)", marginTop: 3 }}>
                      {formatCentsWhole(b.savedCents)} of {formatCentsWhole(b.amountCents)} set aside
                      {funded ? " · fully funded 🎉" : ""}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flex: "none" }}>
                    <div className="num" style={{ fontWeight: 600, fontSize: 15 }}>
                      {formatCentsWhole(b.amountCents)}
                    </div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: dueColor }}>{due.text}</div>
                  </div>
                  <button
                    onClick={() => setFunding(b)}
                    title="Set money aside for this bill"
                    style={{ flex: "none", border: "1px solid var(--color-divider)", background: "var(--color-surface)", borderRadius: 7, padding: "5px 10px", fontSize: 12, fontWeight: 600, color: "var(--color-accent)", cursor: "pointer", whiteSpace: "nowrap" }}
                  >
                    + Set aside
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {editing && (
        <BillDialog
          bill={editing === "new" ? null : editing}
          accounts={accounts.filter((a) => !a.archivedAt)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      {funding && (
        <FundDialog
          bill={funding}
          onClose={() => setFunding(null)}
          onSaved={() => {
            setFunding(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function BillDialog({
  bill,
  accounts,
  onClose,
  onSaved,
}: {
  bill: Bill | null;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = useApp((s) => s.client);
  const [name, setName] = useState(bill?.name ?? "");
  const [amount, setAmount] = useState(bill ? (bill.amountCents / 100).toFixed(2) : "");
  const [saved, setSaved] = useState(bill ? (bill.savedCents / 100).toFixed(2) : "0");
  const [dueDay, setDueDay] = useState(String(bill?.dueDay ?? 1));
  const [cadence, setCadence] = useState<BillCadence>(bill?.cadence ?? "monthly");
  const [autopay, setAutopay] = useState(bill?.autopay ?? false);
  const [accountId, setAccountId] = useState(bill?.accountId ?? "");
  const [color, setColor] = useState(bill?.color ?? BILL_COLORS[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountCents = parseAmountToCents(amount) ?? -1;
  const savedCents = parseAmountToCents(saved) ?? 0;
  const day = Number(dueDay);
  const valid = name.trim() && amountCents > 0 && day >= 1 && day <= 31;

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      amountCents,
      savedCents: Math.max(0, savedCents),
      dueDay: day,
      cadence,
      autopay,
      accountId: accountId || null,
      color,
    };
    try {
      if (bill) await client.updateBill(bill.id, body);
      else await client.createBill(body);
      onSaved();
    } catch {
      setError("Couldn't save the bill.");
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!bill) return;
    setBusy(true);
    await client.deleteBill(bill.id).catch(() => setError("Couldn't delete."));
    onSaved();
  };

  return (
    <Dialog open title={bill ? "Edit bill" : "Add bill"} onClose={onClose}>
      <Field
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Rent, Electric, Netflix…"
        autoFocus
      />
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <Field
            label="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
          />
        </div>
        <div style={{ width: 120 }}>
          <Field
            label="Due day (1–31)"
            value={dueDay}
            onChange={(e) => setDueDay(e.target.value.replace(/[^0-9]/g, ""))}
            inputMode="numeric"
          />
        </div>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <Select
            label="Frequency"
            value={cadence}
            onChange={(e) => setCadence(e.target.value as BillCadence)}
          >
            {CADENCES.map((c) => (
              <option key={c} value={c}>
                {c[0]!.toUpperCase() + c.slice(1)}
              </option>
            ))}
          </Select>
        </div>
        <div style={{ flex: 1 }}>
          <Field
            label="Already set aside"
            value={saved}
            onChange={(e) => setSaved(e.target.value)}
            inputMode="decimal"
          />
        </div>
      </div>
      <Select
        label="Pay from account (optional)"
        value={accountId}
        onChange={(e) => setAccountId(e.target.value)}
      >
        <option value="">None</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <label className="radio" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={autopay} onChange={(e) => setAutopay(e.target.checked)} style={{ position: "static", width: "auto", height: "auto", opacity: 1 }} />
          Autopay enabled
        </label>
        <div style={{ display: "flex", gap: 6 }}>
          {BILL_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              aria-label={`color ${c}`}
              style={{ width: 20, height: 20, borderRadius: 6, background: c, border: color === c ? "2px solid var(--color-text)" : "2px solid transparent", cursor: "pointer" }}
            />
          ))}
        </div>
      </div>
      {error && <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)" }}>{error}</div>}
      <div className="dialog-actions">
        {bill && (
          <Button variant="ghost" onClick={() => void remove()} disabled={busy}>
            Delete
          </Button>
        )}
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={!valid || busy}>
          {bill ? "Save" : "Add bill"}
        </Button>
      </div>
    </Dialog>
  );
}

function FundDialog({ bill, onClose, onSaved }: { bill: Bill; onClose: () => void; onSaved: () => void }) {
  const client = useApp((s) => s.client);
  const shortfall = Math.max(0, bill.amountCents - bill.savedCents);
  const [amount, setAmount] = useState((shortfall / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const cents = parseAmountToCents(amount) ?? 0;

  const contribute = async (delta: number) => {
    setBusy(true);
    await client.contributeBill(bill.id, delta).catch(() => {});
    onSaved();
  };

  return (
    <Dialog open title={`Set aside for ${bill.name}`} onClose={onClose}>
      <p className="dialog-body">
        {formatCents(bill.savedCents)} of {formatCents(bill.amountCents)} set aside.
        {shortfall > 0 ? ` ${formatCents(shortfall)} to go.` : " Fully funded."}
      </p>
      <Field
        label="Amount to add"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal"
        autoFocus
      />
      <div className="dialog-actions">
        {shortfall > 0 && (
          <Button variant="ghost" onClick={() => void contribute(shortfall)} disabled={busy}>
            Fund fully
          </Button>
        )}
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void contribute(cents)} disabled={busy || cents === 0}>
          Set aside
        </Button>
      </div>
    </Dialog>
  );
}
