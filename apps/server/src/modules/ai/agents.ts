/**
 * The assistant's specialist agents. Each one is a set of look-ups and
 * changes for one part of the app, taught to the model in plain text, so
 * every model can use every agent — with or without native tool calling.
 *
 * routeAgents picks the agents a message needs from what the user said
 * (this message and the one before), so a small model gets a short, focused
 * prompt; a request to organize everything turns them all on.
 */

export type AgentId = "organizer" | "budget" | "tax" | "bills" | "goals" | "giving" | "debt" | "insights" | "app";

export interface AgentDef {
  id: AgentId;
  name: string;
  /** What the user says when they want this agent. */
  keywords: RegExp;
  /** Change types and their fields, one per line. */
  actions: string[];
  /** Look-up types and their fields, one per line. */
  queries: string[];
  /** Agent-specific advice. */
  tips?: string[];
}

export const AGENTS: AgentDef[] = [
  {
    id: "organizer",
    name: "Organizer",
    keywords: /categor|organi[sz]e|tidy|clean|sort|tree|sankey|merchant|transaction|rule|uncategori[sz]ed|recategori[sz]e|move .* (to|under)|rename|colou?r/i,
    actions: [
      '  create_category {name, parent?, kind?: "expense"|"income", color?: "#rrggbb"}',
      "  rename_category {category, newName}",
      "  move_category {category, newParent: name or null for top level}",
      '  recolor_category {category, color: "#rrggbb"}',
      "  delete_category {category}   (only works if nothing uses it)",
      "  create_rule {keyword, category}   delete_rule {keyword}",
      '  recategorize {merchant: text in the merchant name, category, from?: category or "Uncategorized", since?: "YYYY-MM-DD"}',
      "  reorder_categories {parent: name or null for top level, order: [sibling names, first = top]}",
      "  autocategorize {}   (applies the rules to uncategorized transactions)",
    ],
    queries: [
      '  transactions {merchant?, category?: name or "Uncategorized", from?, to?: "YYYY-MM-DD", limit?: up to 100}',
      "  merchants {months?: 1-24, uncategorizedOnly?: bool}   (who they pay, how often, which category)",
      "  category_totals {months?: 1-24}   (spending and income per category)",
    ],
    tips: [
      "To organize their finances: look up merchants and category totals first, then propose a tidy",
      "tree, recategorize/rules for the messy merchants, and budgets — in one reply.",
      "The cash-flow and budget Sankeys are drawn from the category tree, its order, budgets and",
      "planned income, so changing those is how you set the Sankeys up.",
    ],
  },
  {
    id: "budget",
    name: "Budget",
    keywords: /budget|spend|overspen|limit|allocat|planned income|plan my|save money|afford|envelope/i,
    actions: [
      "  set_budget {category, amount: monthly dollars}   remove_budget {category}",
      "  set_planned_income {amount: monthly dollars}   (skip if the tax profile keeps it in sync)",
    ],
    queries: ["  budgets {}   (this month's budgets vs. spending)", "  category_totals {months?: 1-24}"],
    tips: ["Base budgets on the last few months' category totals, rounded; leave room for savings."],
  },
  {
    id: "tax",
    name: "Tax & salary",
    keywords: /tax|salary|salaries|gross|take.?home|paycheck|pay stub|raise|wage|401\s?k|403\s?b|hsa|withh?old|bracket|filing|irs|move to|moving|relocat|cost of living|state|city|county|w-?2/i,
    actions: [
      '  set_tax_profile {filingStatus?: "single"|"married_joint"|"married_separate"|"head_of_household",',
      "    state?: two-letter code, locality?: id from tax_places or null, customLocalRatePct?,",
      "    dependents?: children under 17, syncPlannedIncome?: bool}",
      '  set_salary {earner: name, grossAnnual: dollars before tax, payFrequency?: "weekly"|"biweekly"|"semimonthly"|"monthly"}',
      "  set_pretax {earner, retirementPct?: % of pay to 401(k), hsaAnnual?, healthPremiumsAnnual?, otherPretaxAnnual?}",
      "  remove_earner {earner}",
    ],
    queries: [
      "  tax_estimate {}   (the saved profile: take-home, every tax line, rates)",
      "  tax_whatif {state?, locality?, filingStatus?, dependents?, earner?, grossAnnual?, retirementPct?}",
      "    (the saved profile with those changed; nothing is saved)",
      "  tax_compare {states: [two-letter codes]}   (take-home in each state, same pay)",
      "  tax_places {state}   (local tax ids for that state)",
    ],
    tips: [
      "Estimates cover 2026 federal tax, Social Security/Medicare, every state and main local taxes;",
      "say they're estimates. Use look-ups for numbers — never work tax out yourself.",
      "The Taxes page shows a tax Sankey (gross pay → taxes → take-home) from the profile.",
    ],
  },
  {
    id: "bills",
    name: "Bills",
    keywords: /bill|subscription|recurring|due|autopay|netflix|spotify|rent|mortgage|utilit|insurance|phone|internet|cancel/i,
    actions: [
      '  create_bill {name, amount: dollars, dueDay: 1-31, cadence?: "weekly"|"monthly"|"quarterly"|"yearly", autopay?, category?}',
      "  update_bill {bill: name, amount?, dueDay?, cadence?, autopay?}   delete_bill {bill}",
    ],
    queries: ["  bills {}   (saved bills)", "  subscriptions {}   (recurring charges found in transactions)"],
    tips: ["Turn detected subscriptions and regular payments into bills so they show on the calendar and Sankey."],
  },
  {
    id: "goals",
    name: "Goals",
    keywords: /goal|save for|saving for|emergency fund|vacation|house|down payment|wedding|car|target/i,
    actions: [
      '  create_goal {name, target: dollars, monthly?, saved?, targetDate?: "YYYY-MM-DD"}',
      "  update_goal {goal: name, target?, monthly?, saved?, targetDate?}   delete_goal {goal}",
    ],
    queries: ["  goals {}"],
  },
  {
    id: "giving",
    name: "Giving",
    keywords: /giv|charit|donat|tith|gift|christmas|birthday|holiday/i,
    actions: [
      '  create_giving_fund {name, kind?: "giving"|"gift", monthly?, target?, recipient?, occasionDate?: "YYYY-MM-DD"}',
      "  update_giving_fund {fund: name, monthly?, target?, occasionDate?}   delete_giving_fund {fund}",
    ],
    queries: ["  giving {}"],
  },
  {
    id: "debt",
    name: "Debt",
    keywords: /debt|loan|credit card|payoff|pay off|interest|apr|snowball|avalanche|student loan/i,
    actions: ['  set_debt_plan {strategy?: "avalanche"|"snowball", extraMonthly?: dollars}'],
    queries: ["  debts {}   (debts, rates, minimums and the payoff plan)"],
    tips: ["Avalanche (highest rate first) costs least; snowball (smallest balance first) builds momentum."],
  },
  {
    id: "insights",
    name: "Insights",
    keywords: /how am i|doing|net worth|cash ?flow|trend|invest|portfolio|account|balance|report|summar|insight|month|year|compare/i,
    actions: [],
    queries: [
      "  cashflow {months?: 1-24}   (income vs. spending per month)",
      "  accounts {}   (balances, debts, net worth)",
      "  insights {}   (things that need attention)",
    ],
  },
  {
    id: "app",
    name: "App settings",
    keywords: /theme|dark|light|oled|contrast|review|slide|present|weekly review|monthly review/i,
    actions: [
      '  set_theme {theme: "automatic"|"light"|"dark"|"oled"|"contrast"}',
      '  set_review_prefs {defaultPeriod?: "week"|"month", weekStartsOn?: "monday"|"sunday",',
      "    compare?: bool, autoAdvanceSeconds?: number, startFullscreen?: bool,",
      "    showSlides?: [ids], hideSlides?: [ids]}",
      "    slide ids: overview, categories, daily, merchants, largest, budgets, bills, goals, ai",
    ],
    queries: [],
  },
];

const EVERYTHING = /organi[sz]e (my|all|every)|set (everything|it all|me) up|do everything|whole (thing|app)|all (of )?my finances|full (setup|review)|anything/i;
const DEFAULT: AgentId[] = ["organizer", "budget", "insights"];

/** The agents for a message, from it and the user's previous message. */
export function routeAgents(message: string, previous?: string): AgentId[] {
  if (EVERYTHING.test(message)) return AGENTS.map((a) => a.id);
  const picked = AGENTS.filter((a) => a.keywords.test(message)).map((a) => a.id);
  if (picked.length) return picked;
  const earlier = previous ? AGENTS.filter((a) => a.keywords.test(previous)).map((a) => a.id) : [];
  return earlier.length ? earlier : DEFAULT;
}

export function agentNames(ids: AgentId[]): string {
  const names = AGENTS.filter((a) => ids.includes(a.id)).map((a) => a.name);
  return names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join(" and ");
}
