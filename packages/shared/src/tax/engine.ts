import {
  FEDERAL_2026,
  FICA_2026,
  LOCALITIES_2026,
  STATE_PAYROLL_2026,
  STATE_PAYROLL_UNCONFIRMED,
  STATES_2026,
  STATES_TAXING_401K,
  STATES_TAXING_HSA,
  TAX_YEAR,
  type Brackets,
  type Locality,
  type StateTax,
} from "./data-2026.js";

/**
 * Take-home pay estimate for a household of wage earners: federal income tax
 * (with the child tax credit), FICA, state income tax, local income tax and
 * confirmed state payroll programs. It's an estimate — it assumes wages are
 * the only income and the standard deduction — and says so in `notes`.
 * Pure: the server, the app and the AI agents all use it.
 */

export type FilingStatus = "single" | "married_joint" | "married_separate" | "head_of_household";

export interface TaxEarnerInput {
  name: string;
  grossAnnualCents: number;
  /** Pre-tax 401(k)/403(b): a % of gross, or a fixed yearly amount (cents). */
  retirementPct?: number | null | undefined;
  retirementCents?: number | null | undefined;
  /** Payroll HSA contributions per year. */
  hsaCents?: number | null | undefined;
  /** Pre-tax health/dental/vision premiums per year (section 125: also skip FICA). */
  healthPremiumCents?: number | null | undefined;
  /** Other pre-tax deductions (FSA, commuter) per year. */
  otherPretaxCents?: number | null | undefined;
}

export interface TaxInput {
  filingStatus: FilingStatus;
  /** Two-letter state code, e.g. "CO". */
  state: string;
  locality?: string | null | undefined;
  /** Local income tax % on wages, for places not in the list. */
  customLocalRatePct?: number | null | undefined;
  /** Extra state payroll deduction % (paid leave/disability) read from a pay stub. */
  otherPayrollPct?: number | null | undefined;
  /** Children under 17, for the child tax credit. */
  dependents?: number | null | undefined;
  earners: TaxEarnerInput[];
}

export type TaxGroup = "pretax" | "federal" | "fica" | "state" | "local" | "payroll";

export interface TaxLine {
  id: string;
  label: string;
  group: TaxGroup;
  amountCents: number;
}

export interface TaxEstimate {
  year: number;
  state: string;
  stateName: string;
  locality: string | null;
  grossCents: number;
  /** Retirement, HSA, premiums: money that's still yours but not take-home. */
  pretaxCents: number;
  /** Income taxes + FICA + payroll programs. */
  taxCents: number;
  takeHomeCents: number;
  /** taxCents / gross. */
  effectiveRatePct: number;
  /** Rate on the next dollar earned: federal, state (+ local). */
  marginalFederalPct: number;
  marginalStatePct: number;
  lines: TaxLine[];
  perEarner: Array<{ name: string; grossCents: number; pretaxCents: number; taxCents: number; takeHomeCents: number }>;
  notes: string[];
}

const dollars = (cents: number | null | undefined) => (cents ?? 0) / 100;
const cents = (d: number) => Math.round(d * 100);

/** Tax on `income` with progressive brackets; also the rate on the next dollar. */
export function bracketTax(brackets: Brackets, income: number): { tax: number; marginal: number } {
  let tax = 0;
  let marginal = 0;
  for (let i = 0; i < brackets.length; i++) {
    const [rate, start] = brackets[i]!;
    const end = brackets[i + 1]?.[1] ?? Infinity;
    if (income <= start) break;
    tax += ((Math.min(income, end) - start) * rate) / 100;
    marginal = rate;
  }
  return { tax, marginal };
}

export function findLocality(id: string | null | undefined): Locality | undefined {
  return id ? LOCALITIES_2026.find((l) => l.id === id) : undefined;
}

