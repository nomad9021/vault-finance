import {
  ApiRequestError,
  formatCentsWhole,
  PAY_PERIODS,
  parseAmountToCents,
  type FilingStatus,
  type PayFrequency,
  type TaxEstimate,
  type TaxGroup,
  type TaxPlacesResponse,
  type TaxProfileInput,
} from "@vault/shared";
import { Banner, Button, Card, Field, Sankey, Segmented, Select, Spinner, Tag } from "@vault/ui";
import { useEffect, useMemo, useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";

/**
 * Salary & taxes: gross pay in, take-home out. The household's earners,
 * pre-tax deductions and location feed the shared 2026 tax engine; the
 * estimate updates as you type, saving it keeps the budget planner's income
 * in step, and a tax Sankey shows where each paycheck goes. "Compare a move"
 * runs the same numbers somewhere else.
 */

const STATUS_LABELS: Record<FilingStatus, string> = {
  single: "Single",
  married_joint: "Married, filing jointly",
  married_separate: "Married, filing separately",
  head_of_household: "Head of household",
};
const FREQ_LABELS: Record<PayFrequency, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  semimonthly: "Twice a month",
  monthly: "Monthly",
};
const GROUP: Record<TaxGroup | "takehome", { label: string; color: string }> = {
  pretax: { label: "Pre-tax savings", color: "#43cfc0" },
  federal: { label: "Federal tax", color: "#6f8ef2" },
  fica: { label: "Social Security & Medicare", color: "#b47ef0" },
  state: { label: "State tax", color: "#ec6a9c" },
  local: { label: "Local tax", color: "#d8b23c" },
  payroll: { label: "State payroll programs", color: "#4db6d0" },
  takehome: { label: "Take-home pay", color: "#3ecf8e" },
};

type Earner = TaxProfileInput["earners"][number];
const blankEarner = (n: number): Earner => ({ name: n ? `Earner ${n + 1}` : "Me", grossAnnualCents: 0, payFrequency: "biweekly" });
const DEFAULT_PROFILE: TaxProfileInput = {
  filingStatus: "single",
  state: "CO",
  locality: null,
  dependents: 0,
  earners: [blankEarner(0)],
  syncPlannedIncome: true,
};

/** Money input that edits whole dollars but stores cents. */
function MoneyField({ label, cents, onCents, hint }: { label: string; cents: number | null | undefined; onCents: (c: number) => void; hint?: string }) {
  const [text, setText] = useState(cents ? String(Math.round(cents / 100)) : "");
  useEffect(() => setText(cents ? String(Math.round(cents / 100)) : ""), [cents]);
  return (
    <Field
      label={label}
      inputMode="decimal"
      value={text}
      placeholder="0"
      {...(hint ? { hint } : {})}
      onChange={(e) => {
        setText(e.target.value);
        onCents(parseAmountToCents(e.target.value) ?? 0);
      }}
    />
  );
}

