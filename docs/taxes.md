# Salary & taxes

The Taxes page, the budget planner's "start from gross pay" add-on and the
AI's Tax & salary agent all use one estimator:
`packages/shared/src/tax/engine.ts`, fed by `packages/shared/src/tax/data-2026.ts`.

It estimates take-home pay for wage earners: federal income tax (standard
deduction, child tax credit), Social Security and Medicare, state income tax
for all 50 states + DC, the main local income taxes, and the state payroll
programs whose 2026 employee rates are confirmed. It's an estimate: wages
only, standard deduction, no other credits. The app says so.

**Before income.** On the dashboard and budget planner, *Before income* lets
the household enter their own monthly taxes and deductions (from a pay stub:
withholding, insurance, 401(k), union dues). Both Sankeys draw them between
gross pay and income, beside the estimate or — with "Also show the estimated
taxes" off — instead of it. Stored in `budget_plan.pre_income` (`GET/PUT
/pre-income`); the assistant edits them with `set_pre_income_item`,
`remove_pre_income_item` and `set_pre_income_estimate`. They don't change the
take-home estimate itself.

## Sources (2026)

| Data | Source | Confirmed with the authority? |
| --- | --- | --- |
| Federal brackets, standard deduction, child tax credit | IRS Rev. Proc. 2025-32 | yes |
| Social Security wage base $184,500 | SSA 2026 figures as reported (Journal of Accountancy) | secondary |
| State brackets, deductions, exemptions | Tax Foundation, "State Individual Income Tax Rates and Brackets, 2026" (spreadsheet) | compiled from state law |
| Maryland county rates (all 24) | Comptroller of Maryland, 2026 withholding memo | yes |
| Philadelphia wage tax 3.74% | City of Philadelphia | yes |
| CA SDI 1.3%, NY PFL 0.432% (max $411.91) | CA EDD, NY Paid Family Leave | yes |
| NYC, Yonkers, Pittsburgh, Detroit, Grand Rapids, Ohio cities, Louisville, Lexington, Kansas City, St. Louis, Wilmington, Birmingham, Portland area, Indiana counties | consistent secondary sources | no: shown as "check pay stub" |

Not modeled: itemized deductions, other credits (EITC, education…),
state-specific phase-outs and recaptures (the Tax Foundation footnotes),
head-of-household/separate state brackets (single brackets are used), and
the paid-leave payroll rates we couldn't confirm (NJ, WA, MA, RI, OR, CO, DE,
MN, ME, HI). Users can enter those from a pay stub, as can anyone with a local
tax that isn't listed.

## Each year

1. Federal: the IRS Revenue Procedure with next year's inflation adjustments
   (October), plus SSA's wage base (October).
2. States: download the Tax Foundation's new spreadsheet (usually February)
   and regenerate the `STATES_…` table. Washington stays "no wage tax".
3. Locals and payroll programs: check each listed source; move entries to
   `verified: true` only when checked with the city, county or state agency.
4. Update `engine.test.ts` with hand-worked figures from the new tables.
