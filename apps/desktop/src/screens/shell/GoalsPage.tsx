import {
  formatCentsWhole,
  parseAmountToCents,
  type Account,
  type Goal,
} from "@vault/shared";
import { Button, DateField, Dialog, EmptyState, Field, ProgressBar, Select, Spinner, Tag } from "@vault/ui";
import { useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { Navigate } from "./AppShell.js";

const GOAL_COLORS = ["#3ecf8e", "#43cfc0", "#6f8ef2", "#b47ef0", "#ec6a9c", "#d8b23c"];

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function GoalsPage({ onNavigate }: { onNavigate: Navigate }) {
  const client = useApp((s) => s.client);
  const { data, loading, reload } = useData(() => client.goals(), [client]);
  const { data: accountData } = useData(() => client.accounts(true), [client]);
  const [editing, setEditing] = useState<Goal | "new" | null>(null);

  if (loading && !data) return <Spinner label="Loading goals" />;
  const goals = data?.goals ?? [];
  const accounts = accountData?.accounts ?? [];
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-sub">
          {goals.length > 0 && `${goals.length} goal${goals.length === 1 ? "" : "s"}`}
        </div>
        <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>
          Add goal
        </Button>
      </div>
      {goals.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon="flag"
            title="No savings goals yet"
            body="Set a target — an emergency fund, a trip, a down payment — and track progress here. Link a goal to a savings account and its balance becomes the progress automatically."
            action={
              <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>
                Add your first goal
              </Button>
            }
          />
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 14,
            alignItems: "start",
          }}
        >
          {goals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              linkedAccountName={g.linkedAccountId ? accountById.get(g.linkedAccountId)?.name : undefined}
              onClick={() => setEditing(g)}
              {...(g.linkedAccountId
                ? {
                    onViewAccount: () =>
                      onNavigate("transactions", { accountId: g.linkedAccountId! }),
                  }
                : {})}
            />
          ))}
        </div>
      )}

      {editing && (
        <GoalDialog
          goal={editing === "new" ? null : editing}
          accounts={accounts}
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

function GoalCard({
  goal,
  linkedAccountName,
  onClick,
  onViewAccount,
}: {
  goal: Goal;
  linkedAccountName?: string | undefined;
  onClick: () => void;
  onViewAccount?: () => void;
}) {
  const pct = goal.targetCents > 0 ? Math.min(1, goal.savedCents / goal.targetCents) : 0;
  const funded = goal.savedCents >= goal.targetCents;
  const eta = funded
    ? "funded 🎉"
    : goal.projectedCompletion
      ? `~${monthLabel(goal.projectedCompletion)}`
      : goal.targetDate
        ? `target ${goal.targetDate}`
        : "no timeline";

  return (
    <div
      className="panel clickable"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick()}
      style={{ textAlign: "left", width: "100%" }}
    >
      <div className="row-baseline">
        <div className="panel-title truncate">{goal.name}</div>
        <Tag variant={funded ? "positive" : "neutral"}>{eta}</Tag>
      </div>
      <div className="stat-value" style={{ marginTop: "var(--space-3)" }}>
        {formatCentsWhole(goal.savedCents)}
      </div>
      <div className="t-sm t-tertiary">
        of {formatCentsWhole(goal.targetCents)} · {Math.round(pct * 100)}% funded
      </div>
      <div className="t-xs t-tertiary" style={{ marginTop: 2 }}>
        {goal.monthlyCents > 0
          ? `${formatCentsWhole(goal.monthlyCents)} a month`
          : "no monthly plan — not on the cash-flow diagram"}
      </div>
      <div style={{ margin: "var(--space-3) 0" }}>
        <ProgressBar value={pct} color={goal.color} label={goal.name} />
      </div>
      {goal.note && <div className="t-sm t-tertiary">{goal.note}</div>}
      {onViewAccount && (
        <Button
          variant="secondary"
          size="sm"
          iconEnd="arrowRight"
          title="View the linked account's transactions"
          style={{ marginTop: "var(--space-2)", alignSelf: "flex-start" }}
          onClick={(e) => {
            e.stopPropagation();
            onViewAccount();
          }}
        >
          {linkedAccountName ?? "Linked account"}
        </Button>
      )}
    </div>
  );
}

function GoalDialog({
  goal,
  accounts,
  onClose,
  onSaved,
}: {
  goal: Goal | null;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = useApp((s) => s.client);
  const [name, setName] = useState(goal?.name ?? "");
  const [target, setTarget] = useState(goal ? (goal.targetCents / 100).toFixed(2) : "");
  const [linkedAccountId, setLinkedAccountId] = useState(goal?.linkedAccountId ?? "");
  const [saved, setSaved] = useState(
    goal && !goal.linkedAccountId ? (goal.savedCents / 100).toFixed(2) : "0",
  );
  const [monthly, setMonthly] = useState(goal ? (goal.monthlyCents / 100).toFixed(2) : "");
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? "");
  const [color, setColor] = useState(goal?.color ?? GOAL_COLORS[0]!);
  const [note, setNote] = useState(goal?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetCents = parseAmountToCents(target);
  const monthlyCents = monthly.trim() ? (parseAmountToCents(monthly) ?? 0) : 0;
  const savedCents = linkedAccountId ? 0 : (parseAmountToCents(saved) ?? -1);
  const valid = name.trim() && targetCents !== null && targetCents > 0 && savedCents >= 0;

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        targetCents: targetCents!,
        savedCents: linkedAccountId ? 0 : savedCents,
        monthlyCents,
        linkedAccountId: linkedAccountId || null,
        targetDate: targetDate || null,
        color,
        note: note.trim() || null,
      };
      if (goal) {
        await client.updateGoal(goal.id, payload);
      } else {
        await client.createGoal(payload);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!goal || busy) return;
    setBusy(true);
    try {
      await client.deleteGoal(goal.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={goal ? "Edit goal" : "Add savings goal"}
      onClose={onClose}
      actions={
        <>
          {goal && (
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
        <Field
          label="Goal"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus={!goal}
          placeholder="Emergency fund"
        />
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Field
              label="Target amount"
              value={target}
              inputMode="decimal"
              onChange={(e) => setTarget(e.target.value)}
              placeholder="15000.00"
            />
          </div>
          <div style={{ width: 180 }}>
            <DateField
              label="Target date (optional)"
              value={targetDate}
              onChange={setTargetDate}
              placeholder="No deadline"
            />
          </div>
        </div>
        <Field
          label="Contribution per month"
          value={monthly}
          inputMode="decimal"
          onChange={(e) => setMonthly(e.target.value)}
          placeholder="250.00"
          hint="Shows up as its own flow on the cash-flow diagram. Leave at 0 to track the balance only."
        />
        <Select
          label="Linked account (optional)"
          value={linkedAccountId}
          onChange={(e) => setLinkedAccountId(e.target.value)}
        >
          <option value="">Not linked — track manually</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        {linkedAccountId ? (
          <p className="text-muted" style={{ fontSize: "var(--text-xs)", margin: 0, lineHeight: 1.6 }}>
            Progress follows this account's balance automatically, and the
            timeline is projected from its recent growth.
          </p>
        ) : (
          <Field
            label="Saved so far"
            value={saved}
            inputMode="decimal"
            onChange={(e) => setSaved(e.target.value)}
          />
        )}
        <div className="field">
          <label>Color</label>
          <div style={{ display: "flex", gap: 8 }}>
            {GOAL_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  background: c,
                  cursor: "pointer",
                  border:
                    color === c
                      ? "2px solid var(--color-text)"
                      : "2px solid transparent",
                }}
              />
            ))}
          </div>
        </div>
        <Field
          label="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="3 months of expenses"
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