function useEstimate(profile: TaxProfileInput | null) {
  const client = useApp((s) => s.client);
  const [estimate, setEstimate] = useState<TaxEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(profile);
  useEffect(() => {
    if (!profile || !profile.earners.some((e) => e.grossAnnualCents > 0)) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      client
        .estimateTax(profile)
        .then((e) => !cancelled && (setEstimate(e), setError(null)))
        .catch((err) => !cancelled && setError(err instanceof ApiRequestError ? err.message : "Couldn't estimate."));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  return { estimate, error };
}

export function TaxesPage() {
  const client = useApp((s) => s.client);
  const { data, reload } = useData(() => client.taxProfile(), [client]);
  const { data: places } = useData<TaxPlacesResponse>(() => client.taxPlaces(), [client]);
  const [draft, setDraft] = useState<TaxProfileInput | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<"year" | "month">("year");
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => {
    if (data && !dirty) setDraft(data.profile ?? DEFAULT_PROFILE);
  }, [data, dirty]);

  const { estimate, error: estError } = useEstimate(draft);
  const edit = (patch: Partial<TaxProfileInput>) => {
    setDraft((d) => ({ ...(d ?? DEFAULT_PROFILE), ...patch }));
    setDirty(true);
    setSaved(false);
  };
  const editEarner = (i: number, patch: Partial<Earner>) =>
    edit({ earners: (draft?.earners ?? []).map((e, j) => (j === i ? { ...e, ...patch } : e)) });

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await client.saveTaxProfile(draft);
      setDirty(false);
      setSaved(true);
      reload();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };

  if (!draft || !places) return <Spinner label="Loading" />;
  const localities = places.localities.filter((l) => l.state === draft.state);
  const div = period === "year" ? 1 : 12;
  const money = (c: number) => formatCentsWhole(Math.round(c / div));

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Salary &amp; taxes</h1>
          <p className="card-meta" style={{ margin: 0 }}>
            {places.year} US estimate · federal, Social Security &amp; Medicare, all 50 states + DC, main local taxes
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {saved && <Tag variant="positive">Saved</Tag>}
          <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? <Spinner label="Saving" /> : "Save"}
          </Button>
        </div>
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      {estError && <Banner tone="warning">{estError}</Banner>}

      {estimate && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <Card kicker="Take-home" title={formatCentsWhole(estimate.takeHomeCents)}>
            <p className="card-meta">{formatCentsWhole(Math.round(estimate.takeHomeCents / 12))} a month</p>
          </Card>
          <Card kicker="Taxes" title={formatCentsWhole(estimate.taxCents)}>
            <p className="card-meta">{estimate.effectiveRatePct}% of gross pay</p>
          </Card>
          <Card kicker="Next dollar earned" title={`${Math.round((estimate.marginalFederalPct + estimate.marginalStatePct) * 10) / 10}% tax`}>
            <p className="card-meta">
              {estimate.marginalFederalPct}% federal + {estimate.marginalStatePct}% state/local, plus FICA
            </p>
          </Card>
          <Card kicker="Saved before tax" title={formatCentsWhole(estimate.pretaxCents)}>
            <p className="card-meta">401(k), HSA and premiums</p>
          </Card>
        </div>
      )}

      {estimate && <TaxSankey estimate={estimate} period={period} setPeriod={setPeriod} focus={focus} setFocus={setFocus} />}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16, alignItems: "start" }}>
        <Card kicker="Household" title="Where you live and file">
          <Select label="Filing status" value={draft.filingStatus} onChange={(e) => edit({ filingStatus: e.target.value as FilingStatus })}>
            {Object.entries(STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </Select>
          <Select label="State" value={draft.state} onChange={(e) => edit({ state: e.target.value, locality: null })}>
            {places.states.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}{s.taxesWages ? "" : " (no wage tax)"}
              </option>
            ))}
          </Select>
          {localities.length > 0 && (
            <Select label="City / county" value={draft.locality ?? ""} onChange={(e) => edit({ locality: e.target.value || null })}>
              <option value="">None of these</option>
              {localities.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}{l.verified ? "" : " (check pay stub)"}
                </option>
              ))}
            </Select>
          )}
          {!draft.locality && (
            <Field
              label="Other local income tax %"
              inputMode="decimal"
              value={draft.customLocalRatePct ?? ""}
              placeholder="0"
              hint="For a city or county not listed above."
              onChange={(e) => edit({ customLocalRatePct: e.target.value ? Number(e.target.value) : null })}
            />
          )}
          <Field
            label="State payroll deductions %"
            inputMode="decimal"
            value={draft.otherPayrollPct ?? ""}
            placeholder="0"
            hint="Paid leave or disability % from a pay stub, if your state has one we don't know."
            onChange={(e) => edit({ otherPayrollPct: e.target.value ? Number(e.target.value) : null })}
          />
          <Field
            label="Children under 17"
            inputMode="numeric"
            value={draft.dependents ?? 0}
            onChange={(e) => edit({ dependents: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          />
          <label className="radio" style={{ fontSize: "var(--text-sm)" }}>
            <input type="checkbox" checked={draft.syncPlannedIncome ?? true} onChange={(e) => edit({ syncPlannedIncome: e.target.checked })} />
            <span className="dot" style={{ borderRadius: "var(--radius-sm)" }} />
            Use the monthly take-home as the budget planner's income
          </label>
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {draft.earners.map((e, i) => {
            const p = estimate?.perEarner[i];
            const periods = PAY_PERIODS[e.payFrequency ?? "biweekly"];
            return (
              <Card key={i} kicker="Earner" title={e.name || `Earner ${i + 1}`}>
                <Field label="Name" value={e.name} onChange={(ev) => editEarner(i, { name: ev.target.value })} />
                <MoneyField label="Salary before tax (per year)" cents={e.grossAnnualCents} onCents={(c) => editEarner(i, { grossAnnualCents: c })} />
                <Select label="Paid" value={e.payFrequency ?? "biweekly"} onChange={(ev) => editEarner(i, { payFrequency: ev.target.value as PayFrequency })}>
                  {Object.entries(FREQ_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </Select>
                <Field
                  label="401(k) / 403(b) % of pay"
                  inputMode="decimal"
                  value={e.retirementPct ?? ""}
                  placeholder="0"
                  onChange={(ev) => editEarner(i, { retirementPct: ev.target.value ? Number(ev.target.value) : null, retirementCents: null })}
                />
                <MoneyField label="HSA through payroll (per year)" cents={e.hsaCents} onCents={(c) => editEarner(i, { hsaCents: c })} />
                <MoneyField label="Health premiums (per year)" cents={e.healthPremiumCents} onCents={(c) => editEarner(i, { healthPremiumCents: c })} />
                <MoneyField label="Other pre-tax (FSA, commuter; per year)" cents={e.otherPretaxCents} onCents={(c) => editEarner(i, { otherPretaxCents: c })} />
                {p && (
                  <p className="card-body" style={{ margin: 0 }}>
                    Take-home <strong>{formatCentsWhole(p.takeHomeCents)}</strong> a year ·{" "}
                    <strong>{formatCentsWhole(Math.round(p.takeHomeCents / periods))}</strong> per paycheck
                  </p>
                )}
                {draft.earners.length > 1 && (
                  <Button variant="ghost" icon="trash" onClick={() => edit({ earners: draft.earners.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                )}
              </Card>
            );
          })}
          {draft.earners.length < 6 && (
            <Button variant="secondary" icon="plus" onClick={() => edit({ earners: [...draft.earners, blankEarner(draft.earners.length)] })}>
              Add an earner
            </Button>
          )}
        </div>
      </div>

      {estimate && (
        <Card kicker="Breakdown" title={`Where ${period === "year" ? "a year" : "a month"} of pay goes`}>
          <table className="table">
            <tbody>
              <tr>
                <td>Gross pay</td>
                <td style={{ textAlign: "right" }}>{money(estimate.grossCents)}</td>
              </tr>
              {estimate.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: GROUP[l.group].color, marginRight: 8 }} />
                    {l.label}
                  </td>
                  <td style={{ textAlign: "right" }}>−{money(l.amountCents)}</td>
                </tr>
              ))}
              <tr>
                <td><strong>Take-home</strong></td>
                <td style={{ textAlign: "right" }}><strong>{money(estimate.takeHomeCents)}</strong></td>
              </tr>
            </tbody>
          </table>
          {estimate.notes.map((n) => (
            <p key={n} className="card-meta" style={{ margin: "4px 0 0" }}>{n}</p>
          ))}
        </Card>
      )}

      {estimate && <CompareMove profile={draft} current={estimate} places={places} />}
    </div>
  );
}

/** Gross pay → earners' hub → pre-tax, each tax, take-home. */
function TaxSankey({
  estimate,
  period,
  setPeriod,
  focus,
  setFocus,
}: {
  estimate: TaxEstimate;
  period: "year" | "month";
  setPeriod: (p: "year" | "month") => void;
  focus: string | null;
  setFocus: (id: string | null) => void;
}) {
  const { nodes, links } = useMemo(() => {
    const div = period === "year" ? 1 : 12;
    const v = (c: number) => Math.max(0, Math.round(c / div));
    const nodes: Parameters<typeof Sankey>[0]["nodes"] = [];
    const links: Parameters<typeof Sankey>[0]["links"] = [];
    estimate.perEarner.forEach((p, i) => {
      nodes.push({ id: `earner:${i}`, label: p.name, value: v(p.grossCents), color: "#6f8ef2", depth: 0, kind: "income" });
      links.push({ from: `earner:${i}`, to: "hub", value: v(p.grossCents) });
    });
    nodes.push({ id: "hub", label: "Gross pay", value: v(estimate.grossCents), color: "#9397ab", depth: 1, kind: "hub" });
    const groups = new Map<TaxGroup, number>();
    for (const l of estimate.lines) groups.set(l.group, (groups.get(l.group) ?? 0) + Math.max(0, l.amountCents));
    for (const [g, cents] of groups) {
      if (cents <= 0) continue;
      nodes.push({ id: `g:${g}`, label: GROUP[g].label, value: v(cents), color: GROUP[g].color, depth: 2, kind: "category" });
      links.push({ from: "hub", to: `g:${g}`, value: v(cents) });
      for (const l of estimate.lines.filter((x) => x.group === g && x.amountCents > 0)) {
        if (groups.get(g) === l.amountCents && estimate.lines.filter((x) => x.group === g).length === 1) continue;
        nodes.push({ id: `l:${l.id}`, label: l.label, value: v(l.amountCents), color: GROUP[g].color, depth: 3, kind: "category" });
        links.push({ from: `g:${g}`, to: `l:${l.id}`, value: v(l.amountCents) });
      }
    }
    nodes.push({ id: "takehome", label: GROUP.takehome.label, value: v(estimate.takeHomeCents), color: GROUP.takehome.color, depth: 2, kind: "saved" });
    links.push({ from: "hub", to: "takehome", value: v(estimate.takeHomeCents) });
    return { nodes, links };
  }, [estimate, period]);

  return (
    <Card kicker="Tax Sankey" title="Where your pay goes">
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Segmented
          aria-label="Period"
          options={[
            { value: "year", label: "Yearly" },
            { value: "month", label: "Monthly" },
          ]}
          value={period}
          onChange={setPeriod}
        />
      </div>
      {/* Node values are already per period. */}
      <Sankey nodes={nodes} links={links} format={(n) => formatCentsWhole(n)} focus={focus} onFocus={setFocus} ariaLabel="Tax Sankey" />
    </Card>
  );
}

/** Same household, different place: what changes. */
function CompareMove({ profile, current, places }: { profile: TaxProfileInput; current: TaxEstimate; places: TaxPlacesResponse }) {
  const [state, setState] = useState(profile.state === "TX" ? "CO" : "TX");
  const [locality, setLocality] = useState<string | null>(null);
  const other = useEstimate({ ...profile, state, locality, customLocalRatePct: null, otherPayrollPct: null });
  const diff = other.estimate ? other.estimate.takeHomeCents - current.takeHomeCents : 0;
  const locs = places.localities.filter((l) => l.state === state);
  return (
    <Card kicker="Compare a move" title="Take-home somewhere else">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <Select label="State" value={state} onChange={(e) => (setState(e.target.value), setLocality(null))}>
          {places.states.map((s) => (
            <option key={s.code} value={s.code}>{s.name}</option>
          ))}
        </Select>
        {locs.length > 0 && (
          <Select label="City / county" value={locality ?? ""} onChange={(e) => setLocality(e.target.value || null)}>
            <option value="">None of these</option>
            {locs.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </Select>
        )}
      </div>
      {other.estimate && (
        <p className="card-body">
          Take-home in {other.estimate.stateName}: <strong>{formatCentsWhole(other.estimate.takeHomeCents)}</strong> a year —{" "}
          <strong style={{ color: diff >= 0 ? "var(--color-positive)" : "var(--color-negative)" }}>
            {diff >= 0 ? "+" : "−"}
            {formatCentsWhole(Math.abs(diff))}
          </strong>{" "}
          ({diff >= 0 ? "+" : "−"}
          {formatCentsWhole(Math.abs(Math.round(diff / 12)))} a month) compared with now. Same pay; only taxes change.
        </p>
      )}
    </Card>
  );
}
