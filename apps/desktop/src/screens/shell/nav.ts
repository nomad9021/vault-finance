import type { IconName } from "@vault/ui";

/**
 * The navigation model — one structure, three renderings.
 *
 * This is the spine of the redesign. Rather than a flat list of destinations,
 * pages belong to a *group* that answers a question:
 *
 *   Home   — how am I doing?
 *   Money  — what actually happened?
 *   Plan   — what should happen?
 *   Grow   — where am I heading?
 *   More   — everything else
 *
 * At wide widths the groups become labelled sidebar sections. At narrow widths
 * (and on the phone viewer) the groups become the five bottom tabs and their
 * pages become a tab strip at the top of the screen. Same hierarchy, so a
 * resized window walks continuously from desktop to phone and nobody has to
 * relearn where anything lives.
 */

export type PageId =
  | "dashboard"
  | "accounts"
  | "transactions"
  | "income"
  | "budgets"
  | "bills"
  | "cashflow"
  | "investments"
  | "goals"
  | "reports"
  | "assistant"
  | "settings";

export type GroupId = "home" | "money" | "plan" | "grow" | "more";

export interface NavPage {
  id: PageId;
  label: string;
  icon: IconName;
  /** Longer title used in the page header and command palette. */
  title: string;
  /** Extra search terms — old names, sub-tabs, synonyms. */
  keywords?: string;
  /** Only shown once the assistant is enabled and configured. */
  ai?: boolean;
}

export interface NavGroup {
  id: GroupId;
  label: string;
  icon: IconName;
  pages: NavPage[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "home",
    label: "Home",
    icon: "home",
    pages: [
      {
        id: "dashboard",
        label: "Dashboard",
        icon: "home",
        title: "Dashboard",
        keywords: "overview home summary net worth",
      },
    ],
  },
  {
    id: "money",
    label: "Money",
    icon: "wallet",
    pages: [
      {
        id: "accounts",
        label: "Accounts",
        icon: "bank",
        title: "Accounts",
        keywords: "balances checking savings credit card loan net worth",
      },
      {
        id: "transactions",
        label: "Transactions",
        icon: "card",
        title: "Transactions",
        keywords: "spending ledger merchants categorize import",
      },
      {
        id: "income",
        label: "Income",
        icon: "income",
        title: "Income",
        keywords: "paycheck salary earnings deposits",
      },
    ],
  },
  {
    id: "plan",
    label: "Plan",
    icon: "target",
    pages: [
      {
        id: "budgets",
        label: "Budgets",
        icon: "target",
        title: "Budgets",
        // The old standalone "Budget Planner" page is a tab in here now.
        keywords: "budget planner allocate categories monthly limits envelope",
      },
      {
        id: "bills",
        label: "Bills",
        icon: "receipt",
        title: "Bills",
        keywords: "recurring due subscriptions payments",
      },
      {
        id: "cashflow",
        label: "Cash Flow",
        icon: "flow",
        title: "Cash Flow",
        // The debt payoff planner moved here from Savings Goals.
        keywords: "income vs spending trends debt payoff snowball avalanche",
      },
    ],
  },
  {
    id: "grow",
    label: "Grow",
    icon: "trendUp",
    pages: [
      {
        id: "goals",
        label: "Savings Goals",
        icon: "flag",
        title: "Savings Goals",
        keywords: "targets saving emergency fund",
      },
      {
        id: "investments",
        label: "Investments",
        icon: "invest",
        title: "Investments",
        keywords: "portfolio holdings stocks allocation returns",
      },
    ],
  },
  {
    id: "more",
    label: "More",
    icon: "more",
    pages: [
      {
        id: "reports",
        label: "Reports",
        icon: "report",
        title: "Reports",
        keywords: "export csv spending by category year",
      },
      {
        id: "assistant",
        label: "AI Assistant",
        icon: "sparkle",
        title: "AI Assistant",
        keywords: "ask chat explain summarize",
        ai: true,
      },
      {
        id: "settings",
        label: "Settings",
        icon: "settings",
        title: "Settings",
        keywords: "preferences theme security 2fa account bank ai categories",
      },
    ],
  },
];

/** Flat page list, in group order. */
export const NAV_PAGES: NavPage[] = NAV_GROUPS.flatMap((g) => g.pages);

const PAGE_BY_ID = new Map(NAV_PAGES.map((p) => [p.id, p]));
const GROUP_BY_PAGE = new Map<PageId, GroupId>(
  NAV_GROUPS.flatMap((g) => g.pages.map((p) => [p.id, g.id] as const)),
);

export function pageMeta(id: PageId): NavPage {
  // Every PageId is in NAV_GROUPS by construction; the fallback keeps the
  // return type honest without forcing callers to handle undefined.
  return PAGE_BY_ID.get(id) ?? NAV_PAGES[0]!;
}

export function groupOf(id: PageId): GroupId {
  return GROUP_BY_PAGE.get(id) ?? "home";
}

export function groupMeta(id: GroupId): NavGroup {
  return NAV_GROUPS.find((g) => g.id === id) ?? NAV_GROUPS[0]!;
}

/** Pages of a group, minus anything gated off (the assistant when disabled). */
export function visiblePages(group: NavGroup, aiVisible: boolean): NavPage[] {
  return group.pages.filter((p) => !p.ai || aiVisible);
}

/**
 * Optional pre-applied filter carried by a cross-page navigation — e.g. click
 * a category or account anywhere and land on Transactions already filtered.
 * `tab` selects a sub-view within the destination page (Budgets → planner,
 * Cash Flow → debt).
 */
export type NavFilter = { categoryId?: string; accountId?: string; tab?: string };
export type Navigate = (target: PageId, filter?: NavFilter) => void;
