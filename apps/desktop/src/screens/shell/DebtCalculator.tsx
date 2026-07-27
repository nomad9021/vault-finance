import { formatCentsWhole, parseAmountToCents, type Account } from "@vault/shared";
import { Button, Dialog, Panel, Spinner } from "@vault/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";

type Debt = { id: string; name: string; balanceCents: number; apr: number; minCents: number };
type Strategy = "avalanche" | "snowball";

/** Default APR/min guesses when seeding from a liability account. */
function seedDefaults(a: Account): { apr: number; minCents: number } {
  const bal = Math.abs(a.balanceCents);
  if (a.type === "credit_card") return { apr: 22, minCents: Math.max(2500, Math.round(bal * 0.02)) };
  if (a.type === "mortgage") return { apr: 6.5, minCents: Math.max(50000, Math.round(bal * 0.005)) };
  return { apr: 8, minCents: Math.max(5000, Math.round(bal * 0.01)) };
}

interface PayoffResult {
  months: number;
  totalInterestCents: number;
  neverPayoff: boolean;
  /** Total remaining balance at the end of each month (starts with month 0). */
  trajectory: number[];
}

/** Month-by-month simulation: minimums on all debts + extra to the target debt. */
function simulate(debts: Debt[], extraCents: number, strategy: Strategy): PayoffResult {
  const balances = debts.map((d) => d.balanceCents);
  const order = debts
    .map((_, i) => i)
    .sort((a, b) =>
      strategy === "avalanche" ? debts[b]!.apr - debts[a]!.apr : balances[a]! - balances[b]!,
    );
  const sum = () => balances.reduce((s, b) => s + Math.max(0, b), 0);
  const trajectory: number[] = [sum()];
  let month = 0;
  let totalInterest = 0;
  const CAP = 1200;
  while (balances.some((b) => b > 0) && month < CAP) {
    month++;
    for (let i = 0; i < balances.length; i++) {
      if (balances[i]! <= 0) continue;
      const interest = Math.round((balances[i]! * (debts[i]!.apr / 100)) / 12);
      balances[i]! += interest;
      totalInterest += interest;
    }
    let budget =
      debts.reduce((s, d, i) => s + (balances[i]! > 0 ? d.minCents : 0), 0) + extraCents;
    for (let i = 0; i < balances.length; i++) {
      if (balances[i]! <= 0) continue;
      const pay = Math.min(balances[i]!, debts[i]!.minCents);
      balances[i]! -= pay;
      budget -= pay;
    }
    for (const i of order) {
      if (budget <= 0) break;
      if (balances[i]! <= 0) continue;
      const pay = Math.min(balances[i]!, budget);
      balances[i]! -= pay;
      budget -= pay;
    }
    trajectory.push(sum());
  }
  return {
    months: month,
    totalInterestCents: totalInterest,
    neverPayoff: month >= CAP && balances.some((b) => b > 0),
    trajectory,
  };
}

