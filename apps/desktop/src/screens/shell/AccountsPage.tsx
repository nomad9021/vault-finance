import {
  ACCOUNT_TYPE_LABELS,
  AccountType,
  formatCents,
  formatCentsWhole,
  parseAmountToCents,
  type Account,
} from "@vault/shared";
import { Button, Card, Dialog, Field, Select, Spinner } from "@vault/ui";
import { useMemo, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";

const TYPE_ICONS: Record<AccountType, string> = {
  checking: "💳",
  savings: "🏦",
  credit_card: "💠",
  investment: "📈",
  loan: "📄",
  mortgage: "🏠",
  other: "📁",
};

const GROUPS: Array<{ title: string; types: AccountType[] }> = [
  { title: "Cash", types: ["checking", "savings"] },
  { title: "Credit cards", types: ["credit_card"] },
  { title: "Investments", types: ["investment"] },
  { title: "Loans & mortgages", types: ["loan", "mortgage"] },
  { title: "Other", types: ["other"] },
];

export function AccountsPage() {
  const client = useApp((s) => s.client);
  const { data, loading, reload } = useData(() => client.accounts(), [client]);
  const [editing, setEditing] = useState<Account | "new" | null>(null);

  const accounts = data?.accounts ?? [];
  const stats = useMemo(() => {
    const assets = accounts
      .filter((a) => !a.isLiability)
      .reduce((sum, a) => sum + a.balanceCents, 0);
    const liabilities = accounts
      .filter((a) => a.isLiability)
      .reduce((sum, a) => sum + a.balanceCents, 0);
    return { assets, liabilities, netWorth: assets + liabilities };
  }, [accounts]);

  if (loading && !data) {
    return <Spinner label="Loading accounts" />;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        maxWidth: 980,
        margin: "0 auto",
        animation: "fadeUp .3s both",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 14,
        }}
      >
        <StatCard label="Assets" value={formatCentsWhole(stats.assets)} />
        <StatCard label="Liabilities" value={formatCentsWhole(stats.liabilities)} />
        <StatCard label="Net worth" value={formatCentsWhole(stats.netWorth)} />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button variant="primary" onClick={() => setEditing("new")}>
          + Add account
        </Button>
      </div>

      {accounts.length === 0 ? (
        <Card title="No accounts yet">
          <p className="card-body">
            Add your checking account, savings, credit cards, and loans to see
            your full financial picture.
          </p>
        </Card>
      ) : (
        GROUPS.map((group) => {
          const rows = accounts.filter((a) => group.types.includes(a.type));
          if (rows.length === 0) return null;
          return (
            <div
              key={group.title}
              style={{
                background: "var(--color-surface)",
                border: "1px solid var(--color-divider)",
                borderRadius: 12,
                boxShadow: "var(--shadow-sm)",
              }}
            >
              <div
                style={{
                  padding: "14px 18px 8px",
                  fontFamily: "var(--font-heading)",
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                {group.title}
              </div>
              <div style={{ padding: "0 18px 10px" }}>
                {rows.map((account) => (
                  <button
                    key={account.id}
                    onClick={() => setEditing(account)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "11px 0",
                      borderTop:
                        "1px solid color-mix(in srgb, var(--color-text) 7%, transparent)",
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
                    <span
                      aria-hidden="true"
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 9,
                        background: "var(--color-accent-900)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 14,
                        flex: "none",
                      }}
                    >
                      {TYPE_ICONS[account.type]}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, fontSize: 13.5 }}>{account.name}</div>
                      <div style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>
                        {[
                          ACCOUNT_TYPE_LABELS[account.type],
                          account.institution,
                          account.mask ? `••${account.mask}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          color:
                            account.balanceCents < 0
                              ? "var(--color-negative)"
                              : "var(--color-text)",
                        }}
                      >
                        {formatCents(account.balanceCents, { currency: account.currency })}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })
      )}

      {editing && (
        <AccountDialog
          account={editing === "new" ? null : editing}
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

function StatCard({ label, value }: { label: string; value: string }) {
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
      <div
        style={{
          fontFamily: "var(--font-heading)",
          fontWeight: 600,
          fontSize: 24,
          letterSpacing: "-.02em",
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function AccountDialog({
  account,
  onClose,
  onSaved,
}: {
  account: Account | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = useApp((s) => s.client);
  const [name, setName] = useState(account?.name ?? "");
  const [type, setType] = useState<AccountType>(account?.type ?? "checking");
  const [institution, setInstitution] = useState(account?.institution ?? "");
  const [mask, setMask] = useState(account?.mask ?? "");
  const [balance, setBalance] = useState(
    account ? (account.balanceCents / 100).toFixed(2) : "0.00",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const balanceCents = parseAmountToCents(balance);
  const valid = name.trim().length > 0 && balanceCents !== null;

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        type,
        institution: institution.trim() || null,
        mask: mask.trim() || null,
        balanceCents: balanceCents!,
      };
      if (account) {
        await client.updateAccount(account.id, payload);
      } else {
        await client.createAccount(payload);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!account || busy) return;
    setBusy(true);
    try {
      await client.deleteAccount(account.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={account ? "Edit account" : "Add account"}
      onClose={onClose}
      actions={
        <>
          {account && (
            <Button variant="ghost" onClick={() => void archive()} disabled={busy}>
              {account.archivedAt ? "Delete" : "Archive"}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!valid || busy}>
            {busy ? <Spinner label="Saving" /> : account ? "Save" : "Add account"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder="Everyday Checking"
        />
        <Select
          label="Type"
          value={type}
          onChange={(e) => setType(e.target.value as AccountType)}
        >
          {AccountType.options.map((t) => (
            <option key={t} value={t}>
              {ACCOUNT_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Field
              label="Institution (optional)"
              value={institution}
              onChange={(e) => setInstitution(e.target.value)}
              placeholder="First Local Bank"
            />
          </div>
          <div style={{ width: 110 }}>
            <Field
              label="Last 4 (optional)"
              value={mask}
              maxLength={4}
              onChange={(e) => setMask(e.target.value.replace(/\D/g, ""))}
            />
          </div>
        </div>
        <Field
          label={account ? "Current balance" : "Starting balance"}
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          inputMode="decimal"
          error={balanceCents === null ? "Enter an amount like 1250.00" : undefined}
          hint="Use a negative amount for money owed (credit cards, loans)."
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
