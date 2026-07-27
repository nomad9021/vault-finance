import { Banner, Button } from "@vault/ui";
import { useState } from "react";
import { useApp } from "../../state/store.js";
import { AppMark } from "../AuthLayout.js";
import { AccountsPage } from "./AccountsPage.js";
import { AssistantPage } from "./AssistantPage.js";
import { BudgetPlannerPage } from "./BudgetPlannerPage.js";
import { BudgetsPage } from "./BudgetsPage.js";
import { CashFlowPage } from "./CashFlowPage.js";
import { DashboardPage } from "./DashboardPage.js";
import { BillsPage } from "./BillsPage.js";
import { GoalsPage } from "./GoalsPage.js";
import { Header } from "./Header.js";
import { IncomePage } from "./IncomePage.js";
import { InvestmentsPage } from "./InvestmentsPage.js";
import { ReportsPage } from "./ReportsPage.js";
import { SettingsPage } from "./SettingsPage.js";
import { TransactionsPage } from "./TransactionsPage.js";

export type PageId =
  | "dashboard"
  | "accounts"
  | "transactions"
  | "income"
  | "budgets"
  | "budget-planner"
  | "bills"
  | "cashflow"
  | "investments"
  | "goals"
  | "reports"
  | "assistant"
  | "settings";

/**
 * Optional pre-applied filter carried by a cross-page navigation — e.g. click a
 * category or account anywhere and land on Transactions already filtered to it.
 */
export type NavFilter = { categoryId?: string; accountId?: string };
export type Navigate = (target: PageId, filter?: NavFilter) => void;

/** `ai: true` items only appear once the assistant is enabled and configured. */
export const NAV_ITEMS: Array<{ id: PageId; label: string; icon: string; ai?: boolean }> = [
  { id: "dashboard", label: "Dashboard", icon: "🏠" },
  { id: "accounts", label: "Accounts", icon: "🏦" },
  { id: "transactions", label: "Transactions", icon: "💳" },
  { id: "income", label: "Income", icon: "💵" },
  { id: "budgets", label: "Budgets", icon: "🎯" },
  { id: "budget-planner", label: "Budget Planner", icon: "🗂️" },
  { id: "bills", label: "Bills", icon: "🧾" },
  { id: "cashflow", label: "Cash Flow", icon: "📈" },
  { id: "investments", label: "Investments", icon: "📊" },
  { id: "goals", label: "Savings Goals", icon: "🚩" },
  { id: "reports", label: "Reports", icon: "📑" },
  { id: "assistant", label: "AI Assistant", icon: "✦", ai: true },
  { id: "settings", label: "Settings", icon: "⚙️" },
];

const SIDEBAR_KEY = "sidebar-open";

const PAGE_TITLES: Record<PageId, string> = {
  dashboard: "Dashboard",
  accounts: "Accounts",
  transactions: "Transactions",
  income: "Income",
  budgets: "Budgets",
  "budget-planner": "Budget Planner",
  bills: "Bills",
  cashflow: "Cash Flow",
  investments: "Investments",
  goals: "Savings Goals",
  reports: "Reports",
  assistant: "AI Assistant",
  settings: "Settings",
};

export function AppShell() {
  const connection = useApp((s) => s.connection);
  const user = useApp((s) => s.user);
  const aiVisible = useApp((s) => s.aiVisible);
  const [page, setPage] = useState<PageId>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggleSidebar = () =>
    setSidebarOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  // Filter carried into Transactions by a cross-page link (Sankey drill-in,
  // account row, category row, stat card…); consumed once on navigate.
  const [txnFilter, setTxnFilter] = useState<NavFilter>({});

  const navigate: Navigate = (target, filter) => {
    setTxnFilter(filter ?? {});
    setPage(target);
  };

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: "var(--color-bg)",
        color: "var(--color-text)",
        fontFamily: "var(--font-body)",
      }}
    >
      <aside
        style={{
          width: sidebarOpen ? 224 : 0,
          flex: "none",
          borderRight: sidebarOpen ? "1px solid var(--color-divider)" : "none",
          overflow: "hidden",
          transition: "width .25s ease",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            width: 224,
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div style={{ padding: "20px 18px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <AppMark size={26} />
              <span
                style={{
                  fontFamily: "var(--font-heading)",
                  fontWeight: 600,
                  fontSize: 17,
                  letterSpacing: "-.01em",
                }}
              >
                Vault Finance
              </span>
            </div>
            <div style={{ fontSize: 11, color: "var(--color-neutral-500)", marginTop: 6 }}>
              Household finance
            </div>
          </div>
          <nav
            style={{
              flex: 1,
              overflow: "auto",
              padding: "6px 10px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {NAV_ITEMS.filter((item) => !item.ai || aiVisible).map((item) => {
              const active = page === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setPage(item.id)}
                  aria-current={active ? "page" : undefined}
                  className="nav-item"
                  data-active={active ? "true" : undefined}
                >
                  <span aria-hidden="true" className="nav-item-icon">
                    {item.icon}
                  </span>
                  <span className="nav-item-label">{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div
            style={{
              padding: "14px 18px",
              borderTop: "1px solid var(--color-divider)",
              fontSize: 11,
              color: "var(--color-neutral-500)",
              lineHeight: 1.6,
              whiteSpace: "nowrap",
            }}
          >
            {user?.displayName}
            <br />
            Self-hosted · v0.1
          </div>
        </div>
      </aside>

      <main
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {connection === "offline" && (
          <Banner tone="warning" action={<ReconnectAction />}>
            Connection to the server lost — reconnecting. Your data is safe on
            the server; nothing is lost.
          </Banner>
        )}
        <Header
          title={PAGE_TITLES[page]}
          onToggleSidebar={toggleSidebar}
          onNavigate={setPage}
        />
        <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
          {page === "dashboard" ? (
            <DashboardPage onNavigate={navigate} />
          ) : page === "accounts" ? (
            <AccountsPage onNavigate={navigate} />
          ) : page === "transactions" ? (
            <TransactionsPage
              key={txnFilter.categoryId ?? txnFilter.accountId ?? "all"}
              {...(txnFilter.categoryId ? { initialCategoryId: txnFilter.categoryId } : {})}
              {...(txnFilter.accountId ? { initialAccountId: txnFilter.accountId } : {})}
            />
          ) : page === "income" ? (
            <IncomePage onNavigate={navigate} />
          ) : page === "budgets" ? (
            <BudgetsPage onNavigate={navigate} />
          ) : page === "budget-planner" ? (
            <BudgetPlannerPage onNavigate={navigate} />
          ) : page === "bills" ? (
            <BillsPage />
          ) : page === "cashflow" ? (
            <CashFlowPage />
          ) : page === "investments" ? (
            <InvestmentsPage onNavigate={navigate} />
          ) : page === "goals" ? (
            <GoalsPage onNavigate={navigate} />
          ) : page === "reports" ? (
            <ReportsPage onNavigate={navigate} />
          ) : page === "assistant" && aiVisible ? (
            <AssistantPage onNavigate={setPage} />
          ) : (
            <SettingsPage />
          )}
        </div>
      </main>
    </div>
  );
}

function ReconnectAction() {
  const routeForServer = useApp((s) => s.routeForServer);
  return (
    <Button variant="ghost" onClick={() => void routeForServer()}>
      Retry now
    </Button>
  );
}
