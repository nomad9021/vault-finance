import { Banner, Button, CommandPalette, ErrorBoundary, type Command } from "@vault/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLayoutMode } from "../../lib/useLayout.js";
import { useApp } from "../../state/store.js";
import { AccountsPage } from "./AccountsPage.js";
import { AssistantPage } from "./AssistantPage.js";
import { BillsPage } from "./BillsPage.js";
import { BudgetsPage } from "./BudgetsPage.js";
import { CashFlowPage } from "./CashFlowPage.js";
import { DashboardPage } from "./DashboardPage.js";
import { GivingPage } from "./GivingPage.js";
import { GoalsPage } from "./GoalsPage.js";
import { Header } from "./Header.js";
import { IncomePage } from "./IncomePage.js";
import { InsightsPage } from "./InsightsPage.js";
import { InvestmentsPage } from "./InvestmentsPage.js";
import { NetWorthPage } from "./NetWorthPage.js";
import { ReportsPage } from "./ReportsPage.js";
import { SettingsPage } from "./SettingsPage.js";
import { SubscriptionsPage } from "./SubscriptionsPage.js";
import { TransactionsPage } from "./TransactionsPage.js";
import { Rail, Sidebar } from "./Sidebar.js";
import { GroupTabs, TabBar } from "./TabBar.js";
import {
  NAV_GROUPS,
  groupOf,
  pageMeta,
  visiblePages,
  type NavFilter,
  type Navigate,
  type PageId,
} from "./nav.js";

export type { PageId, NavFilter, Navigate } from "./nav.js";

/**
 * The application shell.
 *
 * One navigation model (see nav.ts) rendered three ways depending on how much
 * room there is: a labelled sidebar, an icon rail, or a bottom tab bar with
 * the group's pages as a top strip. Dragging the window narrower walks you
 * through those states continuously and lands on exactly the layout the phone
 * viewer uses, which is the point — there is no separate "mobile design", just
 * the same design with less room.
 */
export function AppShell() {
  const connection = useApp((s) => s.connection);
  const aiVisible = useApp((s) => s.aiVisible);
  const mode = useLayoutMode();

  const [page, setPage] = useState<PageId>("dashboard");
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Filter carried into a page by a cross-page link (Sankey drill-in, account
  // row, category row, stat card…); consumed once on navigate.
  const [filter, setFilter] = useState<NavFilter>({});

  const navigate = useCallback<Navigate>((target, next) => {
    setFilter(next ?? {});
    setPage(target);
  }, []);

  // If the assistant gets switched off while it's open, don't strand the user
  // on a page that's no longer in the nav.
  useEffect(() => {
    if (page === "assistant" && !aiVisible) setPage("dashboard");
  }, [page, aiVisible]);

  // ⌘K / Ctrl-K from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands = useMemo<Command[]>(
    () =>
      NAV_GROUPS.flatMap((group) =>
        visiblePages(group, aiVisible).map((p) => ({
          id: `go:${p.id}`,
          label: p.title,
          group: group.label,
          icon: p.icon,
          ...(p.keywords ? { keywords: p.keywords } : {}),
          run: () => navigate(p.id),
        })),
      ),
    [aiVisible, navigate],
  );

  const group = groupOf(page);
  const meta = pageMeta(page);
  const narrow = mode === "narrow";

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: "var(--color-bg)",
        color: "var(--content-primary)",
        fontFamily: "var(--font-body)",
      }}
    >
      {mode === "wide" && <Sidebar page={page} onNavigate={navigate} />}
      {mode === "medium" && <Rail page={page} onNavigate={navigate} />}

      <main className="app-main">
        {connection === "offline" && (
          <Banner tone="warning" action={<ReconnectAction />}>
            Connection to the server lost — reconnecting. Your data is safe on the
            server; nothing is lost.
          </Banner>
        )}

        <Header
          title={meta.title}
          mode={mode}
          onOpenPalette={() => setPaletteOpen(true)}
          onNavigate={navigate}
        />

        {narrow && (
          <div style={{ padding: "0 var(--space-4)", flex: "none", background: "var(--color-bg)" }}>
            <GroupTabs group={group} page={page} onNavigate={navigate} />
          </div>
        )}

        <div className="app-scroll">
          {/* Scoped to the page body so a crash leaves the sidebar, header and
              command palette usable — you can just navigate away. Keyed on the
              page so moving elsewhere clears the error automatically. */}
          <ErrorBoundary resetKeys={[page]}>
            <PageBody page={page} filter={filter} onNavigate={navigate} />
          </ErrorBoundary>
        </div>

        {narrow && (
          <TabBar
            group={group}
            onSelectGroup={(_g, firstPage) => navigate(firstPage)}
          />
        )}
      </main>

      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}

/**
 * Page switch. Keyed on the incoming filter so a cross-page navigation to a
 * page you're already on still re-mounts with the new filter applied.
 */
function PageBody({
  page,
  filter,
  onNavigate,
}: {
  page: PageId;
  filter: NavFilter;
  onNavigate: Navigate;
}) {
  switch (page) {
    case "dashboard":
      return <DashboardPage onNavigate={onNavigate} />;
    case "insights":
      return <InsightsPage onNavigate={onNavigate} />;
    case "accounts":
      return <AccountsPage onNavigate={onNavigate} />;
    case "transactions":
      return (
        <TransactionsPage
          key={filter.categoryId ?? filter.accountId ?? "all"}
          {...(filter.categoryId ? { initialCategoryId: filter.categoryId } : {})}
          {...(filter.accountId ? { initialAccountId: filter.accountId } : {})}
        />
      );
    case "income":
      return <IncomePage onNavigate={onNavigate} />;
    case "subscriptions":
      return <SubscriptionsPage onNavigate={onNavigate} />;
    case "budgets":
      return <BudgetsPage onNavigate={onNavigate} {...(filter.tab ? { initialTab: filter.tab } : {})} />;
    case "bills":
      return <BillsPage {...(filter.tab ? { initialTab: filter.tab } : {})} />;
    case "cashflow":
      return <CashFlowPage {...(filter.tab ? { initialTab: filter.tab } : {})} />;
    case "giving":
      return <GivingPage onNavigate={onNavigate} />;
    case "investments":
      return <InvestmentsPage onNavigate={onNavigate} />;
    case "goals":
      return <GoalsPage onNavigate={onNavigate} />;
    case "networth":
      return <NetWorthPage onNavigate={onNavigate} />;
    case "reports":
      return <ReportsPage onNavigate={onNavigate} />;
    case "assistant":
      return <AssistantPage onNavigate={onNavigate} />;
    case "settings":
      return <SettingsPage />;
  }
}

function ReconnectAction() {
  const routeForServer = useApp((s) => s.routeForServer);
  return (
    <Button variant="ghost" size="sm" onClick={() => void routeForServer()}>
      Retry now
    </Button>
  );
}
