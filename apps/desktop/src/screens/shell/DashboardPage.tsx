import { Button, Card } from "@vault/ui";
import type { PageId } from "./AppShell.js";

/**
 * M2 empty state: a signed-in dashboard with clear next steps. The real
 * dashboard (net worth, cash flow, Sankey) arrives with M3/M5 — this page
 * intentionally renders only what a brand-new server can truthfully show.
 */
export function DashboardPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  return (
    <div style={{ maxWidth: 760 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 14,
        }}
      >
        <Card kicker="Get started" title="Add your first account">
          <p className="card-body">
            Checking, savings, credit cards, loans — accounts are where every
            transaction lives.
          </p>
          <div>
            <Button variant="primary" onClick={() => onNavigate("accounts")}>
              Open Accounts
            </Button>
          </div>
        </Card>
        <Card kicker="Then" title="Record transactions">
          <p className="card-body">
            Import or add spending and income; categories and budgets build on
            top of them.
          </p>
          <div>
            <Button variant="secondary" onClick={() => onNavigate("transactions")}>
              Open Transactions
            </Button>
          </div>
        </Card>
        <Card kicker="Anytime" title="Ask the assistant">
          <p className="card-body">
            The AI runs on your own server. Once accounts exist it can explain
            spending, forecast cash flow, and more.
          </p>
          <div>
            <Button variant="secondary" onClick={() => onNavigate("assistant")}>
              Open AI Assistant
            </Button>
          </div>
        </Card>
      </div>
      <p className="text-muted" style={{ fontSize: 12.5, marginTop: 18 }}>
        Everything you add stays on your server — nothing ever leaves your
        hardware.
      </p>
    </div>
  );
}
