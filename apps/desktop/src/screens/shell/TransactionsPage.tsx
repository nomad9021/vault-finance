import {
  formatCents,
  formatCentsWhole,
  parseAmountToCents,
  type Account,
  type Category,
  type ImportResponse,
  type Transaction,
} from "@vault/shared";
import { Button, Dialog, Field, Panel, Select, Spinner } from "@vault/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";

type Period = "all" | "month" | "3m" | "12m";
const PERIOD_LABELS: Record<Period, string> = {
  all: "All time",
  month: "This month",
  "3m": "Last 3 months",
  "12m": "Last 12 months",
};
function periodRange(period: Period): { from?: string; to?: string } {
  if (period === "all") return {};
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const to = iso(now);
  if (period === "month") return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  const d = new Date(now);
  d.setMonth(d.getMonth() - (period === "3m" ? 3 : 12));
  return { from: iso(d), to };
}

export function TransactionsPage({
  initialCategoryId,
  initialAccountId,
}: {
  /** Pre-applied category filter (from a category link elsewhere in the app). */
  initialCategoryId?: string;
  /** Pre-applied account filter (from an account/income link elsewhere). */
  initialAccountId?: string;
} = {}) {
  const client = useApp((s) => s.client);

  const { data: accountData } = useData(() => client.accounts(true), [client]);
  const { data: categoryData } = useData(() => client.categories(), [client]);
  const accounts = accountData?.accounts ?? [];
  const categories = categoryData?.categories ?? [];
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  // Filters
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState(initialCategoryId ?? "");
  const [accountFilter, setAccountFilter] = useState(initialAccountId ?? "");
  const [period, setPeriod] = useState<Period>("all");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const range = periodRange(period);

  // Paged list state
  const [rows, setRows] = useState<Transaction[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [sumIn, setSumIn] = useState(0);
  const [sumOut, setSumOut] = useState(0);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);

  const query = useCallback(
    (cursor?: string) =>
      client.transactions({
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
        ...(categoryFilter ? { categoryId: categoryFilter } : {}),
        ...(accountFilter ? { accountId: accountFilter } : {}),
        ...(range.from ? { from: range.from } : {}),
        ...(range.to ? { to: range.to } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 50,
      }),
    [client, debouncedSearch, categoryFilter, accountFilter, range.from, range.to],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const reload = useCallback(() => {
    const gen = ++generation.current;
    setLoading(true);
    setSelected(new Set());
    query()
      .then((res) => {
        if (gen !== generation.current) return;
        setRows(res.transactions);
        setNextCursor(res.nextCursor);
        setTotalCount(res.totalCount);
        setSumIn(res.sumInCents);
        setSumOut(res.sumOutCents);
      })
      .finally(() => {
        if (gen === generation.current) setLoading(false);
      });
  }, [query]);

  useEffect(reload, [reload]);

  const loadMore = async () => {
    if (!nextCursor) return;
    const res = await query(nextCursor);
    setRows((prev) => [...prev, ...res.transactions]);
    setNextCursor(res.nextCursor);
  };

  const [editing, setEditing] = useState<Transaction | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [autocatting, setAutocatting] = useState(false);
  const [autocatMsg, setAutocatMsg] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkCat, setBulkCat] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const applyBulkCategory = async () => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    const categoryId = bulkCat === "__none__" ? null : bulkCat;
    await Promise.all(
      [...selected].map((id) => client.updateTransaction(id, { categoryId }).catch(() => {})),
    );
    setBulkBusy(false);
    setBulkCat("");
    reload();
  };
  const doBulkDelete = async () => {
    setBulkBusy(true);
    await Promise.all([...selected].map((id) => client.deleteTransaction(id).catch(() => {})));
    setBulkBusy(false);
    setConfirmDelete(false);
    reload();
  };

  const runAutocategorize = async () => {
    setAutocatting(true);
    setAutocatMsg(null);
    try {
      const r = await client.autocategorize();
      const parts = [
        `${r.byRule} by rule`,
        `${r.byHistory} learned from history`,
        ...(r.byAi > 0 ? [`${r.byAi} by AI`] : []),
      ];
      setAutocatMsg(
        r.categorized > 0
          ? `Sorted ${r.categorized} of ${r.scanned} (${parts.join(", ")}).`
          : r.scanned === 0
            ? "Nothing uncategorized to sort."
            : `No matches among ${r.scanned} uncategorized — add a rule in Settings, or enable the AI assistant to sort the rest.`,
      );
      reload();
    } catch {
      setAutocatMsg("Auto-categorize failed. Is the server reachable?");
    } finally {
      setAutocatting(false);
    }
  };

  const net = sumIn - sumOut;

  return (
    <div className="page" style={{ gap: "var(--space-4)" }}>
      {/* Sticky toolbar — filters stay put while the table scrolls. */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          background: "var(--color-bg)",
          paddingTop: 2,
          paddingBottom: 10,
          marginTop: -2,
          borderBottom: "1px solid var(--hairline)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 170, maxWidth: 300, borderRadius: "var(--radius-md)" }}
            placeholder="Search merchants…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search merchants"
          />
          <Select aria-label="Filter by category" style={{ width: "auto", minWidth: 155, borderRadius: "var(--radius-md)" }} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">All categories</option>
            <option value="none">Uncategorized</option>
            {categories.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
          </Select>
          <Select aria-label="Filter by account" style={{ width: "auto", minWidth: 145, borderRadius: "var(--radius-md)" }} value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
            <option value="">All accounts</option>
            {accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
          </Select>
          <Select aria-label="Filter by date" style={{ width: "auto", minWidth: 140, borderRadius: "var(--radius-md)" }} value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (<option key={p} value={p}>{PERIOD_LABELS[p]}</option>))}
          </Select>
          <div style={{ display: "flex", gap: 10, marginLeft: "auto", flexWrap: "wrap" }}>
            <Button
              variant="secondary"
              onClick={() => void runAutocategorize()}
              disabled={autocatting}
              title="Sort uncategorized transactions using your keyword rules and past categorizations — all local, nothing leaves your server."
            >
              {autocatting ? "Sorting…" : "Auto-categorize"}
            </Button>
            <Button variant="secondary" onClick={() => setImporting(true)}>Import CSV</Button>
            <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>
              Add
            </Button>
          </div>
        </div>

        {selected.size > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              padding: "8px 12px",
              borderRadius: "var(--radius-md)",
              background: "color-mix(in srgb, var(--color-accent) 12%, var(--color-surface))",
              border: "1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)",
            }}
          >
            <strong style={{ fontSize: "var(--text-sm)" }}>{selected.size} selected</strong>
            <Select aria-label="Recategorize selected" style={{ width: "auto", minWidth: 160, borderRadius: "var(--radius-md)" }} value={bulkCat} onChange={(e) => setBulkCat(e.target.value)}>
              <option value="">Set category…</option>
              <option value="__none__">Uncategorized</option>
              {categories.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
            </Select>
            <Button variant="secondary" onClick={() => void applyBulkCategory()} disabled={bulkBusy || !bulkCat}>
              {bulkBusy ? "Applying…" : "Apply"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(true)} disabled={bulkBusy} style={{ color: "var(--color-negative)" }}>
              Delete
            </Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())} style={{ marginLeft: "auto" }}>
              Clear
            </Button>
          </div>
        )}
      </div>

      {autocatMsg && (
        <div role="status" style={{ fontSize: "var(--text-sm)", color: "var(--content-secondary)", background: "var(--color-surface)", border: "1px solid var(--color-divider)", borderRadius: "var(--radius-md)", padding: "8px 12px" }}>
          {autocatMsg}
        </div>
      )}

      <div className="grid">
        <div className="col-9">
          <div className="panel panel-flush table-scroll">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th style={{ width: 38, padding: "10px 0 10px 16px" }}>
                    <input type="checkbox" aria-label="Select all shown" checked={allSelected} onChange={toggleAll} style={{ cursor: "pointer" }} />
                  </th>
                  <Th>Date</Th>
                  <Th>Merchant</Th>
                  <Th>Category</Th>
                  <Th>Account</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                {loading && rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: 24, textAlign: "center" }}>
                      <Spinner label="Loading transactions" />
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: 24, textAlign: "center" }} className="text-muted">
                      {totalCount === 0 && !debouncedSearch && !categoryFilter && !accountFilter && period === "all"
                        ? "No transactions yet — add one or import a CSV from your bank."
                        : "Nothing matches these filters."}
                    </td>
                  </tr>
                ) : (
                  rows.map((t) => {
                    const category = t.categoryId ? categoryById.get(t.categoryId) : undefined;
                    const isSel = selected.has(t.id);
                    return (
                      <tr
                        key={t.id}
                        onClick={() => setEditing(t)}
                        className="txn-row"
                        style={{
                          borderTop: "1px solid color-mix(in srgb, var(--color-text) 7%, transparent)",
                          cursor: "pointer",
                          ...(isSel ? { background: "color-mix(in srgb, var(--color-accent) 9%, transparent)" } : {}),
                        }}
                      >
                        <td style={{ padding: "8px 0 8px 16px" }} onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" aria-label={`Select ${t.merchantName}`} checked={isSel} onChange={() => toggleRow(t.id)} style={{ cursor: "pointer" }} />
                        </td>
                        <Td muted nowrap>{t.postedAt}</Td>
                        <Td style={{ fontWeight: 500 }}>{t.merchantName}</Td>
                        <Td><CategoryPill category={category} /></Td>
                        <Td muted nowrap>{accountById.get(t.accountId)?.name ?? "—"}</Td>
                        <Td nowrap style={{ textAlign: "right", fontWeight: 600, color: t.amountCents > 0 ? "var(--color-positive)" : "var(--color-text)" }}>
                          {formatCents(t.amountCents, { signed: true })}
                        </Td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {nextCursor && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
              <Button variant="secondary" onClick={() => void loadMore()}>Load more</Button>
            </div>
          )}
        </div>

        <div className="col-3">
          <Panel title="Summary" subtitle={PERIOD_LABELS[period]} style={{ position: "sticky", top: 96 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div className="eyebrow">Transactions</div>
                <div className="metric-value" style={{ fontSize: "var(--text-2xl)" }}>{totalCount.toLocaleString()}</div>
              </div>
              <div style={{ height: 1, background: "var(--hairline)" }} />
              <SummaryRow label="Money in" value={formatCentsWhole(sumIn)} color="var(--color-positive)" />
              <SummaryRow label="Money out" value={formatCentsWhole(sumOut)} color="var(--color-text)" />
              <SummaryRow
                label="Net"
                value={`${net >= 0 ? "+" : "−"}${formatCentsWhole(Math.abs(net))}`}
                color={net >= 0 ? "var(--color-positive)" : "var(--color-negative)"}
                strong
              />
            </div>
          </Panel>
        </div>
      </div>

      <Dialog
        open={confirmDelete}
        title={`Delete ${selected.size} transaction${selected.size === 1 ? "" : "s"}?`}
        onClose={() => setConfirmDelete(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)} disabled={bulkBusy}>Cancel</Button>
            <Button variant="primary" onClick={() => void doBulkDelete()} disabled={bulkBusy} style={{ background: "var(--color-negative)", borderColor: "var(--color-negative)", color: "#fff" }}>
              {bulkBusy ? <Spinner label="Deleting" /> : "Delete"}
            </Button>
          </>
        }
      >
        This permanently removes the selected transactions. Account balances aren't affected.
      </Dialog>

      {editing && (
        <TransactionDialog
          transaction={editing === "new" ? null : editing}
          accounts={accounts.filter((a) => !a.archivedAt)}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {importing && (
        <ImportDialog
          accounts={accounts.filter((a) => !a.archivedAt)}
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function SummaryRow({ label, value, color, strong }: { label: string; value: string; color: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--content-tertiary)" }}>{label}</span>
      <span className="num" style={{ fontWeight: strong ? 700 : 600, fontSize: strong ? 16 : 14, color }}>
        {value}
      </span>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th
      style={{
        padding: "10px 16px",
        fontSize: "var(--text-2xs)",
        letterSpacing: ".05em",
        textTransform: "uppercase",
        color: "var(--content-tertiary)",
        textAlign: align ?? "left",
        fontWeight: 600,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  muted,
  nowrap,
  style,
}: {
  children: React.ReactNode;
  muted?: boolean;
  nowrap?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <td
      style={{
        padding: "8px 16px",
        ...(muted ? { color: "var(--content-tertiary)" } : {}),
        ...(nowrap ? { whiteSpace: "nowrap" } : {}),
        ...style,
      }}
    >
      {children}
    </td>
  );
}

function CategoryPill({ category }: { category: Category | undefined }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: "var(--text-xs)",
        padding: "2px 9px",
        borderRadius: 99,
        background: category
          ? `color-mix(in srgb, ${category.color} 16%, transparent)`
          : "color-mix(in srgb, var(--color-text) 7%, transparent)",
        color: "var(--color-text)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: category?.color ?? "var(--color-neutral-600)",
        }}
      />
      {category?.name ?? "Uncategorized"}
    </span>
  );
}

function TransactionDialog({
  transaction,
  accounts,
  categories,
  onClose,
  onSaved,
}: {
  transaction: Transaction | null;
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = useApp((s) => s.client);
  const [accountId, setAccountId] = useState(transaction?.accountId ?? accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(transaction?.categoryId ?? "");
  const [postedAt, setPostedAt] = useState(
    transaction?.postedAt ?? new Date().toISOString().slice(0, 10),
  );
  const [merchant, setMerchant] = useState(transaction?.merchantName ?? "");
  const [amount, setAmount] = useState(
    transaction ? (transaction.amountCents / 100).toFixed(2) : "",
  );
  const [notes, setNotes] = useState(transaction?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Offered only when you're actually filing something that wasn't filed
  // before — that's the moment the rule is worth creating.
  const [alsoRule, setAlsoRule] = useState(false);
  const categorizingFresh = !transaction?.categoryId && !!categoryId;

  const amountCents = parseAmountToCents(amount);
  const valid =
    merchant.trim().length > 0 &&
    amountCents !== null &&
    amountCents !== 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(postedAt) &&
    (transaction !== null || accountId);

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const common = {
        categoryId: categoryId || null,
        postedAt,
        amountCents: amountCents!,
        merchantName: merchant.trim(),
        notes: notes.trim() || null,
      };
      if (transaction) {
        await client.updateTransaction(transaction.id, common);
      } else {
        await client.createTransaction({ ...common, accountId, pending: false });
      }
      // Turn this one-off correction into a standing rule, so the same
      // merchant files itself on every future import. Non-fatal: the
      // transaction is already saved, and a duplicate rule isn't worth
      // surfacing an error over.
      if (alsoRule && categoryId && merchant.trim()) {
        await client
          .createCategorizationRule({ keyword: merchant.trim(), categoryId })
          .catch(() => {});
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!transaction || busy) return;
    setBusy(true);
    try {
      await client.deleteTransaction(transaction.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={transaction ? "Edit transaction" : "Add transaction"}
      onClose={onClose}
      actions={
        <>
          {transaction && (
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
        {!transaction && (
          <Select
            label="Account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        )}
        <Field
          label="Merchant"
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
          autoFocus={!transaction}
          placeholder="Fresh Market"
        />
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Field
              label="Amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="-42.50"
              error={
                amount && (amountCents === null || amountCents === 0)
                  ? "Amounts look like -42.50 (spending) or 1200 (income)."
                  : undefined
              }
              hint="Negative = money out, positive = money in."
            />
          </div>
          <div style={{ width: 160 }}>
            <Field
              label="Date"
              type="date"
              value={postedAt}
              onChange={(e) => setPostedAt(e.target.value)}
            />
          </div>
        </div>
        <Select
          label="Category"
          value={categoryId ?? ""}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">Uncategorized</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {categorizingFresh && (
          <label className="radio" style={{ alignItems: "flex-start", gap: "var(--space-2)" }}>
            <input
              type="checkbox"
              checked={alsoRule}
              onChange={(e) => setAlsoRule(e.target.checked)}
              style={{ position: "static", opacity: 1, width: 16, height: 16, marginTop: 2 }}
            />
            <span>
              <span className="t-sm">
                Always file “{merchant.trim() || "this merchant"}” here
              </span>
              <span className="field-hint" style={{ display: "block" }}>
                Creates a rule so future imports categorize it automatically.
              </span>
            </span>
          </label>
        )}
        <Field
          label="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
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

function ImportDialog({
  accounts,
  onClose,
  onImported,
}: {
  accounts: Account[];
  onClose: () => void;
  onImported: () => void;
}) {
  const client = useApp((s) => s.client);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    setError(null);
    void file.text().then(setCsvText);
  };

  const doImport = async () => {
    if (!csvText || !accountId || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await client.importTransactions(accountId, csvText));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="Import transactions from CSV"
      onClose={onClose}
      actions={
        result ? (
          <Button variant="primary" onClick={onImported}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void doImport()}
              disabled={!csvText || !accountId || busy}
            >
              {busy ? <Spinner label="Importing" /> : "Import"}
            </Button>
          </>
        )
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Select
          label="Into account"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <Button variant="secondary" onClick={() => fileRef.current?.click()}>
          {fileName ?? "Choose CSV file…"}
        </Button>
        <p className="text-muted" style={{ fontSize: "var(--text-xs)", margin: 0, lineHeight: 1.6 }}>
          Needs columns: <code>date</code>, <code>merchant</code> (or payee/name),{" "}
          <code>amount</code>. Optional: <code>category</code>, <code>description</code>,{" "}
          <code>external_id</code>. Re-importing the same file won't create duplicates.
        </p>
        {result && (
          <div style={{ fontSize: "var(--text-sm)", lineHeight: 1.7 }} role="status">
            ✓ Imported <strong>{result.imported}</strong>
            {result.skippedDuplicates > 0 && (
              <> · skipped {result.skippedDuplicates} duplicate{result.skippedDuplicates === 1 ? "" : "s"}</>
            )}
            {result.errors.length > 0 && (
              <div style={{ color: "var(--color-negative)" }}>
                {result.errors.length} row{result.errors.length === 1 ? "" : "s"} had
                problems (first: line {result.errors[0]!.line} —{" "}
                {result.errors[0]!.message})
              </div>
            )}
          </div>
        )}
        {error && (
          <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
