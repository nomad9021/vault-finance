import {
  formatCentsWhole,
  parseAmountToCents,
  type Account,
  type Category,
  type GivingFund,
  type GivingKind,
} from "@vault/shared";
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  MetricCard,
  Panel,
  Select,
  Spinner,
  Tabs,
  Tag,
} from "@vault/ui";
import { useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { Navigate } from "./AppShell.js";

const GIVING_COLORS = ["#b47ef0", "#ec6a9c", "#6f8ef2", "#3ecf8e", "#d8b23c", "#4db6d0"];

const TABS = [
  { value: "giving" as const, label: "Giving" },
  { value: "gift" as const, label: "Gift savings" },
];

function occasionLabel(days: number | null): { text: string; tone: "over" | "soon" | "ok" } {
  if (days === null) return { text: "no date", tone: "ok" };
  if (days < 0) return { text: `${Math.abs(days)}d ago`, tone: "over" };
  if (days === 0) return { text: "today", tone: "over" };
  if (days <= 30) return { text: `in ${days} days`, tone: "soon" };
  return { text: `in ${Math.round(days / 30)} months`, tone: "ok" };
}

/**
 * Giving & Gifts — the two ways money leaves on purpose.
 *
 * "Giving" is recurring and open-ended: a tithe, a charity, a sponsorship. What
 * matters is the monthly commitment and what's actually gone out over the year.
 * "Gift savings" is a sinking fund with a deadline: Christmas, a wedding, a
 * birthday. What matters there is whether you'll have the money in time, so
 * those cards lead with the shortfall and the date.
 *
 * Both feed their own branch on the cash-flow Sankey, which is where most
 * people will notice a number is wrong — so the amounts here are also editable
 * straight from that diagram.
 */
export function GivingPage({ onNavigate }: { onNavigate: Navigate }) {
  const client = useApp((s) => s.client);
  const { data, loading, reload } = useData(() => client.giving(), [client]);
  const { data: acctData } = useData(() => client.accounts(true), [client]);
  const { data: catData } = useData(() => client.categories(), [client]);
  const [tab, setTab] = useState<GivingKind>("giving");
  const [editing, setEditing] = useState<GivingFund | "new" | null>(null);
  const [funding, setFunding] = useState<GivingFund | null>(null);

  if (loading && !data) return <Spinner label="Loading giving" />;

  const funds = data?.funds ?? [];
  const accounts = acctData?.accounts ?? [];
  const categories = catData?.categories ?? [];
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const shown = funds.filter((f) => f.kind === tab);

  const giftShortfall = funds
    .filter((f) => f.kind === "gift" && f.targetCents)
    .reduce((s, f) => s + Math.max(0, f.targetCents! - f.savedCents), 0);

  return (
    <div className="page">
      <div className="page-head">
        <div className="grid" style={{ flex: 1, minWidth: 0 }}>
          <div className="col-3">
            <MetricCard
              label="Giving per month"
              value={formatCentsWhole(data?.monthlyGivingCents ?? 0)}
              hint={`${funds.filter((f) => f.kind === "giving").length} commitments`}
            />
          </div>
          <div className="col-3">
            <MetricCard
              label="Gift savings per month"
              value={formatCentsWhole(data?.monthlyGiftCents ?? 0)}
              hint={`${funds.filter((f) => f.kind === "gift").length} funds`}
            />
          </div>
          <div className="col-3">
            <MetricCard
              label="Given this year"
              value={formatCentsWhole(data?.givenThisYearCents ?? 0)}
              deltaTone="up"
              hint="from categorized transactions"
            />
          </div>
          <div className="col-3">
            <MetricCard
              label="Still to save for gifts"
              value={formatCentsWhole(giftShortfall)}
              deltaTone={giftShortfall > 0 ? "down" : "up"}
              hint="across gift funds"
            />
          </div>
        </div>
      </div>

      <Tabs items={TABS} value={tab} onChange={setTab} aria-label="Giving views" />

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>
          {tab === "gift" ? "Add gift fund" : "Add giving"}
        </Button>
      </div>

      <Panel
        title={tab === "gift" ? "Gift funds" : "Recurring giving"}
        subtitle={
          tab === "gift"
            ? "Money set aside for a specific occasion"
            : "Ongoing commitments, normalized to a monthly amount"
        }
      >
        {shown.length === 0 ? (
          <EmptyState
            icon="gift"
            title={tab === "gift" ? "No gift funds yet" : "No giving tracked yet"}
            body={
              tab === "gift"
                ? "Save a little each month toward birthdays, Christmas or a wedding, and the money is there when the date arrives instead of landing on a credit card."
                : "Track a tithe, a charity, or a sponsorship. Each one becomes its own flow on the cash-flow diagram so giving is visible rather than lost inside general spending."
            }
            action={
              <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>
                {tab === "gift" ? "Add a gift fund" : "Add giving"}
              </Button>
            }
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {shown.map((f) => {
              const target = f.targetCents ?? 0;
              const pct = target > 0 ? Math.min(1, f.savedCents / target) : 0;
              const funded = target > 0 && f.savedCents >= target;
              const behind = f.neededMonthlyCents !== null && f.neededMonthlyCents > f.monthlyCents;
              const occasion = occasionLabel(f.daysUntilOccasion);
              return (
                <div
                  key={f.id}
                  className="row-div"
                  style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 2px" }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "var(--radius-sm)",
                      background: f.color,
                      flex: "none",
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button
                        onClick={() => setEditing(f)}
                        title="Edit"
                        style={{
                          background: "none",
                          border: 0,
                          font: "inherit",
                          fontWeight: 600,
                          fontSize: "var(--text-base)",
                          cursor: "pointer",
                          color: "var(--color-text)",
                          padding: 0,
                        }}
                      >
                        {f.name}
                      </button>
                      {funded && <Tag variant="positive">ready</Tag>}
                      {behind && <Tag variant="warning">behind</Tag>}
                    </div>
                    <div
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--content-tertiary)",
                        marginTop: 1,
                      }}
                    >
                      {f.recipient ? `${f.recipient} · ` : ""}
                      {f.kind === "gift" && f.occasionDate
                        ? `${f.occasionDate} (${occasion.text})`
                        : "monthly"}
                      {f.accountId ? ` · ${accountName.get(f.accountId) ?? "linked account"}` : ""}
                    </div>

                    {target > 0 && (
                      <>
                        <div
                          style={{
                            height: 6,
                            borderRadius: 99,
                            marginTop: 7,
                            background: "color-mix(in srgb, var(--color-text) 8%, transparent)",
                            overflow: "hidden",
                            maxWidth: 340,
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              width: `${pct * 100}%`,
                              borderRadius: 99,
                              background: funded ? "var(--color-positive)" : f.color,
                              transition: "width .4s var(--ease)",
                            }}
                          />
                        </div>
                        <div
                          style={{
                            fontSize: "var(--text-2xs)",
                            color: "var(--content-tertiary)",
                            marginTop: 3,
                          }}
                        >
                          {formatCentsWhole(f.savedCents)} of {formatCentsWhole(target)} saved
                          {behind && f.neededMonthlyCents !== null
                            ? ` · needs ${formatCentsWhole(f.neededMonthlyCents)}/mo to be ready`
                            : funded
                              ? " · fully funded 🎉"
                              : ""}
                        </div>
                      </>
                    )}
                    {f.kind === "giving" && f.givenThisYearCents > 0 && (
                      <div
                        style={{
                          fontSize: "var(--text-2xs)",
                          color: "var(--content-tertiary)",
                          marginTop: 3,
                        }}
                      >
                        {formatCentsWhole(f.givenThisYearCents)} actually given in the last 12 months
                      </div>
                    )}
                  </div>

                  <div style={{ textAlign: "right", flex: "none" }}>
                    <div className="num" style={{ fontWeight: 600, fontSize: "var(--text-md)" }}>
                      {formatCentsWhole(f.monthlyCents)}
                    </div>
                    <div style={{ fontSize: "var(--text-2xs)", color: "var(--content-tertiary)" }}>
                      per month
                    </div>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => setFunding(f)}>
                    Set aside
                  </Button>
                  {f.accountId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      iconEnd="arrowRight"
                      title="View the linked account's transactions"
                      onClick={() => onNavigate("transactions", { accountId: f.accountId! })}
                    >
                      Account
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {editing && (
        <GivingDialog
          fund={editing === "new" ? null : editing}
          defaultKind={tab}
          accounts={accounts}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {funding && (
        <ContributeDialog
          fund={funding}
          onClose={() => setFunding(null)}
          onSaved={() => {
            setFunding(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function GivingDialog({
  fund,
  defaultKind,
  accounts,
  categories,
  onClose,
  onSaved,
}: {
  fund: GivingFund | null;
  defaultKind: GivingKind;
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = useApp((s) => s.client);
  const [kind, setKind] = useState<GivingKind>(fund?.kind ?? defaultKind);
  const [name, setName] = useState(fund?.name ?? "");
  const [recipient, setRecipient] = useState(fund?.recipient ?? "");
  const [monthly, setMonthly] = useState(fund ? (fund.monthlyCents / 100).toFixed(2) : "");
  const [target, setTarget] = useState(fund?.targetCents ? (fund.targetCents / 100).toFixed(2) : "");
  const [occasionDate, setOccasionDate] = useState(fund?.occasionDate ?? "");
  const [accountId, setAccountId] = useState(fund?.accountId ?? "");
  const [categoryId, setCategoryId] = useState(fund?.categoryId ?? "");
  const [color, setColor] = useState(fund?.color ?? GIVING_COLORS[0]!);
  const [note, setNote] = useState(fund?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const monthlyCents = parseAmountToCents(monthly) ?? 0;
  const targetCents = target ? parseAmountToCents(target) : null;
  const valid = name.trim().length > 0 && monthlyCents >= 0;

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        kind,
        recipient: recipient.trim() || null,
        monthlyCents,
        targetCents: kind === "gift" ? (targetCents ?? null) : null,
        occasionDate: kind === "gift" ? occasionDate || null : null,
        accountId: accountId || null,
        categoryId: categoryId || null,
        color,
        note: note.trim() || null,
      };
      if (fund) await client.updateGivingFund(fund.id, payload);
      else await client.createGivingFund(payload);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!fund || busy) return;
    setBusy(true);
    try {
      await client.deleteGivingFund(fund.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={fund ? "Edit" : kind === "gift" ? "Add gift fund" : "Add giving"}
      onClose={onClose}
      actions={
        <>
          {fund && (
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
        <Select
          label="Type"
          value={kind}
          onChange={(e) => setKind(e.target.value as GivingKind)}
        >
          <option value="giving">Recurring giving — ongoing, no end date</option>
          <option value="gift">Gift fund — saving toward an occasion</option>
        </Select>
        <Field
          label={kind === "gift" ? "What's it for" : "Name"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus={!fund}
          placeholder={kind === "gift" ? "Christmas 2026" : "Monthly tithe"}
        />
        <Field
          label={kind === "gift" ? "Who it's for (optional)" : "Recipient (optional)"}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder={kind === "gift" ? "The kids" : "Local food bank"}
        />
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Field
              label={kind === "gift" ? "Set aside per month" : "Given per month"}
              value={monthly}
              inputMode="decimal"
              onChange={(e) => setMonthly(e.target.value)}
              placeholder="50.00"
            />
          </div>
          {kind === "gift" && (
            <div style={{ flex: 1 }}>
              <Field
                label="Target amount"
                value={target}
                inputMode="decimal"
                onChange={(e) => setTarget(e.target.value)}
                placeholder="600.00"
              />
            </div>
          )}
        </div>
        {kind === "gift" && (
          <Field
            label="Occasion date"
            type="date"
            value={occasionDate}
            onChange={(e) => setOccasionDate(e.target.value)}
          />
        )}
        <Select
          label="Linked account (optional)"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          <option value="">Not linked — track the set-aside manually</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <Select
          label="Category (optional)"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">No category</option>
          {categories
            .filter((c) => c.kind !== "income")
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </Select>
        <p className="text-muted" style={{ fontSize: "var(--text-xs)", margin: 0, lineHeight: 1.6 }}>
          {accountId
            ? "The set-aside amount follows this account's balance automatically."
            : "Pick a category to see what you've actually given over the last 12 months, not just what you planned."}
        </p>
        <div className="field">
          <label>Color</label>
          <div style={{ display: "flex", gap: 8 }}>
            {GIVING_COLORS.map((c) => (
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
                  border: color === c ? "2px solid var(--color-text)" : "2px solid transparent",
                }}
              />
            ))}
          </div>
        </div>
        <Field
          label="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Pledged through December"
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

function ContributeDialog({
  fund,
  onClose,
  onSaved,
}: {
  fund: GivingFund;
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = useApp((s) => s.client);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = parseAmountToCents(amount);

  const submit = async (sign: 1 | -1) => {
    if (cents === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.contributeGivingFund(fund.id, cents * sign);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={`Set aside for ${fund.name}`}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="ghost" onClick={() => void submit(-1)} disabled={cents === null || busy}>
            Take out
          </Button>
          <Button variant="primary" onClick={() => void submit(1)} disabled={cents === null || busy}>
            {busy ? <Spinner label="Saving" /> : "Add"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="t-sm t-tertiary">
          {formatCentsWhole(fund.savedCents)} set aside
          {fund.targetCents ? ` of ${formatCentsWhole(fund.targetCents)}` : ""}
        </div>
        <Field
          label="Amount"
          value={amount}
          inputMode="decimal"
          autoFocus
          onChange={(e) => setAmount(e.target.value)}
          placeholder="50.00"
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
