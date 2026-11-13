import {
  formatCents,
  formatCentsWhole,
  parseAmountToCents,
  type Account,
  type GuiltFreePerson,
  type GuiltFreeResponse,
  type Transaction,
} from "@vault/shared";
import { Avatar, Button, Dialog, EmptyState, Field, Panel, ProgressBar, Segmented, Select, Skeleton, Spinner } from "@vault/ui";
import { useEffect, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useChat } from "../../state/chat.js";
import { useApp } from "../../state/store.js";

/**
 * Guilt-free spending on the home screen: everyone's weekly amount side by
 * side, what's left of it this week, and a quick way to log a purchase —
 * typed in, or picked from what the bank already brought in. It resets every
 * week by itself (it's a weekly budget), and shows on the Sankeys as its own
 * category with a branch per person.
 */

const dayLabel = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const weekdayLabel = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "long", timeZone: "UTC" });
const today = () => new Date().toISOString().slice(0, 10);

export function GuiltFreeCard() {
  const client = useApp((s) => s.client);
  const weekStart = useApp((s) => s.reviewPrefs.weekStartsOn);
  const { data, reload, error } = useData<GuiltFreeResponse>(() => client.guiltFree(weekStart), [client, weekStart]);
  const refreshAll = useChat((s) => s.refreshData);
  const [setup, setSetup] = useState(false);
  const [adding, setAdding] = useState<GuiltFreePerson | null>(null);

  // Changing it changes budgets and the Sankeys too: refresh every open view.
  const changed = () => {
    void reload();
    refreshAll();
  };

  if (!data) {
    return (
      <Panel title="Guilt-free spending">
        {error ? <div className="t-sm t-tertiary">Couldn't load guilt-free spending.</div> : <Skeleton height={140} />}
      </Panel>
    );
  }

  const people = data.people;
  const active = people.filter((p) => p.weeklyCents > 0 || p.spentCents > 0);
  const resets = weekdayLabel(data.weekEnd);

  return (
    <Panel
      title="Guilt-free spending"
      subtitle={`This week · resets ${resets}`}
      actions={
        <Button variant="ghost" size="sm" icon="edit" onClick={() => setSetup(true)}>
          {active.length ? "Amounts" : "Set up"}
        </Button>
      }
    >
      {active.length === 0 ? (
        <EmptyState
          compact
          icon="gift"
          title="Money to spend on anything"
          body="Give each person a weekly amount that's theirs, no questions asked. It resets every week and shows on your budget and actual Sankeys."
          action={
            <Button variant="secondary" size="sm" onClick={() => setSetup(true)}>
              Set weekly amounts
            </Button>
          }
        />
      ) : (
        <div className="gf-grid">
          {active.map((p) => (
            <PersonTile key={p.userId} person={p} onAdd={() => setAdding(p)} onChanged={changed} />
          ))}
        </div>
      )}
      {setup && (
        <SetupDialog
          people={people}
          onClose={() => setSetup(false)}
          onSave={async (amounts) => {
            await client.saveGuiltFree({ people: amounts }, weekStart);
            setSetup(false);
            changed();
          }}
        />
      )}
      {adding && (
        <AddPurchaseDialog
          people={active}
          initial={adding}
          weekStart={data.weekStart}
          onClose={() => setAdding(null)}
          onAdded={() => {
            setAdding(null);
            changed();
          }}
        />
      )}
    </Panel>
  );
}

function PersonTile({ person, onAdd, onChanged }: { person: GuiltFreePerson; onAdd: () => void; onChanged: () => void }) {
  const client = useApp((s) => s.client);
  const left = person.weeklyCents - person.spentCents;
  const over = left < 0;
  const [confirming, setConfirming] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? person.purchases : person.purchases.slice(0, 3);

  const remove = async (id: string, manual: boolean) => {
    // Typed in here: delete it. From the bank: just take it out of guilt-free.
    if (manual) await client.deleteTransaction(id).catch(() => {});
    else await client.updateTransaction(id, { categoryId: null }).catch(() => {});
    setConfirming(null);
    onChanged();
  };

  return (
    <div className="gf-person">
      <div className="row" style={{ gap: "var(--space-3)" }}>
        <Avatar name={person.displayName} color={person.avatarColor} image={person.avatarImage ?? null} size={34} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="t-sm t-medium truncate">
            {person.displayName}
            {person.isMe && <span className="t-tertiary" style={{ fontWeight: 400 }}> · you</span>}
          </div>
          <div className="t-xs t-tertiary">{person.weeklyCents > 0 ? `${formatCentsWhole(person.weeklyCents)} a week` : "No weekly amount"}</div>
        </div>
      </div>
      <div className="row-baseline" style={{ marginTop: "var(--space-3)" }}>
        <span className="stat-value num" style={{ fontSize: "var(--text-2xl)", color: over ? "var(--color-negative)" : undefined }}>
          {formatCents(Math.abs(left))}
        </span>
        <span className="t-sm t-tertiary">{over ? "over" : "left"}</span>
      </div>
      <ProgressBar
        value={person.weeklyCents > 0 ? person.spentCents / person.weeklyCents : person.spentCents > 0 ? 1 : 0}
        over={over}
        label={`${person.displayName}'s guilt-free spending this week`}
      />
      <div className="t-xs t-tertiary" style={{ marginTop: "var(--space-1)" }}>
        {formatCents(person.spentCents)} spent
      </div>
      {shown.length > 0 && (
        <div className="list list-divided" style={{ marginTop: "var(--space-2)" }}>
          {shown.map((t) => (
            <div key={t.id} className="row t-sm" style={{ gap: "var(--space-2)", padding: "6px 0" }}>
              <span className="t-tertiary" style={{ width: 52, flex: "none" }} title={t.postedAt}>
                {new Date(`${t.postedAt}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}
              </span>
              <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
                {t.merchantName}
              </span>
              <span className="num">{formatCents(t.amountCents)}</span>
              {confirming === t.id ? (
                <button type="button" className="panel-link" style={{ color: "var(--color-negative)" }} onClick={() => void remove(t.id, t.manual)}>
                  Remove
                </button>
              ) : (
                <button
                  type="button"
                  className="gf-x"
                  aria-label={`Remove ${t.merchantName}`}
                  title={t.manual ? "Delete this purchase" : "Take it out of guilt-free (the transaction stays)"}
                  onClick={() => setConfirming(t.id)}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {person.purchases.length > 3 && (
        <button type="button" className="panel-link" style={{ marginTop: 4 }} onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all ${person.purchases.length}`}
        </button>
      )}
      <Button variant="secondary" size="sm" icon="plus" style={{ marginTop: "var(--space-3)", alignSelf: "flex-start" }} onClick={onAdd} disabled={!person.categoryId}>
        Add purchase
      </Button>
    </div>
  );
}

function SetupDialog({
  people,
  onClose,
  onSave,
}: {
  people: GuiltFreePerson[];
  onClose: () => void;
  onSave: (amounts: Array<{ userId: string; weeklyCents: number }>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(people.map((p) => [p.userId, p.weeklyCents ? (p.weeklyCents / 100).toFixed(2) : ""])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = people.map((p) => ({ userId: p.userId, cents: values[p.userId]?.trim() ? parseAmountToCents(values[p.userId]!) : 0 }));
  const invalid = parsed.some((p) => p.cents === null || p.cents < 0);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(parsed.map((p) => ({ userId: p.userId, weeklyCents: p.cents ?? 0 })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="Weekly guilt-free spending"
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
      <p className="t-sm t-tertiary" style={{ marginTop: 0 }}>
        Each person's own money for the week. It starts over every week and is a weekly budget under “Guilt-free spending”, so it's on your
        budget and actual Sankeys. Leave one empty for none.
      </p>
      <div className="stack">
        {people.map((p) => (
          <Field
            key={p.userId}
            label={`${p.displayName}${p.isMe ? " (you)" : ""} — per week`}
            inputMode="decimal"
            placeholder="0.00"
            value={values[p.userId] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [p.userId]: e.target.value }))}
          />
        ))}
      </div>
      {error && (
        <div role="alert" className="t-sm" style={{ color: "var(--color-negative)", marginTop: 8 }}>
          {error}
        </div>
      )}
    </Dialog>
  );
}

/** Accounts people pay with, most likely first. */
function spendAccounts(accounts: Account[]): Account[] {
  const rank = (a: Account) => (a.type === "credit_card" ? 0 : a.type === "checking" ? 1 : 2);
  return accounts.filter((a) => !a.archivedAt && ["checking", "credit_card", "savings", "other"].includes(a.type)).sort((a, b) => rank(a) - rank(b));
}

function AddPurchaseDialog({
  people,
  initial,
  weekStart,
  onClose,
  onAdded,
}: {
  people: GuiltFreePerson[];
  initial: GuiltFreePerson;
  weekStart: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const client = useApp((s) => s.client);
  const [who, setWho] = useState(initial.userId);
  const person = people.find((p) => p.userId === who) ?? initial;
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [amount, setAmount] = useState("");
  const [what, setWhat] = useState("");
  const [date, setDate] = useState(today());
  const [accountId, setAccountId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: accountData } = useData(() => client.accounts(), [client]);
  const accounts = spendAccounts(accountData?.accounts ?? []);
  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  // Already at the bank? Pick it instead of typing it twice.
  const { data: recentData } = useData(
    () => client.transactions({ from: weekStart, to: today(), limit: 60 }),
    [client, weekStart],
  );
  const taken = new Set(people.map((p) => p.categoryId).filter(Boolean));
  const recent = (recentData?.transactions ?? []).filter((t: Transaction) => t.amountCents < 0 && !t.isTransfer && !taken.has(t.categoryId ?? ""));

  const cents = parseAmountToCents(amount);
  const canSave = mode === "new" && cents !== null && cents > 0 && what.trim() && accountId && person.categoryId;

  const addNew = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await client.createTransaction({
        accountId,
        categoryId: person.categoryId,
        postedAt: date,
        amountCents: -cents!,
        merchantName: what.trim(),
        pending: false,
      });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that purchase.");
      setBusy(false);
    }
  };
  const pick = async (t: Transaction) => {
    setBusy(true);
    setError(null);
    try {
      await client.updateTransaction(t.id, { categoryId: person.categoryId });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't move that purchase.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="Add a guilt-free purchase"
      onClose={onClose}
      actions={
        mode === "new" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void addNew()} disabled={busy || !canSave}>
              {busy ? <Spinner label="Adding" /> : "Add"}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        )
      }
    >
      <div className="stack">
        {people.length > 1 && (
          <Segmented
            aria-label="Whose purchase"
            options={people.map((p) => ({ value: p.userId, label: p.isMe ? `${p.displayName} (you)` : p.displayName }))}
            value={who}
            onChange={setWho}
          />
        )}
        <div className="t-xs t-tertiary">
          {formatCents(Math.max(0, person.weeklyCents - person.spentCents))} left of {formatCentsWhole(person.weeklyCents)} this week
        </div>
        <Segmented
          aria-label="New or from the bank"
          options={[
            { value: "new", label: "New purchase" },
            { value: "existing", label: "Already in transactions" },
          ]}
          value={mode}
          onChange={setMode}
        />
        {mode === "new" ? (
          <>
            <Field label="Amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            <Field label="What was it?" placeholder="Coffee, book, game…" value={what} maxLength={200} onChange={(e) => setWhat(e.target.value)} />
            <Field label="Date" type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value || today())} />
            <Select label="Paid from" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.length === 0 && <option value="">Add an account first</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            <div className="t-2xs t-tertiary">
              If your bank also brings this purchase in later, pick it under “Already in transactions” instead so it isn't counted twice.
            </div>
          </>
        ) : recent.length === 0 ? (
          <div className="t-sm t-tertiary">No other purchases this week yet.</div>
        ) : (
          <div className="list list-divided" style={{ maxHeight: 320, overflow: "auto" }}>
            {recent.map((t) => (
              <button
                key={t.id}
                type="button"
                className="gf-pick"
                disabled={busy}
                onClick={() => void pick(t)}
              >
                <span className="t-tertiary" style={{ width: 92, flex: "none" }}>
                  {dayLabel(t.postedAt)}
                </span>
                <span className="truncate" style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                  {t.merchantName}
                </span>
                <span className="num">{formatCents(-t.amountCents)}</span>
              </button>
            ))}
          </div>
        )}
        {error && (
          <div role="alert" className="t-sm" style={{ color: "var(--color-negative)" }}>
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