/** Balance-over-time area chart: your plan (accent) vs. minimums-only (muted). */
function PayoffChart({ plan, minOnly }: { plan: number[]; minOnly: number[] }) {
  const W = 720;
  const H = 200;
  const pad = 10;
  const start = Math.max(plan[0] ?? 0, minOnly[0] ?? 0, 1);
  // X window: enough to show the plan reaching zero, plus context from minimums.
  const xMax = Math.max(2, Math.min(Math.max(plan.length - 1, 24), 120));
  const px = (i: number) => pad + (i / xMax) * (W - 2 * pad);
  const py = (v: number) => H - pad - (Math.max(0, v) / start) * (H - 2 * pad);
  const line = (t: number[]) => {
    const n = Math.min(t.length - 1, xMax);
    return Array.from({ length: n + 1 }, (_, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(t[i]!).toFixed(1)}`).join(" ");
  };
  const planN = Math.min(plan.length - 1, xMax);
  const area = `${line(plan)} L${px(planN).toFixed(1)},${(H - pad).toFixed(1)} L${px(0).toFixed(1)},${(H - pad).toFixed(1)} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", marginBottom: 6 }} role="img" aria-label="Debt payoff over time">
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="var(--color-divider)" strokeWidth={1} />
      <path d={area} fill="color-mix(in srgb, var(--color-accent) 14%, transparent)" />
      {minOnly.length > 2 && (
        <path d={line(minOnly)} fill="none" stroke="var(--color-neutral-500)" strokeWidth={1.5} strokeDasharray="4 4" />
      )}
      <path d={line(plan)} fill="none" stroke="var(--color-accent)" strokeWidth={2.5} strokeLinecap="round" />
      {planN <= xMax && <circle cx={px(planN)} cy={py(0)} r={4} fill="var(--color-accent)" />}
    </svg>
  );
}

function monthsLabel(m: number): string {
  const y = Math.floor(m / 12);
  const mo = m % 12;
  if (y === 0) return `${mo} mo`;
  if (mo === 0) return `${y} yr`;
  return `${y} yr ${mo} mo`;
}
function payoffDate(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/**
 * Get-out-of-debt planner. Seeds from the user's liability accounts (editable),
 * then compares avalanche vs. snowball and shows how extra payments shorten the
 * payoff. Pure client-side math — no data leaves the device.
 */
export function DebtCalculator() {
  const client = useApp((s) => s.client);
  const { data, reload } = useData(() => client.accounts(), [client]);
  const { data: planData } = useData(() => client.debtPlan(), [client]);
  const liabilities = (data?.accounts ?? []).filter((a) => a.isLiability && a.balanceCents !== 0);
  const accountIds = new Set(liabilities.map((a) => a.id));

  const [manual, setManual] = useState<Debt[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Partial<Debt>>>({});
  const [extra, setExtra] = useState("200");
  const [strategy, setStrategy] = useState<Strategy>("avalanche");

  const debts: Debt[] = useMemo(() => {
    const seeded = liabilities.map((a): Debt => {
      const def = seedDefaults(a);
      const o = overrides[a.id] ?? {};
      return {
        id: a.id,
        name: o.name ?? a.name,
        balanceCents: o.balanceCents ?? Math.abs(a.balanceCents),
        apr: o.apr ?? def.apr,
        minCents: o.minCents ?? def.minCents,
      };
    });
    return [...seeded, ...manual];
  }, [liabilities, overrides, manual]);

  const extraCents = parseAmountToCents(extra) ?? 0;
  const totalDebt = debts.reduce((s, d) => s + d.balanceCents, 0);

  const plan = useMemo(() => simulate(debts, extraCents, strategy), [debts, extraCents, strategy]);
  const minOnly = useMemo(() => simulate(debts, 0, strategy), [debts, strategy]);
  const interestSaved = Math.max(0, minOnly.totalInterestCents - plan.totalInterestCents);
  const monthsSaved = Math.max(0, minOnly.months - plan.months);

  // Track whether debt has ever existed so an all-zero total reads as a
  // milestone ("debt-free!") rather than the cold-start empty state, and fire
  // the celebration exactly on the transition from owing something to owing nothing.
  const [everInDebt, setEverInDebt] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Debt | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const prevTotal = useRef(totalDebt);
  useEffect(() => {
    const was = prevTotal.current;
    prevTotal.current = totalDebt;
    if (totalDebt > 0 && !everInDebt) setEverInDebt(true);
    if (was > 0 && totalDebt === 0) {
      setCelebrate(true);
      const t = setTimeout(() => setCelebrate(false), 5000);
      return () => clearTimeout(t);
    }
    return;
  }, [totalDebt, everInDebt]);

  // Hydrate the editable state from the saved plan once it arrives, then keep
  // the server in sync (debounced) on any edit. `hydrated` guards against the
  // save effect firing with default state before the load lands.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !planData) return;
    hydrated.current = true;
    setExtra((planData.extraCents / 100).toFixed(planData.extraCents % 100 === 0 ? 0 : 2));
    setStrategy(planData.strategy);
    setOverrides(planData.overrides as Record<string, Partial<Debt>>);
    setManual(planData.manual);
  }, [planData]);

  // Keep the latest payload in a ref so we can persist it both on a short
  // debounce (while editing) and immediately when leaving — otherwise a quick
  // edit followed by navigating away would be cancelled by the debounce and the
  // Sankey would never see it.
  const payload = useMemo(
    () => ({ extraCents: parseAmountToCents(extra) ?? 0, strategy, overrides, manual }),
    [extra, strategy, overrides, manual],
  );
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  useEffect(() => {
    if (!hydrated.current) return;
    const t = setTimeout(() => void client.updateDebtPlan(payload), 500);
    return () => clearTimeout(t);
  }, [client, payload]);
  useEffect(() => {
    // Flush the newest edits when the planner unmounts (page change / close).
    return () => {
      if (hydrated.current) void client.updateDebtPlan(payloadRef.current);
    };
  }, [client]);

  const patchDebt = (d: Debt, patch: Partial<Debt>) => {
    if (accountIds.has(d.id)) {
      setOverrides((o) => ({ ...o, [d.id]: { ...o[d.id], ...patch } }));
    } else {
      setManual((m) => m.map((x) => (x.id === d.id ? { ...x, ...patch } : x)));
    }
  };
  // Manual debts are just local rows — drop them. Real accounts get archived
  // via the API (which the whole app treats as a delete), so confirm first.
  const removeDebt = (d: Debt) => {
    if (accountIds.has(d.id)) setConfirmDelete(d);
    else setManual((m) => m.filter((x) => x.id !== d.id));
  };
  const confirmRemoveAccount = async () => {
    if (!confirmDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await client.deleteAccount(confirmDelete.id);
      setOverrides((o) => {
        const { [confirmDelete.id]: _drop, ...rest } = o;
        return rest;
      });
      setConfirmDelete(null);
      reload();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Couldn’t delete the account.");
    } finally {
      setDeleting(false);
    }
  };
  const resetPlan = () => {
    setManual([]);
    setOverrides({});
    setEverInDebt(false);
    setCelebrate(false);
    prevTotal.current = 0;
  };
  const addManualDebt = () => {
    setManual((m) => [
      ...m,
      { id: `manual-${Date.now()}`, name: "New debt", balanceCents: 100000, apr: 18, minCents: 5000 },
    ]);
    setSettingsOpen(true);
  };

  // Cleared everything after having owed money: celebrate the milestone.
  if (totalDebt === 0 && everInDebt) {
    return (
      <Panel kicker="Plan" title="Get out of debt">
        <div style={{ position: "relative", overflow: "hidden", textAlign: "center", padding: "22px 0 8px" }}>
          {celebrate && <Confetti />}
          <div
            style={{
              fontSize: 48,
              lineHeight: 1,
              animation: celebrate ? "debtFreePop .55s var(--ease) both" : undefined,
            }}
          >
            🎉
          </div>
          <div
            style={{
              fontFamily: "var(--font-heading)",
              fontWeight: 700,
              fontSize: 24,
              letterSpacing: "-.02em",
              margin: "8px 0 4px",
            }}
          >
            You’re debt-free!
          </div>
          <p className="card-meta" style={{ maxWidth: 380, margin: "0 auto 14px" }}>
            Every balance is cleared. No interest, no minimums — just money that’s
            yours to keep. 🥳
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <Button variant="ghost" onClick={resetPlan}>
              Start a new plan
            </Button>
            <Button variant="secondary" onClick={addManualDebt}>
              + Add a debt
            </Button>
          </div>
        </div>
      </Panel>
    );
  }

  if (debts.length === 0) {
    return (
      <Panel kicker="Plan" title="Get out of debt">
        <p className="card-meta" style={{ marginBottom: 12 }}>
          Add a credit card or loan account (with a balance) and it shows up here automatically — or
          add a debt by hand. The planner shows how fast you can be debt-free and how much interest
          you’ll save.
        </p>
        <Button variant="primary" onClick={addManualDebt}>
          + Add a debt manually
        </Button>
      </Panel>
    );
  }

  return (
    <Panel
      kicker="Plan"
      title="Get out of debt"
      subtitle="Compare payoff strategies and see the impact of paying extra"
      actions={
        <button
          type="button"
          aria-label="Edit debts & payoff settings"
          title="Edit debts & payoff settings"
          onClick={() => setSettingsOpen(true)}
          style={{
            width: 34,
            height: 34,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--color-divider)",
            background: "var(--color-surface)",
            borderRadius: 8,
            color: "var(--color-neutral-500)",
            cursor: "pointer",
          }}
        >
          <GearIcon />
        </button>
      }
    >
      {/* Result summary */}
      <div className="grid" style={{ marginBottom: 6 }}>
        <div style={{ gridColumn: "span 4" }}>
          <div className="eyebrow">Debt-free by</div>
          <div className="metric-value" style={{ fontSize: 22 }}>
            {plan.neverPayoff ? "—" : payoffDate(plan.months)}
          </div>
          <div style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>
            {plan.neverPayoff ? "payment too low" : monthsLabel(plan.months)}
          </div>
        </div>
        <div style={{ gridColumn: "span 4" }}>
          <div className="eyebrow">Interest paid</div>
          <div className="metric-value" style={{ fontSize: 22 }}>
            {formatCentsWhole(plan.totalInterestCents)}
          </div>
          <div className="pos" style={{ fontSize: 12, fontWeight: 600 }}>
            {interestSaved > 0 ? `save ${formatCentsWhole(interestSaved)} vs. minimums` : " "}
          </div>
        </div>
        <div style={{ gridColumn: "span 4" }}>
          <div className="eyebrow">Total debt</div>
          <div className="metric-value" style={{ fontSize: 22 }}>
            {formatCentsWhole(totalDebt)}
          </div>
          <div style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>
            {monthsSaved > 0 ? `${monthsLabel(monthsSaved)} sooner` : " "}
          </div>
        </div>
      </div>

      {/* Payoff curve */}
      {!plan.neverPayoff && (
        <div style={{ marginBottom: 4 }}>
          <PayoffChart plan={plan.trajectory} minOnly={minOnly.trajectory} />
          <div style={{ display: "flex", gap: 16, fontSize: 11.5, color: "var(--color-neutral-500)" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 14, height: 3, borderRadius: 2, background: "var(--color-accent)" }} />
              Your plan — debt-free {payoffDate(plan.months)}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 14, height: 0, borderTop: "2px dashed var(--color-neutral-500)" }} />
              Minimums only
            </span>
          </div>
        </div>
      )}

      {/* Current plan summary — the numbers above react live; editing happens
          in the gear-icon settings window. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          fontSize: 12.5,
          color: "var(--color-neutral-500)",
          borderTop: "1px solid var(--hairline)",
          marginTop: 8,
          paddingTop: 12,
        }}
      >
        <span>
          <strong style={{ color: "var(--color-text)" }}>{debts.length}</strong>{" "}
          {debts.length === 1 ? "debt" : "debts"}
        </span>
        <span aria-hidden>·</span>
        <span>
          <strong style={{ color: "var(--color-text)" }}>{formatCentsWhole(extraCents)}</strong> extra / mo
        </span>
        <span aria-hidden>·</span>
        <span style={{ textTransform: "capitalize" }}>{strategy}</span>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            border: "1px solid var(--color-divider)",
            background: "var(--color-surface)",
            borderRadius: 8,
            padding: "5px 11px",
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--color-text)",
            cursor: "pointer",
          }}
        >
          <GearIcon size={14} /> Edit debts & settings
        </button>
      </div>

      {settingsOpen && (
        <DebtSettingsDialog
          debts={debts}
          extra={extra}
          strategy={strategy}
          accountIds={accountIds}
          onExtra={setExtra}
          onStrategy={setStrategy}
          onPatch={patchDebt}
          onRemove={removeDebt}
          onAdd={() =>
            setManual((m) => [
              ...m,
              { id: `manual-${Date.now()}`, name: "New debt", balanceCents: 100000, apr: 18, minCents: 5000 },
            ])
          }
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {confirmDelete && (
        <Dialog
          open
          title="Delete this account?"
          onClose={() => (deleting ? undefined : (setConfirmDelete(null), setDeleteError(null)))}
          actions={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirmDelete(null);
                  setDeleteError(null);
                }}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => void confirmRemoveAccount()}
                disabled={deleting}
                style={{ background: "var(--color-negative)", borderColor: "var(--color-negative)", color: "#fff" }}
              >
                {deleting ? <Spinner label="Deleting" /> : "Delete account"}
              </Button>
            </>
          }
        >
          <p className="card-body" style={{ margin: 0, lineHeight: 1.6 }}>
            <strong>{confirmDelete.name}</strong> will be removed from your accounts —
            it’ll disappear from balances, net worth, and this planner. This is the same
            as deleting it from the Accounts page.
          </p>
          {deleteError && (
            <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)", marginTop: 10 }}>
              {deleteError}
            </div>
          )}
        </Dialog>
      )}
    </Panel>
  );
}

/** Crisp settings gear, sized to its container's font color. */
function GearIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <path
        d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M19.4 13a7.6 7.6 0 0 0 .05-2l1.7-1.3-1.7-3-2 .8a7.7 7.7 0 0 0-1.75-1l-.3-2.1h-3.4l-.3 2.1a7.7 7.7 0 0 0-1.75 1l-2-.8-1.7 3L5.65 11a7.6 7.6 0 0 0 0 2l-1.7 1.3 1.7 3 2-.8c.53.42 1.12.76 1.75 1l.3 2.1h3.4l.3-2.1c.63-.24 1.22-.58 1.75-1l2 .8 1.7-3L19.4 13Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The pop-up settings window: everything editable about the payoff plan —
 * monthly extra, strategy, and each debt's name / balance / APR / minimum, plus
 * removing a debt (deletes the account for account-backed rows) and adding one.
 */
function DebtSettingsDialog({
  debts,
  extra,
  strategy,
  accountIds,
  onExtra,
  onStrategy,
  onPatch,
  onRemove,
  onAdd,
  onClose,
}: {
  debts: Debt[];
  extra: string;
  strategy: Strategy;
  accountIds: Set<string>;
  onExtra: (v: string) => void;
  onStrategy: (s: Strategy) => void;
  onPatch: (d: Debt, patch: Partial<Debt>) => void;
  onRemove: (d: Debt) => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  const miniLabel = {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: ".04em",
    textTransform: "uppercase",
    color: "var(--color-neutral-500)",
    marginBottom: 3,
    display: "block",
  } as const;
  return (
    <Dialog
      open
      title="Debt plan settings"
      onClose={onClose}
      actions={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <span style={miniLabel}>Extra / month</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--color-neutral-500)" }}>$</span>
              <input
                className="input"
                value={extra}
                onChange={(e) => onExtra(e.target.value)}
                inputMode="decimal"
                style={{ width: 110 }}
              />
            </div>
          </div>
          <div>
            <span style={miniLabel}>Strategy</span>
            <div className="seg">
              <label className="seg-opt">
                <input type="radio" name="strategy" checked={strategy === "avalanche"} onChange={() => onStrategy("avalanche")} />
                Avalanche
              </label>
              <label className="seg-opt">
                <input type="radio" name="strategy" checked={strategy === "snowball"} onChange={() => onStrategy("snowball")} />
                Snowball
              </label>
            </div>
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--color-neutral-500)", lineHeight: 1.5 }}>
          {strategy === "avalanche"
            ? "Avalanche: extra goes to the highest-APR debt first — least interest."
            : "Snowball: extra goes to the smallest balance first — fastest wins for motivation."}
        </div>

        <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 12 }}>
          <span style={miniLabel}>Your debts</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {debts.map((d) => {
              const linked = accountIds.has(d.id);
              return (
                <div
                  key={d.id}
                  style={{
                    border: "1px solid var(--color-divider)",
                    borderRadius: 10,
                    padding: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      className="input"
                      value={d.name}
                      onChange={(e) => onPatch(d, { name: e.target.value })}
                      placeholder="Debt name"
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <button
                      type="button"
                      aria-label={`Remove ${d.name}`}
                      title={linked ? "Delete this account" : "Remove this debt"}
                      onClick={() => onRemove(d)}
                      style={{
                        width: 30,
                        height: 30,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        border: "1px solid var(--color-divider)",
                        background: "var(--color-surface)",
                        borderRadius: 7,
                        color: "var(--color-negative)",
                        cursor: "pointer",
                        fontSize: 17,
                        lineHeight: 1,
                        flex: "0 0 auto",
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <label style={{ flex: 1 }}>
                      <span style={miniLabel}>Balance $</span>
                      <input
                        className="input num"
                        value={(d.balanceCents / 100).toFixed(0)}
                        onChange={(e) => onPatch(d, { balanceCents: parseAmountToCents(e.target.value) ?? 0 })}
                        inputMode="numeric"
                        style={{ width: "100%", textAlign: "right", fontWeight: 600 }}
                      />
                    </label>
                    <label style={{ width: 72 }}>
                      <span style={miniLabel}>APR %</span>
                      <input
                        className="input"
                        value={String(d.apr)}
                        onChange={(e) => onPatch(d, { apr: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })}
                        inputMode="decimal"
                        style={{ width: "100%", textAlign: "right" }}
                      />
                    </label>
                    <label style={{ width: 92 }}>
                      <span style={miniLabel}>Min / mo</span>
                      <input
                        className="input"
                        value={(d.minCents / 100).toFixed(0)}
                        onChange={(e) => onPatch(d, { minCents: parseAmountToCents(e.target.value) ?? 0 })}
                        inputMode="numeric"
                        style={{ width: "100%", textAlign: "right" }}
                      />
                    </label>
                  </div>
                  <span style={{ fontSize: 10.5, color: "var(--color-neutral-500)" }}>
                    {linked ? "🔗 From a linked account — removing deletes the account" : "✎ Manual entry"}
                  </span>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 10 }}>
            <Button variant="ghost" onClick={onAdd}>
              + Add a debt manually
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

const CONFETTI_COLORS = ["#3ecf8e", "#43cfc0", "#6f8ef2", "#b47ef0", "#ec6a9c", "#d8b23c"];

/** A one-shot burst of falling confetti for the debt-free milestone. */
function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 28 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.7,
        duration: 1.8 + Math.random() * 1.4,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
        size: 6 + Math.random() * 6,
      })),
    [],
  );
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
      {pieces.map((p, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            top: -14,
            left: `${p.left}%`,
            width: p.size,
            height: p.size * 0.42,
            background: p.color,
            borderRadius: 1,
            animation: `confettiFall ${p.duration}s linear ${p.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
