import {
  formatCents,
  formatCentsWhole,
  parseAmountToCents,
  type Holding,
  type InvestmentAccount,
  type InvestmentsResponse,
} from "@vault/shared";
import { Button, Card, Dialog, Field, Spinner } from "@vault/ui";
import { useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { PageId } from "./AppShell.js";

const SLICE_COLORS = ["#6f8ef2", "#43cfc0", "#b47ef0", "#d8b23c", "#ec6a9c", "#9aa0ab"];

export function InvestmentsPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const client = useApp((s) => s.client);
  const { data, loading, reload } = useData<InvestmentsResponse>(
    () => client.investments(),
    [client],
  );
  const [editing, setEditing] = useState<
    { account: InvestmentAccount; holding: Holding | null } | null
  >(null);

  if (loading && !data) return <Spinner label="Loading investments" />;
  const { accounts = [], totalValueCents = 0, totalCostBasisCents = 0, allocation = [] } =
    data ?? {};

  const gainCents = totalValueCents - totalCostBasisCents;
  const gainPct = totalCostBasisCents > 0 ? (gainCents / totalCostBasisCents) * 100 : null;

  if (accounts.length === 0) {
    return (
      <Card title="No investment accounts yet" style={{ maxWidth: 560, margin: "0 auto" }}>
        <p className="card-body">
          Add an account with type “Investment” on the Accounts page, then
          track holdings and allocation here. Values are entered by you — this
          app never talks to a market-data service.
        </p>
        <div>
          <Button variant="primary" onClick={() => onNavigate("accounts")}>
            Open Accounts
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="page">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 14,
        }}
      >
        <Stat label="Portfolio value" value={formatCentsWhole(totalValueCents)} sub="user-entered valuations" subColor="var(--color-neutral-500)" />
        <Stat label="Cost basis" value={formatCentsWhole(totalCostBasisCents)} sub="total invested" subColor="var(--color-neutral-500)" />
        <Stat
          label="Unrealized gain"
          value={formatCentsWhole(gainCents)}
          sub={gainPct !== null ? `${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(1)}%` : "—"}
          subColor={gainCents >= 0 ? "var(--color-positive)" : "var(--color-negative)"}
        />
      </div>

      {allocation.length > 0 && (
        <div
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-divider)",
            borderRadius: 12,
            boxShadow: "var(--shadow-sm)",
          }}
        >
          <div style={{ padding: "14px 18px 10px", fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 14 }}>
            Allocation
          </div>
          <div style={{ padding: "0 18px 6px" }}>
            <div style={{ display: "flex", height: 14, borderRadius: 99, overflow: "hidden", gap: 2 }}>
              {allocation.map((slice, i) => (
                <div
                  key={slice.symbol}
                  title={`${slice.symbol} · ${(slice.share * 100).toFixed(1)}%`}
                  style={{
                    width: `${slice.share * 100}%`,
                    background: SLICE_COLORS[i % SLICE_COLORS.length],
                  }}
                />
              ))}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, padding: "12px 0 14px" }}>
              {allocation.map((slice, i) => (
                <span
                  key={slice.symbol}
                  style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--color-neutral-400)" }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: SLICE_COLORS[i % SLICE_COLORS.length],
                    }}
                  />
                  {slice.symbol} · {(slice.share * 100).toFixed(1)}%
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {accounts.map((account) => (
        <div
          key={account.id}
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-divider)",
            borderRadius: 12,
            boxShadow: "var(--shadow-sm)",
          }}
        >
          <div
            style={{
              padding: "14px 18px 6px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: 8,
            }}
          >
            <div>
              <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 14 }}>
                {account.name}
              </span>
              {account.institution && (
                <span style={{ fontSize: 12, color: "var(--color-neutral-500)", marginLeft: 8 }}>
                  {account.institution}
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>
                {formatCentsWhole(account.holdingsValueCents)}
              </span>
              <Button variant="ghost" onClick={() => setEditing({ account, holding: null })}>
                + Holding
              </Button>
            </div>
          </div>
          <div style={{ padding: "0 18px 12px" }}>
            {account.holdings.length === 0 ? (
              <p className="text-muted" style={{ fontSize: 12.5, margin: "6px 0" }}>
                No holdings yet.
              </p>
            ) : (
              account.holdings.map((h) => {
                const gain =
                  h.costBasisCents !== null ? h.marketValueCents - h.costBasisCents : null;
                return (
                  <button
                    key={h.id}
                    onClick={() => setEditing({ account, holding: h })}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 12,
                      padding: "10px 0",
                      borderTop: "1px solid color-mix(in srgb, var(--color-text) 7%, transparent)",
                      fontSize: 13,
                      width: "100%",
                      background: "none",
                      border: "none",
                      borderTopStyle: "solid",
                      cursor: "pointer",
                      textAlign: "left",
                      font: "inherit",
                      color: "inherit",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, fontSize: 13.5 }}>
                        {h.symbol}
                        {h.name && (
                          <span style={{ color: "var(--color-neutral-500)", fontWeight: 400, marginLeft: 8 }}>
                            {h.name}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>
                        {h.quantity} units · as of {h.asOfDate}
                      </div>
                    </div>
                    {gain !== null && (
                      <span
                        style={{
                          fontSize: 12.5,
                          color: gain >= 0 ? "var(--color-positive)" : "var(--color-negative)",
                        }}
                      >
                        {formatCents(gain, { signed: true })}
                      </span>
                    )}
                    <span style={{ fontWeight: 600, fontSize: 14 }}>
                      {formatCents(h.marketValueCents)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ))}

      {editing && (
        <HoldingDialog
          account={editing.account}
          holding={editing.holding}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  subColor,
}: {
  label: string;
  value: string;
  sub: string;
  subColor: string;
}) {
  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-divider)",
        borderRadius: 12,
        padding: "16px 18px",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: ".04em",
          textTransform: "uppercase",
          color: "var(--color-neutral-500)",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 24, marginTop: 2 }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: subColor }}>{sub}</div>
    </div>
  );
}

