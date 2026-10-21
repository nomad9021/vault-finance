/**
 * 2026 US tax data for take-home estimates. Every figure names its source;
 * `verified: false` marks ones taken from consistent secondary sources
 * rather than the taxing authority, which the app flags as "check your pay
 * stub". Regenerate the state table from the Tax Foundation spreadsheet each
 * year (docs/taxes.md).
 */

export const TAX_YEAR = 2026;

/** [rate %, taxable income where the rate starts]. */
export type Brackets = ReadonlyArray<readonly [number, number]>;

/** IRS Rev. Proc. 2025-32 §4.01 (tax tables), §4.05 (child tax credit), §4.14 (standard deduction). */
export const FEDERAL_2026 = {
  source: "IRS Rev. Proc. 2025-32",
  brackets: {
    single: [[10, 0], [12, 12_400], [22, 50_400], [24, 105_700], [32, 201_775], [35, 256_225], [37, 640_600]],
    married_joint: [[10, 0], [12, 24_800], [22, 100_800], [24, 211_400], [32, 403_550], [35, 512_450], [37, 768_700]],
    head_of_household: [[10, 0], [12, 17_700], [22, 67_450], [24, 105_700], [32, 201_750], [35, 256_200], [37, 640_600]],
    married_separate: [[10, 0], [12, 12_400], [22, 50_400], [24, 105_700], [32, 201_775], [35, 256_225], [37, 384_350]],
  },
  standardDeduction: { single: 16_100, married_joint: 32_200, head_of_household: 24_150, married_separate: 16_100 },
  childTaxCredit: 2_200,
  childTaxCreditRefundable: 1_700,
  /** IRC §24(b): $50 less per $1,000 of income over these (not inflation-indexed). */
  childTaxCreditPhaseout: { single: 200_000, married_joint: 400_000, head_of_household: 200_000, married_separate: 200_000 },
} as const satisfies { brackets: Record<string, Brackets> } & Record<string, unknown>;

/** FICA: 6.2% Social Security up to the wage base, 1.45% Medicare, +0.9% over the thresholds (IRC §3101). */
export const FICA_2026 = {
  source: "SSA 2026 wage base (as reported by the Journal of Accountancy, Oct 2025); IRC §3101",
  socialSecurityRate: 6.2,
  socialSecurityWageBase: 184_500,
  medicareRate: 1.45,
  additionalMedicareRate: 0.9,
  additionalMedicareThreshold: { single: 200_000, married_joint: 250_000, head_of_household: 200_000, married_separate: 125_000 },
} as const;

/**
 * State income tax, 2026, from the Tax Foundation's "State Individual Income
 * Tax Rates and Brackets, 2026" (built from state statutes and forms).
 * std/exemption pairs are [single, married]; exemption has a third value per
 * dependent. *Credit variants are taken off the tax instead of the income.
 * Washington's 7%/9% tax is on capital gains only, so wages show none.
 */
export interface StateTax {
  name: string;
  single: Brackets;
  married: Brackets;
  std: readonly [number, number];
  stdCredit: readonly [number, number];
  exemption: readonly [number, number, number];
  exemptionCredit: readonly [number, number, number];
}

