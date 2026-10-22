import {
  ApiRequestError,
  formatCents,
  parseAmountToCents,
  type PreIncome,
  type PreIncomeKind,
} from "@vault/shared";
import { Button, Dialog, Spinner } from "@vault/ui";
import { useState } from "react";
import { useApp } from "../../state/store.js";

const KINDS: Array<{ value: PreIncomeKind; label: string }> = [
  { value: "tax", label: "Tax" },
  { value: "pretax", label: "Pre-tax" },
  { value: "deduction", label: "Deduction" },
];

interface Row {
  id: string;
  name: string;
  kind: PreIncomeKind;
  amount: string;
}

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 36);

/**
 * "Before income": the taxes and paycheck deductions (from a pay stub) that
 * come out of pay before it reaches income. Both Sankeys draw them first,
 * beside the tax profile's estimate or instead of it.
 */
export function PreIncomeDialog({
  value,
  hasEstimate,
  onClose,
  onSaved,
}: {
  value: PreIncome;
  /** Whether a tax profile estimate exists (otherwise the switch is hidden). */
  hasEstimate: boolean;
  onClose: () => void;
  onSaved: (saved: PreIncome) => void;
}) {
  const client = useApp((s) => s.client);
  const [rows, setRows] = useState<Row[]>(() =>
    value.items.map((i) => ({ id: i.id, name: i.name, kind: i.kind, amount: (i.monthlyCents / 100).toFixed(2) })),
  );
  const [useEstimate, setUseEstimate] = useState(value.useEstimate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const total = rows.reduce((s, r) => s + (parseAmountToCents(r.amount || "0") ?? 0), 0);
  const invalid = rows.some((r) => !r.name.trim() || parseAmountToCents(r.amount || "0") === null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await client.savePreIncome({
        useEstimate,
        items: rows.map((r) => ({ id: r.id, name: r.name.trim(), kind: r.kind, monthlyCents: parseAmountToCents(r.amount || "0") ?? 0 })),
      });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="Before income"
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || invalid}>
            {busy ? <Spinner label="Saving" /> : "Save"}
          </Button>
        </>
      }
    >
      <p className="card-meta" style={{ marginTop: 0 }}>
        Taxes and deductions taken out of pay before it reaches your income. They show on the left of both Sankeys, coming off
        gross pay. Enter monthly amounts (per paycheck × paychecks a month — biweekly is about 2.17).
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r) => (
          <div key={r.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 108px 84px auto", gap: 6, alignItems: "center" }}>
            <input
              className="input"
              aria-label="Name"
              value={r.name}
              placeholder="Federal withholding"
              onChange={(e) => update(r.id, { name: e.target.value })}
            />
            <select className="input" aria-label="Type" style={{ paddingRight: 24 }} value={r.kind} onChange={(e) => update(r.id, { kind: e.target.value as PreIncomeKind })}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            <input
              className="input"
              aria-label="Monthly amount"
              inputMode="decimal"
              value={r.amount}
              placeholder="0.00"
              onChange={(e) => update(r.id, { amount: e.target.value })}
            />
            <Button variant="ghost" size="sm" icon="trash" aria-label={`Remove ${r.name || "item"}`} onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} />
          </div>
        ))}
        <div className="row-between">
          <Button
            variant="ghost"
            size="sm"
            icon="plus"
            disabled={rows.length >= 30}
            onClick={() => setRows((rs) => [...rs, { id: newId(), name: "", kind: "tax", amount: "" }])}
          >
            Add item
          </Button>
          {rows.length > 0 && <span className="card-meta">{formatCents(total)} a month</span>}
        </div>
      </div>
      {hasEstimate && (
        <label className="radio" style={{ fontSize: "var(--text-sm)", marginTop: 12 }}>
          <input type="checkbox" checked={useEstimate} onChange={(e) => setUseEstimate(e.target.checked)} />
          <span className="dot" style={{ borderRadius: "var(--radius-sm)" }} />
          Also show the estimated taxes from Salary &amp; taxes (turn off if these items are your real figures)
        </label>
      )}
      {error && <p role="alert" style={{ color: "var(--color-negative)", fontSize: "var(--text-sm)" }}>{error}</p>}
    </Dialog>
  );
}
