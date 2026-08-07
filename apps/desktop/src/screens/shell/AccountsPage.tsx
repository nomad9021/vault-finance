import {
  ACCOUNT_TYPE_LABELS,
  AccountType,
  formatCents,
  formatCentsWhole,
  parseAmountToCents,
  type Account,
} from "@vault/shared";
import {
  Button,
  Card,
  Dialog,
  Field,
  Icon,
  type IconName,
  MetricCard,
  Panel,
  Select,
  Spinner,
} from "@vault/ui";
import { useMemo, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { Navigate } from "./AppShell.js";
import { TrendChart, project } from "./TrendChart.js";

const TYPE_ICONS: Record<AccountType, IconName> = {
  checking: "card",
  savings: "bank",
  credit_card: "card",
  investment: "invest",
  loan: "receipt",
  mortgage: "home",
  other: "wallet",
};

const GROUPS: Array<{ title: string; types: AccountType[]; color: string; liability: boolean }> = [
  { title: "Cash", types: ["checking", "savings"], color: "#3ecf8e", liability: false },
  { title: "Investments", types: ["investment"], color: "#6f8ef2", liability: false },
  { title: "Other assets", types: ["other"], color: "#d8b23c", liability: false },
  { title: "Credit cards", types: ["credit_card"], color: "#ec6a9c", liability: true },
  { title: "Loans & mortgages", types: ["loan", "mortgage"], color: "#e25c5c", liability: true },
];

const COLLAPSE_KEY = "accounts-collapsed";
function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function AccountsPage({ onNavigate }: { onNavigate: Navigate }) {
  const client = useApp((s) => s.client);
  const { data, loading, reload } = useData(() => client.accounts(), [client]);
  const { data: trendData } = useData(() => client.trends(6), [client]);
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);

  const toggleGroup = (title: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(title) ? next.delete(title) : next.add(title);
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });

  const accounts = data?.accounts ?? [];
  const visibleAccounts = accounts.filter((a) => a.balanceCents !== 0);
  const stats = useMemo(() => {
    const assets = accounts.filter((a) => !a.isLiability).reduce((sum, a) => sum + a.balanceCents, 0);
    const liabilities = accounts.filter((a) => a.isLiability).reduce((sum, a) => sum + a.balanceCents, 0);
    return { assets, liabilities, netWorth: assets + liabilities };
  }, [accounts]);

  // Per-group subtotals, split into asset and liability allocation bars.
  const alloc = useMemo(() => {
    const rows = GROUPS.map((g) => ({
      ...g,
      subtotal: accounts.filter((a) => g.types.includes(a.type)).reduce((s, a) => s + a.balanceCents, 0),
    }));
    return {
      assets: rows.filter((r) => !r.liability && r.subtotal > 0),
      liabilities: rows.filter((r) => r.liability && r.subtotal < 0),
    };
  }, [accounts]);

  const nwHistory = (trendData?.points ?? []).map((p) => p.netWorthCents);
  const nwProjected = project(nwHistory, 3);
  const nwChange = nwHistory.length >= 2 ? (nwHistory[nwHistory.length - 1] ?? 0) - (nwHistory[0] ?? 0) : 0;
  const nwPct = nwHistory.length >= 2 ? (nwChange / (Math.abs(nwHistory[0] ?? 0) || 1)) * 100 : 0;

  if (loading && !data) {
    return <Spinner label="Loading accounts" />;
  }

  return (
    <div className="page">
      {/* Net-worth hero + assets / liabilities */}
      <div className="grid">
        <div className="col-6">
          <MetricCard large label="Net worth" value={formatCentsWhole(stats.netWorth)} hint="assets − liabilities" />
        </div>
        <div className="col-3">
          <MetricCard label="Assets" value={formatCentsWhole(stats.assets)} deltaTone="up" />
        </div>
        <div className="col-3">
          <MetricCard label="Liabilities" value={formatCentsWhole(stats.liabilities)} deltaTone="down" />
        </div>
      </div>

      {/* Net-worth performance chart */}
      {accounts.length > 0 && (
        <Panel
          title="Net worth trend"
          subtitle="Last 6 months · dashed = projected"
          actions={
            nwHistory.length >= 2 ? (
              <span className={`stat-delta ${nwChange >= 0 ? "pos" : "neg"}`}>
                <Icon name={nwChange >= 0 ? "trendUp" : "trendDown"} size={14} />
                {formatCentsWhole(Math.abs(nwChange))} ({nwPct >= 0 ? "+" : ""}
                {nwPct.toFixed(0)}%)
              </span>
            ) : undefined
          }
        >
          <TrendChart history={nwHistory} projected={nwProjected} color="var(--color-positive)" height={150} emptyLabel="Not enough history yet — add transactions to build the trend." />
        </Panel>
      )}

      {/* Allocation + liabilities */}
      {(alloc.assets.length > 0 || alloc.liabilities.length > 0) && (
        <div className="grid">
          <div className="col-6">
            <AllocationPanel title="Asset allocation" rows={alloc.assets} total={stats.assets} />
          </div>
          <div className="col-6">
            <AllocationPanel title="Liabilities" rows={alloc.liabilities.map((r) => ({ ...r, subtotal: Math.abs(r.subtotal) }))} total={Math.abs(stats.liabilities)} emptyLabel="No debts — you're all assets." />
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>
          Add account
        </Button>
      </div>

      {accounts.length === 0 ? (
        <Card title="No accounts yet">
          <p className="card-body">
            Add your checking account, savings, credit cards, and loans to see your full financial picture.
          </p>
        </Card>
      ) : visibleAccounts.length === 0 ? (
        <Card title="All accounts are at $0">
          <p className="card-body">
            Accounts with a zero balance are hidden here. Record a transaction or edit a balance and the account reappears.
          </p>
        </Card>
      ) : (
        GROUPS.map((group) => {
          const rows = visibleAccounts.filter((a) => group.types.includes(a.type));
          if (rows.length === 0) return null;
          const subtotal = rows.reduce((s, a) => s + a.balanceCents, 0);
          const isCollapsed = collapsed.has(group.title);
          return (
            <Panel
              key={group.title}
              flush
              title={
                <button
                  onClick={() => toggleGroup(group.title)}
                  aria-expanded={!isCollapsed}
                  style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: 0, font: "inherit", color: "inherit", cursor: "pointer", padding: 0 }}
                >
                  <span
                    aria-hidden
                    style={{
                      display: "inline-flex",
                      transition: "transform var(--dur) var(--ease)",
                      transform: isCollapsed ? "rotate(-90deg)" : "none",
                      color: "var(--content-tertiary)",
                    }}
                  >
                    <Icon name="chevronDown" size={15} />
                  </span>
                  <span aria-hidden className="dot-swatch" style={{ background: group.color }} />
                  {group.title}
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--content-tertiary)", fontWeight: 500 }}>· {rows.length}</span>
                </button>
              }
              actions={
                <span className="num" style={{ fontWeight: 600, fontSize: "var(--text-base)", color: subtotal < 0 ? "var(--color-negative)" : "var(--color-text)" }}>
                  {formatCentsWhole(subtotal)}
                </span>
              }
            >
              {!isCollapsed && (
                <div style={{ padding: "0 var(--card-pad) 10px", animation: "fadeUp var(--dur) var(--ease) both" }}>
                  {rows.map((account) => (
                    <div
                      key={account.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setEditing(account)}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setEditing(account)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "11px 0",
                        borderTop: "1px solid color-mix(in srgb, var(--color-text) 7%, transparent)",
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
                      <span aria-hidden="true" className="tile tile-accent">
                        <Icon name={TYPE_ICONS[account.type]} size={17} />
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, fontSize: "var(--text-base)" }}>{account.name}</div>
                        <div style={{ fontSize: "var(--text-xs)", color: "var(--content-tertiary)" }}>
                          {[ACCOUNT_TYPE_LABELS[account.type], account.institution, account.mask ? `••${account.mask}` : null].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontWeight: 600, fontSize: "var(--text-base)", color: account.balanceCents < 0 ? "var(--color-negative)" : "var(--color-text)" }}>
                          {formatCents(account.balanceCents, { currency: account.currency })}
                        </div>
                      </div>
                      <button
                        title="View this account's transactions"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNavigate("transactions", { accountId: account.id });
                        }}
                        className="btn btn-secondary btn-sm"
                        style={{ flex: "none" }}
                      >
                        Transactions
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
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

/** Horizontal share bars for asset or liability groups. */
function AllocationPanel({
  title,
  rows,
  total,
  emptyLabel = "Nothing here yet.",
}: {
  title: string;
  rows: { title: string; color: string; subtotal: number }[];
  total: number;
  emptyLabel?: string;
}) {
  return (
    <Panel title={title} subtitle={total > 0 ? formatCentsWhole(total) : undefined}>
      {rows.length === 0 || total <= 0 ? (
        <p className="card-meta">{emptyLabel}</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
          {rows.map((r) => {
            const share = total > 0 ? r.subtotal / total : 0;
            return (
              <div key={r.title}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--text-sm)", marginBottom: 5 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                    <span aria-hidden style={{ width: 8, height: 8, borderRadius: "var(--radius-sm)", background: r.color, flex: "none" }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                  </span>
                  <span className="num" style={{ color: "var(--content-tertiary)", flex: "none" }}>
                    {formatCentsWhole(r.subtotal)} · {Math.round(share * 100)}%
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 99, background: "color-mix(in srgb, var(--color-text) 8%, transparent)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${share * 100}%`, borderRadius: 99, background: r.color, transition: "width .4s var(--ease)" }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
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
          <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
