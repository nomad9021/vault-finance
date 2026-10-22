import { LOCALITIES_2026 } from "@vault/shared";

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
  /** Worked examples: what a request should turn into. Small models follow these best. */
  examples?: string[];
}

const STATE_NAMES =
  "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|nyc|philly|philadelphia|detroit|portland|baltimore";

// Every city/county the tax engine knows (Grand Rapids, Montgomery County…).
const PLACE_NAMES = LOCALITIES_2026.map((l) => l.name.toLowerCase().replace(/ county.*$| \(.*\)$/, "").replace(/[^a-z' ]/g, "").trim())
  .filter((n) => n.length > 3)
  .join("|");

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
      "    (leave out from to move ALL of that merchant's transactions — what \"move all my X\" means)",
      "  reorder_categories {parent: name or null for top level, order: [sibling names, first = top]}",
      "  autocategorize {}   (applies the rules to uncategorized transactions)",
    ],
    queries: [
      '  transactions {merchant?, category?: name or "Uncategorized", days?: last N days, from?, to?: "YYYY-MM-DD", limit?: up to 100}',
      "    (starts with the exact TOTAL for everything that matches — use it for \"how much did I spend at X\")",
      "  merchants {days? or months?: last N, uncategorizedOnly?: bool}   (who they pay, how often, which category)",
      "  category_totals {days? or months?: last N}   (spending and income per category; months counts back from today)",
    ],
    examples: [
      '  "Move all my Amazon purchases to Shopping" → <vault-action>{"type":"recategorize","merchant":"amazon","category":"Shopping"}</vault-action>',
      '  "Always put Shell charges in Transport" → <vault-action>{"type":"create_rule","keyword":"shell","category":"Transport"}</vault-action>',
      '    plus <vault-action>{"type":"recategorize","merchant":"shell","category":"Transport"}</vault-action> for the ones already there',
      '  "Make Groceries green" → <vault-action>{"type":"recolor_category","category":"Groceries","color":"#2e9d5b"}</vault-action>',
      '  "Put Coffee Shops under Dining Out" (two categories) → <vault-action>{"type":"move_category","category":"Coffee Shops","newParent":"Dining Out"}</vault-action>',
      '  "Add a Kids category with School and Activities in it" → create_category Kids, then School and Activities with "parent":"Kids"',
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
    keywords: /budg|buj|budj|bugdet|sankey|spend|overspen|limit|allocat|planned income|plan my|save money|afford|envelope/i,
    actions: [
      "  set_budget {category, amount: monthly dollars}   remove_budget {category}",
      "  set_planned_income {amount: monthly dollars}   (skip if the tax profile keeps it in sync)",
    ],
    queries: ["  budgets {}   (this month's budgets vs. spending)", "  category_totals {days? or months?: last N}"],
    tips: [
      "Base budgets on the last few months' category totals, rounded; leave room for savings.",
      "\"Budget Sankey like the actual one\" = set_budget for each spending category from its",
      "category_totals monthly average (and set_planned_income if there's no tax profile).",
    ],
    examples: ['  "Set my grocery budget to $500" → <vault-action>{"type":"set_budget","category":"Groceries","amount":500}</vault-action>'],
  },
  {
    id: "tax",
    name: "Tax & salary",
    keywords: new RegExp(
      `tax|salary|salaries|gross|take.?home|paycheck|pay ?stub|deduct|before income|pre.?income|raise|wage|401\\s?k|403\\s?b|hsa|withh?old|bracket|filing|irs|move to|moving|relocat|cost of living|\\bstate\\b|city|county|w-?2|make in|earn in|${STATE_NAMES}|${PLACE_NAMES}`,
      "i",
    ),
    actions: [
      '  set_tax_profile {filingStatus?: "single"|"married_joint"|"married_separate"|"head_of_household",',
      "    state?: two-letter code, locality?: id from tax_places or null, customLocalRatePct?,",
      "    dependents?: children under 17, syncPlannedIncome?: bool}",
      '  set_salary {earner: name, grossAnnual: dollars before tax, payFrequency?: "weekly"|"biweekly"|"semimonthly"|"monthly"}',
      "  set_pretax {earner, retirementPct?: % of pay to 401(k), hsaAnnual?, healthPremiumsAnnual?, otherPretaxAnnual?}",
      "  remove_earner {earner}",
      '  set_pre_income_item {name, amount: monthly dollars, kind?: "tax"|"pretax"|"deduction"}',
      "    (adds a before-income item to both Sankeys, or changes the one with that name)",
      "  remove_pre_income_item {name}",
      "  set_pre_income_estimate {use: bool}   (false = draw only the user's own items, not the estimate)",
    ],
    queries: [
      "  tax_estimate {}   (the saved profile: take-home, every tax line, rates)",
      "  tax_whatif {state?, locality?, filingStatus?, dependents?, earner?, grossAnnual?, retirementPct?}",
      "    (the saved profile with those changed; nothing is saved)",
      "  tax_compare {states: [two-letter codes]}   (take-home in each state, same pay)",
      "  tax_places {state}   (local tax ids for that state)",
      "  pre_income {}   (the before-income items on the Sankeys)",
    ],
    tips: [
      "Estimates cover 2026 federal tax, Social Security/Medicare, every state and main local taxes;",
      "say they're estimates. Use look-ups for numbers — never work tax out yourself.",
      "Taxes on the Sankeys come from the tax profile and the before-income items, NOT from a",
      "category: with either, both Sankeys start from gross pay with the taxes and deductions",
      "branching off before income, and the Taxes page has its own tax Sankey. Never create a",
      "\"Taxes\" category for this. If the user gives a salary and a place, propose",
      "set_tax_profile (state, locality id from tax_places, filingStatus if known, else single)",
      "and set_salary straight away — earner name \"Me\" unless they say otherwise.",
      "Before-income items are the user's own figures (from a pay stub) drawn between gross pay",
      "and income on both Sankeys: actual withholding, insurance, 401(k), union dues. Use them",
      "when the user gives real amounts or has no tax profile; amounts are monthly (biweekly",
      "paycheck × 26 ÷ 12). If their items are the real taxes, also set_pre_income_estimate",
      "use false so taxes aren't counted twice.",
    ],
    examples: [
      '  "Take $480 federal and $210 state out before income on my Sankey" →',
      '    <vault-action>{"type":"set_pre_income_item","name":"Federal tax","amount":480,"kind":"tax"}</vault-action>',
      '    <vault-action>{"type":"set_pre_income_item","name":"State tax","amount":210,"kind":"tax"}</vault-action>',
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
    examples: ['  "Add my rent as a bill: $1,450 due on the 1st" → <vault-action>{"type":"create_bill","name":"Rent","amount":1450,"dueDay":1}</vault-action>'],
    tips: [
      "Turn detected subscriptions and regular payments into bills so they show on the calendar and Sankey.",
      "Name a bill the way the user does (\"Rent\", \"Car insurance\"), not by the merchant.",
    ],
  },
  {
    id: "goals",
    name: "Goals",
    keywords: /goal|save for|saving for|emergency fund|vacation|house|down payment|wedding|car|target|bucket|envelope|sinking fund|set aside|earmark/i,
    actions: [
      '  create_goal {name, target: dollars, monthly?, saved?, targetDate?: "YYYY-MM-DD"}',
      "  update_goal {goal: name, target?, monthly?, saved?, targetDate?}   delete_goal {goal}",
      "  create_bucket {account: account name, name, amount?: dollars from Unassigned, target?, goal?: goal name}",
      '  update_bucket {bucket, amount?, target?, newName?}   move_bucket_money {from: bucket or "Unassigned", to, amount}   delete_bucket {bucket}',
      "  (buckets split a savings account's real balance into parts; they never move real money)",
    ],
    queries: ["  goals {}", "  buckets {}   (savings accounts split into buckets, and what's unassigned)"],
    examples: ['  "I want to save $6,000 for a vacation by next June" → <vault-action>{"type":"create_goal","name":"Vacation","target":6000,"targetDate":"<next June 30, YYYY-MM-DD>"}</vault-action>'],
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
      '  transactions {merchant?, category?, days?: last N days}   (exact TOTAL first — use it for any "how much")',
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

/**
 * How the assistant talks, and the hard edge of what it can do. Sent with
 * every message whichever agents are active, so a request for something
 * impossible gets a flat "can't" instead of a guess or a fake workaround.
 */
export const STYLE_AND_LIMITS = [
  "=== HOW TO ANSWER ===",
  "Neutral, direct and to the point. Lead with the answer, the number or the change.",
  "One to three short sentences unless the user asks for detail or a breakdown.",
  "No greetings, praise, pep talk, filler, emojis or exclamation marks. Don't apologize,",
  "don't compliment the question, don't repeat it back, don't end with an offer of more help.",
  "State facts without judging the user's choices. Recommend only when asked, or when the",
  "numbers show a clear problem — then in one sentence.",
  "If the data isn't there, say \"I don't have that\" and what would provide it. Never guess.",
  "",
  "=== WHAT YOU CAN AND CAN'T DO ===",
  "You CAN, through the changes and look-ups below (the user approves each change):",
  "  categories (tree, order, colours), auto-categorization rules, moving transactions",
  "  between categories, budgets and planned income, the tax profile, salaries and pre-tax",
  "  deductions, before-income items on the Sankeys, bills, savings goals and buckets,",
  "  giving funds, the debt payoff plan, theme, finance-review settings, the household name;",
  "  and look up transactions, merchants, totals, cash flow, accounts, bills, goals, debts",
  "  and tax estimates.",
  "Creating new things — categories and sub-categories, budgets, rules, bills, goals,",
  "buckets, funds — is always allowed: never refuse it. Say \"can't\" ONLY for this list.",
  "You CAN'T do the following. If asked, say so in the first sentence (\"I can't do that.\"),",
  "then say in one sentence where the user does it, if anywhere. Never offer a workaround",
  "that only looks like it does the job, and never claim you did something you can't do:",
  "  - Move, send, transfer or pay real money, or pay a bill. Vault only tracks money; that",
  "    happens at the bank. (Buckets only label parts of a balance.)",
  "  - Add, edit or delete a transaction, or change its amount, date or merchant: the",
  "    Transactions page. (You can only change categories.)",
  "  - Connect, reconnect, refresh or remove a bank: Settings → Money → Connected banks.",
  "  - Passwords, two-factor, devices, sign-ins, auto-lock: Settings → Security.",
  "  - Members and invitations: Settings → Members (owner only).",
  "  - AI provider and model settings: Settings → AI. Server updates and status:",
  "    Settings → Server & admin (owner only).",
  "  - Anything outside this app: the internet, live prices or rates, credit scores, other",
  "    banks' websites, sending email or messages.",
  "  - File taxes or give official tax, legal or investment advice. Tax figures are estimates",
  "    from the 2026 tables; say that once when you give them.",
  "  - Predict markets or guarantee any outcome.",
  "  - Store passwords, account numbers or card numbers.",
  "If only part of a request is possible, do that part and state the rest is not possible.",
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