export const STATES_2026 = {
  AL: { name: "Alabama", single: [[2.0, 0], [4.0, 500], [5.0, 3000]], married: [[2.0, 0], [4.0, 1000], [5.0, 6000]], std: [3000, 8500], stdCredit: [0, 0], exemption: [1500, 3000, 1000], exemptionCredit: [0, 0, 0] },
  AK: { name: "Alaska", single: [], married: [], std: [0, 0], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  AZ: { name: "Arizona", single: [[2.5, 0]], married: [[2.5, 0]], std: [8350, 16700], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 100] },
  AR: { name: "Arkansas", single: [[2.0, 0], [3.9, 4600]], married: [[2.0, 0], [3.9, 4600]], std: [2470, 4940], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [29, 58, 29] },
  CA: { name: "California", single: [[1.0, 0], [2.0, 11079], [4.0, 26264], [6.0, 41452], [8.0, 57542], [9.3, 72724], [10.3, 371479], [11.3, 445771], [12.3, 742953], [13.3, 1000000]], married: [[1.0, 0], [2.0, 22158], [4.0, 52528], [6.0, 82904], [8.0, 115084], [9.3, 145448], [10.3, 742958], [11.3, 891542], [12.3, 1000000], [13.3, 1485906]], std: [5540, 11080], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [153, 306, 153] },
  CO: { name: "Colorado", single: [[4.4, 0]], married: [[4.4, 0]], std: [16100, 32200], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  CT: { name: "Connecticut", single: [[2.0, 0], [4.5, 10000], [5.5, 50000], [6.0, 100000], [6.5, 200000], [6.9, 250000], [6.99, 500000]], married: [[2.0, 0], [4.5, 20000], [5.5, 100000], [6.0, 200000], [6.5, 400000], [6.9, 500000], [6.99, 1000000]], std: [0, 0], stdCredit: [0, 0], exemption: [15000, 24000, 0], exemptionCredit: [0, 0, 0] },
  DE: { name: "Delaware", single: [[2.2, 2000], [3.9, 5000], [4.8, 10000], [5.2, 20000], [5.55, 25000], [6.6, 60000]], married: [[2.2, 2000], [3.9, 5000], [4.8, 10000], [5.2, 20000], [5.55, 25000], [6.6, 60000]], std: [3250, 6500], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [110, 220, 110] },
  FL: { name: "Florida", single: [], married: [], std: [0, 0], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  GA: { name: "Georgia", single: [[5.19, 0]], married: [[5.19, 0]], std: [12000, 24000], stdCredit: [0, 0], exemption: [0, 0, 4000], exemptionCredit: [0, 0, 0] },
  HI: { name: "Hawaii", single: [[1.4, 0], [3.2, 9600], [5.5, 14400], [6.4, 19200], [6.8, 24000], [7.2, 36000], [7.6, 48000], [7.9, 125000], [8.25, 175000], [9.0, 225000], [10.0, 275000], [11.0, 325000]], married: [[1.4, 0], [3.2, 19200], [5.5, 28800], [6.4, 38400], [6.8, 48000], [7.2, 72000], [7.6, 96000], [7.9, 250000], [8.25, 350000], [9.0, 450000], [10.0, 550000], [11.0, 650000]], std: [4400, 8800], stdCredit: [0, 0], exemption: [1144, 2288, 1144], exemptionCredit: [0, 0, 0] },
  ID: { name: "Idaho", single: [[5.3, 4811]], married: [[5.3, 9622]], std: [16100, 32200], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  IL: { name: "Illinois", single: [[4.95, 0]], married: [[4.95, 0]], std: [0, 0], stdCredit: [0, 0], exemption: [2925, 5850, 2925], exemptionCredit: [0, 0, 0] },
  IN: { name: "Indiana", single: [[2.95, 0]], married: [[2.95, 0]], std: [0, 0], stdCredit: [0, 0], exemption: [1000, 2000, 1000], exemptionCredit: [0, 0, 0] },
  IA: { name: "Iowa", single: [[3.8, 0]], married: [[3.8, 0]], std: [16100, 32200], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [40, 80, 40] },
  KS: { name: "Kansas", single: [[5.2, 0], [5.58, 23000]], married: [[5.2, 0], [5.58, 46000]], std: [3605, 8240], stdCredit: [0, 0], exemption: [9160, 18320, 2320], exemptionCredit: [0, 0, 0] },
  KY: { name: "Kentucky", single: [[3.5, 0]], married: [[3.5, 0]], std: [3360, 3360], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  LA: { name: "Louisiana", single: [[3.0, 0]], married: [[3.0, 0]], std: [12875, 25750], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  ME: { name: "Maine", single: [[5.8, 0], [6.75, 27399], [7.15, 64849]], married: [[5.8, 0], [6.75, 54849], [7.15, 129749]], std: [8350, 16700], stdCredit: [0, 0], exemption: [5300, 10600, 0], exemptionCredit: [0, 0, 305] },
  MD: { name: "Maryland", single: [[2.0, 0], [3.0, 1000], [4.0, 2000], [4.75, 3000], [5.0, 100000], [5.25, 125000], [5.5, 150000], [5.75, 250000], [6.25, 500000], [6.5, 1000000]], married: [[2.0, 0], [3.0, 1000], [4.0, 2000], [4.75, 3000], [5.0, 150000], [5.25, 175000], [5.5, 225000], [5.75, 300000], [6.25, 600000], [6.5, 1200000]], std: [3350, 6700], stdCredit: [0, 0], exemption: [3200, 6400, 3200], exemptionCredit: [0, 0, 0] },
  MA: { name: "Massachusetts", single: [[5.0, 0], [9.0, 1083150]], married: [[5.0, 0], [9.0, 1083150]], std: [0, 0], stdCredit: [0, 0], exemption: [4400, 8800, 1000], exemptionCredit: [0, 0, 0] },
  MI: { name: "Michigan", single: [[4.25, 0]], married: [[4.25, 0]], std: [0, 0], stdCredit: [0, 0], exemption: [5900, 11800, 5900], exemptionCredit: [0, 0, 0] },
  MN: { name: "Minnesota", single: [[5.35, 0], [6.8, 33310], [7.85, 109430], [9.85, 203150]], married: [[5.35, 0], [6.8, 48700], [7.85, 193480], [9.85, 337930]], std: [15300, 30600], stdCredit: [0, 0], exemption: [0, 0, 5300], exemptionCredit: [0, 0, 0] },
  MS: { name: "Mississippi", single: [[4.0, 10000]], married: [[4.0, 10000]], std: [2300, 4600], stdCredit: [0, 0], exemption: [6000, 12000, 1500], exemptionCredit: [0, 0, 0] },
  MO: { name: "Missouri", single: [[2.0, 1348], [2.5, 2696], [3.0, 4044], [3.5, 5392], [4.0, 6740], [4.5, 8088], [4.7, 9436]], married: [[2.0, 1348], [2.5, 2696], [3.0, 4044], [3.5, 5392], [4.0, 6740], [4.5, 8088], [4.7, 9436]], std: [16100, 32200], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  MT: { name: "Montana", single: [[4.7, 0], [5.65, 47500]], married: [[4.7, 0], [5.65, 95000]], std: [16100, 32200], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  NE: { name: "Nebraska", single: [[2.46, 0], [3.51, 4130], [4.55, 24760]], married: [[2.46, 0], [3.51, 8250], [4.55, 49530]], std: [8850, 17700], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [176, 352, 176] },
  NV: { name: "Nevada", single: [], married: [], std: [0, 0], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  NH: { name: "New Hampshire", single: [], married: [], std: [0, 0], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  NJ: { name: "New Jersey", single: [[1.4, 0], [1.75, 20000], [3.5, 35000], [5.525, 40000], [6.37, 75000], [8.97, 500000], [10.75, 1000000]], married: [[1.4, 0], [1.75, 20000], [3.5, 50000], [5.525, 70000], [6.37, 80000], [8.97, 150000], [10.75, 500000]], std: [0, 0], stdCredit: [0, 0], exemption: [1000, 2000, 1500], exemptionCredit: [0, 0, 0] },
  NM: { name: "New Mexico", single: [[1.5, 0], [3.2, 5500], [4.3, 16500], [4.7, 33500], [4.9, 66500], [5.9, 210000]], married: [[1.5, 0], [3.2, 8000], [4.3, 25000], [4.7, 50000], [4.9, 100000], [5.9, 315000]], std: [16100, 32200], stdCredit: [0, 0], exemption: [0, 0, 4000], exemptionCredit: [0, 0, 0] },
  NY: { name: "New York", single: [[3.9, 0], [4.4, 8500], [5.15, 11700], [5.4, 13900], [5.9, 80650], [6.85, 215400], [9.65, 1077550], [10.3, 5000000], [10.9, 25000000]], married: [[3.9, 0], [4.4, 17150], [5.15, 23600], [5.4, 27900], [5.9, 161550], [6.85, 323200], [9.65, 2155350], [10.3, 5000000], [10.9, 25000000]], std: [8000, 16050], stdCredit: [0, 0], exemption: [0, 0, 1000], exemptionCredit: [0, 0, 0] },
  NC: { name: "North Carolina", single: [[3.99, 0]], married: [[3.99, 0]], std: [12750, 25500], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  ND: { name: "North Dakota", single: [[1.95, 48475], [2.5, 244825]], married: [[1.95, 80975], [2.5, 298075]], std: [16100, 32200], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  OH: { name: "Ohio", single: [[2.75, 26050]], married: [[2.75, 26050]], std: [0, 0], stdCredit: [0, 0], exemption: [2400, 4800, 2400], exemptionCredit: [0, 0, 0] },
  OK: { name: "Oklahoma", single: [[2.5, 3750], [3.5, 4900], [4.5, 7200]], married: [[2.5, 7500], [3.5, 9800], [4.5, 14400]], std: [6350, 12700], stdCredit: [0, 0], exemption: [1000, 2000, 1000], exemptionCredit: [0, 0, 0] },
  OR: { name: "Oregon", single: [[4.75, 0], [6.75, 4550], [8.75, 11400], [9.9, 125000]], married: [[4.75, 0], [6.75, 9100], [8.75, 22800], [9.9, 250000]], std: [2910, 5820], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [256, 512, 256] },
  PA: { name: "Pennsylvania", single: [[3.07, 0]], married: [[3.07, 0]], std: [0, 0], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  RI: { name: "Rhode Island", single: [[3.75, 0], [4.75, 82050], [5.99, 186450]], married: [[3.75, 0], [4.75, 82050], [5.99, 186450]], std: [11200, 22400], stdCredit: [0, 0], exemption: [5250, 10500, 5250], exemptionCredit: [0, 0, 0] },
  SC: { name: "South Carolina", single: [[0.0, 0], [3.0, 3640], [6.0, 18230]], married: [[0.0, 0], [3.0, 3640], [6.0, 18230]], std: [8350, 16700], stdCredit: [0, 0], exemption: [0, 0, 4930], exemptionCredit: [0, 0, 0] },
  SD: { name: "South Dakota", single: [], married: [], std: [0, 0], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  TN: { name: "Tennessee", single: [], married: [], std: [0, 0], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  TX: { name: "Texas", single: [], married: [], std: [0, 0], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  UT: { name: "Utah", single: [[4.5, 0]], married: [[4.5, 0]], std: [0, 0], stdCredit: [966, 1932], exemption: [0, 0, 2111], exemptionCredit: [0, 0, 0] },
  VT: { name: "Vermont", single: [[3.35, 0], [6.6, 49400], [7.6, 119700], [8.75, 249700]], married: [[3.35, 0], [6.6, 82500], [7.6, 199450], [8.75, 304000]], std: [7650, 15300], stdCredit: [0, 0], exemption: [5300, 10600, 5300], exemptionCredit: [0, 0, 0] },
  VA: { name: "Virginia", single: [[2.0, 0], [3.0, 3000], [5.0, 5000], [5.75, 17000]], married: [[2.0, 0], [3.0, 3000], [5.0, 5000], [5.75, 17000]], std: [8750, 17500], stdCredit: [0, 0], exemption: [930, 1860, 930], exemptionCredit: [0, 0, 0] },
  WA: { name: "Washington", single: [], married: [], std: [0, 0], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  WV: { name: "West Virginia", single: [[2.22, 0], [2.96, 10000], [3.33, 25000], [4.44, 40000], [4.82, 60000]], married: [[2.22, 0], [2.96, 10000], [3.33, 25000], [4.44, 40000], [4.82, 60000]], std: [0, 0], stdCredit: [0, 0], exemption: [2000, 4000, 2000], exemptionCredit: [0, 0, 0] },
  WI: { name: "Wisconsin", single: [[3.5, 0], [4.4, 15110], [5.3, 51950], [7.65, 332720]], married: [[3.5, 0], [4.4, 20150], [5.3, 69260], [7.65, 443630]], std: [13960, 25840], stdCredit: [0, 0], exemption: [700, 1400, 700], exemptionCredit: [0, 0, 0] },
  WY: { name: "Wyoming", single: [], married: [], std: [0, 0], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
  DC: { name: "District of Columbia", single: [[4.0, 0], [6.0, 10000], [6.5, 40000], [8.5, 60000], [9.25, 250000], [9.75, 500000], [10.75, 1000000]], married: [[4.0, 0], [6.0, 10000], [6.5, 40000], [8.5, 60000], [9.25, 250000], [9.75, 500000], [10.75, 1000000]], std: [16100, 32200], stdCredit: [0, 0], exemption: [0, 0, 0], exemptionCredit: [0, 0, 0] },
} as const satisfies Record<string, StateTax>;

export type StateCode = keyof typeof STATES_2026;

/** Pre-tax 401(k)/403(b) contributions still count as state income here. */
export const STATES_TAXING_401K: ReadonlySet<string> = new Set(["PA", "NJ"]);
/** HSA contributions still count as state income here. */
export const STATES_TAXING_HSA: ReadonlySet<string> = new Set(["CA", "NJ"]);

/** Employee-paid state payroll programs (disability / paid family leave), where the rate is confirmed. */
export const STATE_PAYROLL_2026: Record<string, ReadonlyArray<{ id: string; label: string; ratePct: number; capCents?: number; wageBaseCents?: number; source: string }>> = {
  CA: [{ id: "ca_sdi", label: "CA SDI (disability + family leave)", ratePct: 1.3, source: "CA EDD, 2026 rates (no wage cap since 2024)" }],
  NY: [
    { id: "ny_pfl", label: "NY Paid Family Leave", ratePct: 0.432, capCents: 41_191, source: "NY Paid Family Leave, 2026 rates" },
    { id: "ny_dbl", label: "NY disability (DBL)", ratePct: 0.5, capCents: 3_120, source: "NY Workers' Comp. Law §209 ($0.60/week max)" },
  ],
  CT: [{ id: "ct_pfml", label: "CT Paid Leave", ratePct: 0.5, wageBaseCents: 18_450_000, source: "CT Paid Leave Authority (0.5% up to the SS wage base)" }],
};
/** States with a paid-leave/disability payroll deduction whose 2026 employee rate we couldn't confirm. */
export const STATE_PAYROLL_UNCONFIRMED: ReadonlySet<string> = new Set(["NJ", "WA", "MA", "RI", "OR", "CO", "DE", "MN", "ME", "HI"]);

/**
 * Local income taxes. kind:
 *   wages    — % of wages (city wage / earnings / occupational taxes)
 *   stateTaxable — % (or brackets) of the state's taxable income
 *   stateTax — % of the state income tax (Yonkers surcharge)
 *   over     — % of state taxable income above a threshold [single, joint]
 */
export type Locality =
  | { id: string; state: string; name: string; kind: "wages"; ratePct: number; verified: boolean; source: string }
  | { id: string; state: string; name: string; kind: "stateTaxable"; ratePct?: number; single?: Brackets; married?: Brackets; verified: boolean; source: string }
  | { id: string; state: string; name: string; kind: "stateTax"; ratePct: number; verified: boolean; source: string }
  | { id: string; state: string; name: string; kind: "over"; tiers: ReadonlyArray<{ ratePct: number; over: readonly [number, number] }>; verified: boolean; source: string };

const MD = "Comptroller of Maryland, 2026 withholding information (local rates)";
const md = (id: string, name: string, ratePct: number): Locality => ({ id: `md_${id}`, state: "MD", name, kind: "stateTaxable", ratePct, verified: true, source: MD });
const SECONDARY = "Consistent secondary sources (city/county revenue office not checked)";

export const LOCALITIES_2026: ReadonlyArray<Locality> = [
  { id: "nyc", state: "NY", name: "New York City", kind: "stateTaxable", verified: false, source: SECONDARY,
    single: [[3.078, 0], [3.762, 12_000], [3.819, 25_000], [3.876, 50_000]],
    married: [[3.078, 0], [3.762, 21_600], [3.819, 45_000], [3.876, 90_000]] },
  { id: "yonkers", state: "NY", name: "Yonkers", kind: "stateTax", ratePct: 16.75, verified: false, source: SECONDARY },
  { id: "philadelphia", state: "PA", name: "Philadelphia", kind: "wages", ratePct: 3.74, verified: true, source: "City of Philadelphia (3.74% from July 2025, 3.735% from July 2026)" },
  { id: "pittsburgh", state: "PA", name: "Pittsburgh", kind: "wages", ratePct: 3.0, verified: false, source: SECONDARY },
  { id: "detroit", state: "MI", name: "Detroit", kind: "wages", ratePct: 2.4, verified: false, source: SECONDARY },
  { id: "grand_rapids", state: "MI", name: "Grand Rapids", kind: "wages", ratePct: 1.5, verified: false, source: SECONDARY },
  { id: "columbus", state: "OH", name: "Columbus", kind: "wages", ratePct: 2.5, verified: false, source: SECONDARY },
  { id: "cleveland", state: "OH", name: "Cleveland", kind: "wages", ratePct: 2.5, verified: false, source: SECONDARY },
  { id: "cincinnati", state: "OH", name: "Cincinnati", kind: "wages", ratePct: 1.8, verified: false, source: SECONDARY },
  { id: "toledo", state: "OH", name: "Toledo", kind: "wages", ratePct: 2.25, verified: false, source: SECONDARY },
  { id: "akron", state: "OH", name: "Akron", kind: "wages", ratePct: 2.5, verified: false, source: SECONDARY },
  { id: "dayton", state: "OH", name: "Dayton", kind: "wages", ratePct: 2.5, verified: false, source: SECONDARY },
  { id: "louisville", state: "KY", name: "Louisville", kind: "wages", ratePct: 2.2, verified: false, source: SECONDARY },
  { id: "lexington", state: "KY", name: "Lexington", kind: "wages", ratePct: 2.25, verified: false, source: SECONDARY },
  { id: "kansas_city", state: "MO", name: "Kansas City", kind: "wages", ratePct: 1.0, verified: false, source: SECONDARY },
  { id: "st_louis", state: "MO", name: "St. Louis", kind: "wages", ratePct: 1.0, verified: false, source: SECONDARY },
  { id: "wilmington", state: "DE", name: "Wilmington", kind: "wages", ratePct: 1.25, verified: false, source: SECONDARY },
  { id: "birmingham", state: "AL", name: "Birmingham", kind: "wages", ratePct: 1.0, verified: false, source: SECONDARY },
  { id: "portland_multnomah", state: "OR", name: "Portland / Multnomah County", kind: "over", verified: false,
    source: "Multnomah County PFA ordinance (2026 increase delayed to 2027); Metro SHS from secondary sources",
    tiers: [
      { ratePct: 1.0, over: [125_000, 200_000] },
      { ratePct: 1.5, over: [125_000, 200_000] },
      { ratePct: 1.5, over: [250_000, 400_000] },
    ] },
  { id: "portland_metro", state: "OR", name: "Metro area (Washington / Clackamas County)", kind: "over", verified: false, source: SECONDARY,
    tiers: [{ ratePct: 1.0, over: [125_000, 200_000] }] },
  { id: "in_marion", state: "IN", name: "Marion County (Indianapolis)", kind: "stateTaxable", ratePct: 2.02, verified: false, source: SECONDARY },
  { id: "in_allen", state: "IN", name: "Allen County (Fort Wayne)", kind: "stateTaxable", ratePct: 1.59, verified: false, source: SECONDARY },
  { id: "in_lake", state: "IN", name: "Lake County", kind: "stateTaxable", ratePct: 1.5, verified: false, source: SECONDARY },
  { id: "in_hamilton", state: "IN", name: "Hamilton County", kind: "stateTaxable", ratePct: 1.1, verified: false, source: SECONDARY },
  md("allegany", "Allegany County", 3.2),
  { id: "md_anne_arundel", state: "MD", name: "Anne Arundel County", kind: "stateTaxable", verified: true, source: MD,
    single: [[2.7, 0], [2.94, 50_000], [3.2, 400_000]], married: [[2.7, 0], [2.94, 75_000], [3.2, 480_000]] },
  md("baltimore_county", "Baltimore County", 3.2),
  md("baltimore_city", "Baltimore City", 3.2),
  md("calvert", "Calvert County", 3.2),
  md("caroline", "Caroline County", 3.2),
  md("carroll", "Carroll County", 3.03),
  md("cecil", "Cecil County", 2.74),
  md("charles", "Charles County", 3.03),
  md("dorchester", "Dorchester County", 3.3),
  { id: "md_frederick", state: "MD", name: "Frederick County", kind: "stateTaxable", verified: true, source: MD,
    single: [[2.25, 0], [2.75, 25_000], [2.96, 50_000], [3.2, 150_000]], married: [[2.25, 0], [2.75, 25_000], [2.96, 100_000], [3.2, 250_000]] },
  md("garrett", "Garrett County", 2.65),
  md("harford", "Harford County", 3.06),
  md("howard", "Howard County", 3.2),
  md("kent", "Kent County", 3.3),
  md("montgomery", "Montgomery County", 3.2),
  md("prince_georges", "Prince George's County", 3.2),
  md("queen_annes", "Queen Anne's County", 3.2),
  md("st_marys", "St. Mary's County", 3.2),
  md("somerset", "Somerset County", 3.2),
  md("talbot", "Talbot County", 2.4),
  md("washington", "Washington County", 2.95),
  md("wicomico", "Wicomico County", 3.2),
  md("worcester", "Worcester County", 2.25),
];