function HoldingDialog({
  account,
  holding,
  onClose,
  onSaved,
}: {
  account: InvestmentAccount;
  holding: Holding | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = useApp((s) => s.client);
  const [symbol, setSymbol] = useState(holding?.symbol ?? "");
  const [name, setName] = useState(holding?.name ?? "");
  const [quantity, setQuantity] = useState(holding?.quantity ?? "");
  const [costBasis, setCostBasis] = useState(
    holding?.costBasisCents != null ? (holding.costBasisCents / 100).toFixed(2) : "",
  );
  const [value, setValue] = useState(
    holding ? (holding.marketValueCents / 100).toFixed(2) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valueCents = parseAmountToCents(value);
  const costCents = costBasis ? parseAmountToCents(costBasis) : null;
  const valid =
    symbol.trim() &&
    /^\d+(\.\d{1,6})?$/.test(quantity.trim()) &&
    valueCents !== null &&
    valueCents >= 0 &&
    (costBasis === "" || costCents !== null);

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        symbol: symbol.trim(),
        name: name.trim() || null,
        quantity: quantity.trim(),
        costBasisCents: costBasis ? costCents : null,
        marketValueCents: valueCents!,
      };
      if (holding) {
        await client.updateHolding(holding.id, payload);
      } else {
        await client.createHolding(account.id, payload);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!holding || busy) return;
    setBusy(true);
    try {
      await client.deleteHolding(holding.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={holding ? `Edit ${holding.symbol}` : `Add holding to ${account.name}`}
      onClose={onClose}
      actions={
        <>
          {holding && (
            <Button variant="ghost" onClick={() => void remove()} disabled={busy}>
              Delete
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!valid || busy}>
            {busy ? <Spinner label="Saving" /> : "Save"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ width: 120 }}>
            <Field
              label="Symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              autoFocus={!holding}
              placeholder="VTI"
            />
          </div>
          <div style={{ flex: 1 }}>
            <Field
              label="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Total Market ETF"
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Field
              label="Quantity"
              value={quantity}
              inputMode="decimal"
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="10.5"
            />
          </div>
          <div style={{ flex: 1 }}>
            <Field
              label="Cost basis (optional)"
              value={costBasis}
              inputMode="decimal"
              onChange={(e) => setCostBasis(e.target.value)}
              placeholder="2000.00"
            />
          </div>
        </div>
        <Field
          label="Current value"
          value={value}
          inputMode="decimal"
          onChange={(e) => setValue(e.target.value)}
          placeholder="2600.00"
          hint="Entered by you — no market-data feeds, ever. Update it whenever you check your brokerage."
          error={
            value && (valueCents === null || valueCents < 0)
              ? "Enter an amount like 2600.00"
              : undefined
          }
        />
        {error && (
          <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)" }}>
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
