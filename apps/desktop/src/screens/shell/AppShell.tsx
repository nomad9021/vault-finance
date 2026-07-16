import { Banner, Button } from "@vault/ui";
import { useState } from "react";
import { useApp } from "../../state/store.js";
import { AppMark } from "../AuthLayout.js";
import { AccountsPage } from "./AccountsPage.js";
import { AssistantPage } from "./AssistantPage.js";
import { BudgetsPage } from "./BudgetsPage.js";
import { CashFlowPage } from "./CashFlowPage.js";
import { DashboardPage } from "./DashboardPage.js";
import { GoalsPage } from "./GoalsPage.js";
import { Header } from "./Header.js";
import { InvestmentsPage } from "./InvestmentsPage.js";
import { ReportsPage } from "./ReportsPage.js";
import { SettingsPage } from "./SettingsPage.js";
import { TransactionsPage } from "./TransactionsPage.js";

export type PageId =
  | "dashboard"
  | "accounts"
  | "transactions"
  | "budgets"
  | "cashflow"
  | "investments"
  | "goals"
  | "reports"
  | "assistant"
  | "settings";

export const NAV_ITEMS: Array<{ id: PageId; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "accounts", label: "Accounts" },
  { id: "transactions", label: "Transactions" },
  { id: "budgets", label: "Budgets" },
  { id: "cashflow", label: "Cash Flow" },
  { id: "investments", label: "Investments" },
  { id: "goals", label: "Savings Goals" },
  { id: "reports", label: "Reports" },
  { id: "assistant", label: "AI Assistant" },
  { id: "settings", label: "Settings" },
];

const PAGE_TITLES: Record<PageId, string> = {
  dashboard: "Dashboard",
  accounts: "Accounts",
  transactions: "Transactions",
  budgets: "Budgets",
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
  const [page, setPage] = useState<PageId>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Set by Sankey drill-in ("View in Transactions"); consumed once on navigate.
  const [txnCategoryFilter, setTxnCategoryFilter] = useState<string | undefined>();

  const navigate = (target: PageId, categoryId?: string) => {
    setTxnCategoryFilter(categoryId);
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
            {NAV_ITEMS.map((item) => {
              const active = page === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setPage(item.id)}
                  aria-current={active ? "page" : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 12px",
                    border: 0,
                    borderRadius: 8,
                    cursor: "pointer",
                    fontFamily: "var(--font-body)",
                    fontWeight: 500,
                    fontSize: 13.5,
                    background: active
                      ? "color-mix(in srgb, var(--color-accent) 14%, transparent)"
                      : "transparent",
                    color: active ? "var(--color-accent-200)" : "var(--color-text)",
                    transition: "background .15s",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: active
                        ? "var(--color-accent)"
                        : "var(--color-neutral-700)",
                      flex: "none",
                    }}
                  />
                  {item.label}
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
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onNavigate={setPage}
        />
        <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
          {page === "dashboard" ? (
            <DashboardPage onNavigate={navigate} />
          ) : page === "accounts" ? (
            <AccountsPage />
          ) : page === "transactions" ? (
            <TransactionsPage
              key={txnCategoryFilter ?? "all"}
              {...(txnCategoryFilter ? { initialCategoryId: txnCategoryFilter } : {})}
            />
          ) : page === "budgets" ? (
            <BudgetsPage />
          ) : page === "cashflow" ? (
            <CashFlowPage />
          ) : page === "investments" ? (
            <InvestmentsPage onNavigate={navigate} />
          ) : page === "goals" ? (
            <GoalsPage />
          ) : page === "reports" ? (
            <ReportsPage />
          ) : page === "assistant" ? (
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
