import {
  formatCents,
  parseAmountToCents,
  type Account,
  type Category,
  type ImportResponse,
  type Transaction,
} from "@vault/shared";
import { Button, Dialog, Field, Select, Spinner } from "@vault/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";

export function TransactionsPage() {
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
  const [categoryFilter, setCategoryFilter] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Paged list state
  const [rows, setRows] = useState<Transaction[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);

  const query = useCallback(
    (cursor?: string) =>
      client.transactions({
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
        ...(categoryFilter ? { categoryId: categoryFilter } : {}),
        ...(accountFilter ? { accountId: accountFilter } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 50,
      }),
    [client, debouncedSearch, categoryFilter, accountFilter],
  );

  const reload = useCallback(() => {
    const gen = ++generation.current;
    setLoading(true);
    query()
      .then((res) => {
        if (gen !== generation.current) return;
        setRows(res.transactions);
        setNextCursor(res.nextCursor);
        setTotalCount(res.totalCount);
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
    setTotalCount(res.totalCount);
  };

  const [editing, setEditing] = useState<Transaction | "new" | null>(null);
  const [importing, setImporting] = useState(false);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        maxWidth: 1100,
        margin: "0 auto",
        animation: "fadeUp .3s both",
      }}
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 180, maxWidth: 340, borderRadius: 8 }}
          placeholder="Search merchants…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search merchants"
        />
        <Select
          aria-label="Filter by category"
          style={{ width: "auto", minWidth: 170, borderRadius: 8 }}
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="">All categories</option>
          <option value="none">Uncategorized</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by account"
          style={{ width: "auto", minWidth: 160, borderRadius: 8 }}
          value={accountFilter}
          onChange={(e) => setAccountFilter(e.target.value)}
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <Button variant="secondary" onClick={() => setImporting(true)}>
          Import CSV
        </Button>
        <Button variant="primary" onClick={() => setEditing("new")}>
          + Add
        </Button>
        <span style={{ fontSize: 12, color: "var(--color-neutral-500)", marginLeft: "auto" }}>
          {totalCount} transaction{totalCount === 1 ? "" : "s"}
        </span>
      </div>

      <div
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-divider)",
          borderRadius: 12,
          overflowX: "auto",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
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
                <td colSpan={5} style={{ padding: 24, textAlign: "center" }}>
                  <Spinner label="Loading transactions" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  style={{ padding: 24, textAlign: "center" }}
                  className="text-muted"
                >
                  {totalCount === 0 && !debouncedSearch && !categoryFilter && !accountFilter
                    ? "No transactions yet — add one or import a CSV from your bank."
                    : "Nothing matches these filters."}
                </td>
              </tr>
            ) : (
              rows.map((t) => {
                const category = t.categoryId ? categoryById.get(t.categoryId) : undefined;
                return (
                  <tr
                    key={t.id}
                    onClick={() => setEditing(t)}
                    style={{
                      borderTop:
                        "1px solid color-mix(in srgb, var(--color-text) 7%, transparent)",
                      cursor: "pointer",
                    }}
                  >
                    <Td muted nowrap>
                      {t.postedAt}
                    </Td>
                    <Td style={{ fontWeight: 500 }}>{t.merchantName}</Td>
                    <Td>
                      <CategoryPill category={category} />
                    </Td>
                    <Td muted nowrap>
                      {accountById.get(t.accountId)?.name ?? "—"}
                    </Td>
                    <Td
                      nowrap
                      style={{
                        textAlign: "right",
                        fontWeight: 600,
                        color:
                          t.amountCents > 0 ? "var(--color-positive)" : "var(--color-text)",
                      }}
                    >
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
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Button variant="secondary" onClick={() => void loadMore()}>
            Load more
          </Button>
        </div>
      )}

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

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th
      style={{
        padding: "10px 16px",
        fontSize: 10.5,
        letterSpacing: ".05em",
        textTransform: "uppercase",
        color: "var(--color-neutral-500)",
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
        ...(muted ? { color: "var(--color-neutral-500)" } : {}),
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
        fontSize: 11.5,
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
        <Field
          label="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
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
        <p className="text-muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.6 }}>
          Needs columns: <code>date</code>, <code>merchant</code> (or payee/name),{" "}
          <code>amount</code>. Optional: <code>category</code>, <code>description</code>,{" "}
          <code>external_id</code>. Re-importing the same file won't create duplicates.
        </p>
        {result && (
          <div style={{ fontSize: 13, lineHeight: 1.7 }} role="status">
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
          <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)" }}>
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