export function estimateTaxes(input: TaxInput): TaxEstimate {
  const status = input.filingStatus;
  const joint = status === "married_joint";
  const code = input.state.toUpperCase();
  const st: StateTax | undefined = (STATES_2026 as Record<string, StateTax>)[code];
  if (!st) throw new Error(`Unknown state "${input.state}" (use a two-letter code like CO).`);
  const kids = Math.max(0, Math.floor(input.dependents ?? 0));
  const notes: string[] = [];

  // ---- per earner: wages and pre-tax money ----
  const earners = input.earners.map((e) => {
    const gross = Math.max(0, dollars(e.grossAnnualCents));
    const retirement = Math.min(gross, e.retirementCents != null ? dollars(e.retirementCents) : (gross * (e.retirementPct ?? 0)) / 100);
    const hsa = dollars(e.hsaCents);
    const premiums = dollars(e.healthPremiumCents);
    const other = dollars(e.otherPretaxCents);
    // Section 125 (premiums, HSA through payroll, FSA) also escapes FICA; 401(k) doesn't.
    const ficaWages = Math.max(0, gross - hsa - premiums - other);
    return { name: e.name, gross, retirement, hsa, premiums, other, ficaWages, pretax: retirement + hsa + premiums + other };
  });
  const gross = earners.reduce((s, e) => s + e.gross, 0);
  const pretax = earners.reduce((s, e) => s + e.pretax, 0);

  // ---- federal ----
  const fedAgi = Math.max(0, gross - pretax);
  const fedTaxable = Math.max(0, fedAgi - FEDERAL_2026.standardDeduction[status]);
  const fed = bracketTax(FEDERAL_2026.brackets[status], fedTaxable);
  let fedTax = fed.tax;
  if (kids > 0) {
    const over = Math.max(0, fedAgi - FEDERAL_2026.childTaxCreditPhaseout[status]);
    const credit = Math.max(0, kids * FEDERAL_2026.childTaxCredit - Math.ceil(over / 1000) * 50);
    const nonRefundable = Math.min(fedTax, credit);
    const refundable = Math.min(credit - nonRefundable, kids * FEDERAL_2026.childTaxCreditRefundable, Math.max(0, (gross - 2_500) * 0.15));
    fedTax = fedTax - nonRefundable - refundable;
  }

  // ---- FICA (per earner; extra Medicare by filing status) ----
  const ssPerEarner = earners.map((e) => (Math.min(e.ficaWages, FICA_2026.socialSecurityWageBase) * FICA_2026.socialSecurityRate) / 100);
  const medicarePerEarner = earners.map((e) => (e.ficaWages * FICA_2026.medicareRate) / 100);
  const medicareWages = earners.reduce((s, e) => s + e.ficaWages, 0);
  const extraMedicare = (Math.max(0, medicareWages - FICA_2026.additionalMedicareThreshold[status]) * FICA_2026.additionalMedicareRate) / 100;

  // ---- state ----
  const noWageTax = st.single.length === 0;
  const stateIncome = earners.reduce(
    (s, e) =>
      s + e.gross - e.premiums - e.other - (STATES_TAXING_401K.has(code) ? 0 : e.retirement) - (STATES_TAXING_HSA.has(code) ? 0 : e.hsa),
    0,
  );
  const pair = joint ? 1 : 0;
  const stateTaxable = noWageTax ? 0 : Math.max(0, stateIncome - st.std[pair] - st.exemption[pair] - kids * st.exemption[2]);
  const stBrackets = joint ? st.married : st.single;
  const stateRaw = bracketTax(stBrackets, stateTaxable);
  const stateTax = Math.max(0, stateRaw.tax - st.stdCredit[pair] - st.exemptionCredit[pair] - kids * st.exemptionCredit[2]);
  if (!noWageTax && (status === "head_of_household" || status === "married_separate")) {
    notes.push(`${st.name} tax uses its single-filer brackets for this filing status, which may differ slightly.`);
  }
  if (code === "WA") notes.push("Washington doesn't tax wages (its 7%/9% tax is on capital gains).");

  // ---- local ----
  const loc = findLocality(input.locality);
  let localTax = 0;
  let localMarginal = 0;
  if (loc) {
    if (loc.state !== code) throw new Error(`${loc.name} is in ${loc.state}, not ${code}.`);
    if (loc.kind === "wages") {
      const wages = earners.reduce((s, e) => s + e.ficaWages, 0);
      localTax = (wages * loc.ratePct) / 100;
      localMarginal = loc.ratePct;
    } else if (loc.kind === "stateTaxable") {
      const b = loc.ratePct != null ? ([[loc.ratePct, 0]] as const) : joint ? loc.married! : loc.single!;
      const r = bracketTax(b, stateTaxable);
      localTax = r.tax;
      localMarginal = r.marginal;
    } else if (loc.kind === "stateTax") {
      localTax = (stateTax * loc.ratePct) / 100;
      localMarginal = (stateRaw.marginal * loc.ratePct) / 100;
    } else {
      for (const t of loc.tiers) {
        const over = Math.max(0, stateTaxable - t.over[pair]);
        localTax += (over * t.ratePct) / 100;
        if (over > 0) localMarginal += t.ratePct;
      }
    }
    if (!loc.verified) notes.push(`${loc.name}'s rate (${loc.source.toLowerCase()}) isn't confirmed with the city; check it against a pay stub.`);
  }
  if (!loc && input.customLocalRatePct) {
    localTax = (earners.reduce((s, e) => s + e.ficaWages, 0) * input.customLocalRatePct) / 100;
    localMarginal = input.customLocalRatePct;
  }

  // ---- state payroll programs ----
  const payrollLines: TaxLine[] = [];
  const payrollPerEarner = earners.map(() => 0);
  for (const p of STATE_PAYROLL_2026[code] ?? []) {
    let total = 0;
    earners.forEach((e, i) => {
      const base = p.wageBaseCents ? Math.min(e.ficaWages, dollars(p.wageBaseCents)) : e.ficaWages;
      let amt = (base * p.ratePct) / 100;
      if (p.capCents) amt = Math.min(amt, dollars(p.capCents));
      payrollPerEarner[i]! += amt;
      total += amt;
    });
    payrollLines.push({ id: p.id, label: p.label, group: "payroll", amountCents: cents(total) });
  }
  if (input.otherPayrollPct) {
    let total = 0;
    earners.forEach((e, i) => {
      const amt = (e.ficaWages * input.otherPayrollPct!) / 100;
      payrollPerEarner[i]! += amt;
      total += amt;
    });
    payrollLines.push({ id: "payroll_other", label: "Other state payroll deductions", group: "payroll", amountCents: cents(total) });
  } else if (STATE_PAYROLL_UNCONFIRMED.has(code)) {
    notes.push(`${st.name} has a paid-leave/disability payroll deduction that isn't included; add its % from a pay stub to include it.`);
  }

  // ---- lines ----
  const lines = ([
    { id: "retirement", label: "401(k) / retirement", group: "pretax", amountCents: cents(earners.reduce((s, e) => s + e.retirement, 0)) },
    { id: "hsa", label: "HSA", group: "pretax", amountCents: cents(earners.reduce((s, e) => s + e.hsa, 0)) },
    { id: "premiums", label: "Health premiums", group: "pretax", amountCents: cents(earners.reduce((s, e) => s + e.premiums, 0)) },
    { id: "other_pretax", label: "Other pre-tax", group: "pretax", amountCents: cents(earners.reduce((s, e) => s + e.other, 0)) },
    { id: "federal", label: "Federal income tax", group: "federal", amountCents: cents(fedTax) },
    { id: "social_security", label: "Social Security", group: "fica", amountCents: cents(ssPerEarner.reduce((a, b) => a + b, 0)) },
    { id: "medicare", label: "Medicare", group: "fica", amountCents: cents(medicarePerEarner.reduce((a, b) => a + b, 0) + extraMedicare) },
    { id: "state", label: `${st.name} income tax`, group: "state", amountCents: cents(stateTax) },
    { id: "local", label: loc ? `${loc.name} tax` : "Local income tax", group: "local", amountCents: cents(localTax) },
    ...payrollLines,
  ] satisfies TaxLine[]).filter((l) => l.amountCents !== 0) as TaxLine[];

  const taxCents = lines.filter((l) => l.group !== "pretax").reduce((s, l) => s + l.amountCents, 0);
  const pretaxCents = lines.filter((l) => l.group === "pretax").reduce((s, l) => s + l.amountCents, 0);
  const grossCents = cents(gross);

  // Income taxes split by each earner's share of taxable wages; FICA/payroll are exact.
  const shareBase = earners.reduce((s, e) => s + Math.max(0, e.gross - e.pretax), 0) || 1;
  const incomeTaxes = fedTax + stateTax + localTax;
  const perEarner = earners.map((e, i) => {
    const share = Math.max(0, e.gross - e.pretax) / shareBase;
    const ems = earners.length > 1 ? (extraMedicare * e.ficaWages) / (medicareWages || 1) : extraMedicare;
    const tax = incomeTaxes * share + ssPerEarner[i]! + medicarePerEarner[i]! + ems + payrollPerEarner[i]!;
    return { name: e.name, grossCents: cents(e.gross), pretaxCents: cents(e.pretax), taxCents: cents(tax), takeHomeCents: cents(e.gross - e.pretax - tax) };
  });

  notes.push("Estimate: wages only, standard deduction, no other credits. Your actual refund or bill can differ.");
  return {
    year: TAX_YEAR,
    state: code,
    stateName: st.name,
    locality: loc?.id ?? null,
    grossCents,
    pretaxCents,
    taxCents,
    takeHomeCents: grossCents - pretaxCents - taxCents,
    effectiveRatePct: grossCents ? Math.round((taxCents / grossCents) * 1000) / 10 : 0,
    marginalFederalPct: fed.marginal,
    marginalStatePct: Math.round((stateRaw.marginal + localMarginal) * 100) / 100,
    lines,
    perEarner,
    notes,
  };
}

/** Pay periods per year. */
export const PAY_PERIODS = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 } as const;
export type PayFrequency = keyof typeof PAY_PERIODS;
