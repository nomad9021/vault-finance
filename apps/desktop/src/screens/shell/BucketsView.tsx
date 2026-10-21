import {
  ApiRequestError,
  formatCents,
  formatCentsWhole,
  parseAmountToCents,
  type Bucket,
  type BucketAccount,
  type Goal,
} from "@vault/shared";
import { Banner, Button, Dialog, EmptyState, Field, Select, Spinner, Tag } from "@vault/ui";
import { useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";

/**
 * Savings buckets: split an account's real balance into named parts
 * (Emergency, Vacation…). Amounts are an allocation, not separate money;
 * what isn't allocated shows as Unassigned, and moving money between buckets
 * is just changing the split. A bucket can stand behind a savings goal.
 */
export function BucketsView() {
  const client = useApp((s) => s.client);
  const { data, loading, reload } = useData(() => client.buckets(), [client]);
  const { data: goalData } = useData(() => client.goals(), [client]);
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<{ account: BucketAccount; bucket: Bucket | null } | null>(null);
  const [moving, setMoving] = useState<BucketAccount | null>(null);

  if (loading && !data) return <Spinner label="Loading buckets" />;
  const accounts = data?.accounts ?? [];
  const shown = accounts.filter((a) => showAll || a.accountType === "savings" || a.buckets.length > 0);
  const goals = goalData?.goals ?? [];

  if (!accounts.length) {
    return (
      <div className="panel">
        <EmptyState icon="wallet" title="No savings accounts yet" body="Add or link a savings account on the Accounts page, then divide it into buckets here." />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <p className="card-meta" style={{ margin: 0, maxWidth: 560 }}>
          Divide a savings account into buckets — an emergency fund, a trip, a car — without opening more accounts.
          The buckets split the real balance; whatever isn't in one is Unassigned.
        </p>
        <label className="radio" style={{ fontSize: "var(--text-sm)" }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          <span className="dot" style={{ borderRadius: "var(--radius-sm)" }} />
          Show checking accounts too
        </label>
      </div>
      {shown.length === 0 && <p className="card-meta">No savings accounts — tick "Show checking accounts too" to use buckets on one.</p>}
      {shown.map((a) => (
        <AccountBuckets
          key={a.accountId}
          account={a}
          goals={goals}
          onAdd={() => setEditing({ account: a, bucket: null })}
          onEdit={(b) => setEditing({ account: a, bucket: b })}
          onMove={() => setMoving(a)}
        />
      ))}
      {editing && (
        <BucketDialog
          account={editing.account}
          bucket={editing.bucket}
          goals={goals}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      {moving && (
        <MoveDialog
          account={moving}
          onClose={() => setMoving(null)}
          onMoved={() => {
            setMoving(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function AccountBuckets({
  account,
  goals,
  onAdd,
  onEdit,
  onMove,
}: {
  account: BucketAccount;
  goals: Goal[];
  onAdd: () => void;
  onEdit: (b: Bucket) => void;
  onMove: () => void;
}) {
  const total = Math.max(account.balanceCents, account.allocatedCents, 1);
  const over = account.unassignedCents < 0;
  const goalName = new Map(goals.map((g) => [g.id, g.name]));
  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 600 }}>{account.accountName}</div>
          <div className="card-meta">{formatCentsWhole(account.balanceCents)} balance</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {account.buckets.length > 0 && (
            <Button variant="secondary" size="sm" onClick={onMove}>
              Move money
            </Button>
          )}
          <Button variant="primary" size="sm" icon="plus" onClick={onAdd}>
            Add bucket
          </Button>
        </div>
      </div>

      {/* The split, as one bar: each bucket, then Unassigned. */}
      <div style={{ display: "flex", height: 14, borderRadius: 7, overflow: "hidden", background: "var(--color-divider)", gap: 2 }} aria-hidden="true">
        {account.buckets.map((b) => (
          <div key={b.id} title={`${b.name}: ${formatCents(b.allocatedCents)}`} style={{ width: `${(b.allocatedCents / total) * 100}%`, background: b.color }} />
        ))}
      </div>
      {over && (
        <Banner tone="warning">
          The buckets add up to {formatCentsWhole(-account.unassignedCents)} more than the balance — take some out of a bucket to rebalance.
        </Banner>
      )}

      <div style={{ display: "flex", flexDirection: "column" }}>
        {account.buckets.map((b) => (
          <button
            key={b.id}
            onClick={() => onEdit(b)}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 2px", border: 0, borderTop: "1px solid var(--color-divider)", background: "none", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer" }}
          >
            <span style={{ width: 10, height: 10, borderRadius: 3, background: b.color, flex: "none" }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              {b.name}
              {b.goalId && goalName.get(b.goalId) && (
                <Tag style={{ marginLeft: 8, fontSize: "var(--text-3xs)" }}>goal: {goalName.get(b.goalId)}</Tag>
              )}
            </span>
            {b.targetCents ? (
              <span className="card-meta" style={{ whiteSpace: "nowrap" }}>
                {Math.min(100, Math.round((b.allocatedCents / b.targetCents) * 100))}% of {formatCentsWhole(b.targetCents)}
              </span>
            ) : null}
            <strong style={{ minWidth: 90, textAlign: "right" }}>{formatCents(b.allocatedCents)}</strong>
          </button>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 2px", borderTop: "1px solid var(--color-divider)" }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-divider)", flex: "none" }} />
          <span style={{ flex: 1, color: "var(--content-secondary)" }}>Unassigned</span>
          <strong style={{ minWidth: 90, textAlign: "right", color: over ? "var(--color-negative)" : undefined }}>{formatCents(account.unassignedCents)}</strong>
        </div>
      </div>
    </div>
  );
}

function BucketDialog({
  account,
  bucket,
  goals,
  onClose,
  onSaved,
}: {
  account: BucketAccount;
  bucket: Bucket | null;
  goals: Goal[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = useApp((s) => s.client);
  const [name, setName] = useState(bucket?.name ?? "");
  const [amount, setAmount] = useState(bucket ? (bucket.allocatedCents / 100).toFixed(2) : "");
  const [target, setTarget] = useState(bucket?.targetCents ? (bucket.targetCents / 100).toFixed(0) : "");
  const [goalId, setGoalId] = useState(bucket?.goalId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linkedElsewhere = new Set(account.buckets.filter((b) => b.id !== bucket?.id && b.goalId).map((b) => b.goalId));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        allocatedCents: parseAmountToCents(amount || "0") ?? 0,
        targetCents: target ? parseAmountToCents(target) : null,
        goalId: goalId || null,
      };
      if (bucket) await client.updateBucket(bucket.id, body);
      else await client.createBucket({ accountId: account.accountId, ...body });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't save the bucket.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!bucket) return;
    setBusy(true);
    try {
      await client.deleteBucket(bucket.id);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't delete the bucket.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={bucket ? `Edit "${bucket.name}"` : `New bucket in ${account.accountName}`}
      onClose={onClose}
      actions={
        <>
          {bucket && (
            <Button variant="danger" onClick={() => void remove()} disabled={busy}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim()}>
            {busy ? <Spinner label="Saving" /> : "Save"}
          </Button>
        </>
      }
    >
      <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Emergency fund" />
      <Field
        label="Amount in this bucket"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0.00"
        hint={`${formatCents(account.unassignedCents + (bucket?.allocatedCents ?? 0))} available in ${account.accountName}`}
      />
      <Field label="Target (optional)" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="5,000" />
      <Select label="Savings goal (optional)" value={goalId} onChange={(e) => setGoalId(e.target.value)}>
        <option value="">None</option>
        {goals.map((g) => (
          <option key={g.id} value={g.id} disabled={linkedElsewhere.has(g.id)}>
            {g.name}
            {linkedElsewhere.has(g.id) ? " (has a bucket)" : ""}
          </option>
        ))}
      </Select>
      {error && <p role="alert" style={{ color: "var(--color-negative)", fontSize: "var(--text-sm)" }}>{error}</p>}
    </Dialog>
  );
}

function MoveDialog({ account, onClose, onMoved }: { account: BucketAccount; onClose: () => void; onMoved: () => void }) {
  const client = useApp((s) => s.client);
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>(account.buckets[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (id: string) =>
    id ? `${account.buckets.find((b) => b.id === id)?.name} (${formatCents(account.buckets.find((b) => b.id === id)?.allocatedCents ?? 0)})` : `Unassigned (${formatCents(account.unassignedCents)})`;
  const options = ["", ...account.buckets.map((b) => b.id)];

  const move = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.moveBucketMoney({ fromBucketId: from || null, toBucketId: to || null, amountCents: parseAmountToCents(amount) ?? 0 });
      onMoved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't move that.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={`Move money in ${account.accountName}`}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void move()} disabled={busy || from === to || !(parseAmountToCents(amount) ?? 0)}>
            {busy ? <Spinner label="Moving" /> : "Move"}
          </Button>
        </>
      }
    >
      <Select label="From" value={from} onChange={(e) => setFrom(e.target.value)}>
        {options.map((id) => (
          <option key={id || "unassigned"} value={id}>
            {label(id)}
          </option>
        ))}
      </Select>
      <Select label="To" value={to} onChange={(e) => setTo(e.target.value)}>
        {options.map((id) => (
          <option key={id || "unassigned"} value={id}>
            {label(id)}
          </option>
        ))}
      </Select>
      <Field label="Amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
      <p className="card-meta">This only changes how the balance is split — no money leaves the account.</p>
      {error && <p role="alert" style={{ color: "var(--color-negative)", fontSize: "var(--text-sm)" }}>{error}</p>}
    </Dialog>
  );
}
