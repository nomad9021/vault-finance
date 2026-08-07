import {
  formatCents,
  formatCentsWhole,
  parseAmountToCents,
  type BudgetWithSpend,
  type Category,
} from "@vault/shared";
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Panel,
  Select,
  SkeletonList,
  Spinner,
  Tabs,
  Tag,
} from "@vault/ui";
import { useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";
import type { Navigate } from "./AppShell.js";
import { BudgetPlannerPage } from "./BudgetPlannerPage.js";

const TABS = [
  { value: "budgets" as const, label: "This month" },
  { value: "planner" as const, label: "Planner" },
];
type BudgetTab = (typeof TABS)[number]["value"];

/**
 * Budgets and the budget planner were two sidebar entries that nobody could
 * tell apart. They're the same subject at two time horizons — what you've spent
 * this month, and how you intend to divide a month's income — so they're one
 * destination with two tabs.
 */
export function BudgetsPage({
  onNavigate,
  initialTab,
}: {
  onNavigate: Navigate;
  initialTab?: string;
}) {
  const [tab, setTab] = useState<BudgetTab>(initialTab === "planner" ? "planner" : "budgets");
  return (
    <div className="page">
      <Tabs items={TABS} value={tab} onChange={setTab} aria-label="Budget views" />
      {tab === "budgets" ? (
        <BudgetsTab onNavigate={onNavigate} />
      ) : (
        <BudgetPlannerPage onNavigate={onNavigate} />
      )}
    </div>
  );
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function BudgetsTab({ onNavigate }: { onNavigate: Navigate }) {
  const client = useApp((s) => s.client);
  const [month, setMonth] = useState(currentMonth());

  const { data, loading, reload } = useData(() => client.budgets(month), [client, month]);
  const { data: categoryData } = useData(() => client.categories(), [client]);
  const categories = categoryData?.categories ?? [];
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  const [editing, setEditing] = useState<BudgetWithSpend | "new" | null>(null);

  const budgets = data?.budgets ?? [];
  const totalBudgeted = data?.totalBudgetedCents ?? 0;
  const totalSpent = data?.totalSpentCents ?? 0;
  const leftCents = totalBudgeted - totalSpent;
  const pctUsed = totalBudgeted > 0 ? Math.round((totalSpent / totalBudgeted) * 100) : 0;

  return (
    <div className="page" style={{ maxWidth: 920 }}>
      <div className="row" style={{ gap: "var(--space-1)" }}>
        <Button
          variant="ghost"
          icon="chevronLeft"
          onClick={() => setMonth(shiftMonth(month, -1))}
          aria-label="Previous month"
        />
        <span
          className="t-md t-semibold"
          style={{ minWidth: 150, textAlign: "center", fontFamily: "var(--font-heading)" }}
        >
          {monthLabel(month)}
        </span>
        <Button
          variant="ghost"
          icon="chevronRight"
          onClick={() => setMonth(shiftMonth(month, 1))}
          aria-label="Next month"
        />
        <div className="spacer">
          <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>
            Add budget
          </Button>
        </div>
      </div>

      <div className="panel row wrap" style={{ gap: "var(--space-6)", alignItems: "baseline" }}>
        <div className="stat">
          <div className="stat-label">{monthLabel(month)} total</div>
          <div className="stat-value">
            {formatCentsWhole(totalSpent)}{" "}
            <span className="t-base t-tertiary" style={{ fontWeight: 500 }}>
              of {formatCentsWhole(totalBudgeted)}
            </span>
          </div>
        </div>
        {totalBudgeted > 0 && (
          <Tag variant={leftCents < 0 ? "negative" : "accent"}>
            {pctUsed}% used ·{" "}
            {leftCents < 0
              ? `${formatCentsWhole(-leftCents)} over`
              : `${formatCentsWhole(leftCents)} left`}
          </Tag>
        )}
      </div>

      <Panel title="Category budgets">
        <div className="stack-lg">
          {loading && !data ? (
            <SkeletonList rows={4} height={52} />
          ) : budgets.length === 0 ? (
            <EmptyState
              compact
              icon="target"
              title={`No budgets for ${monthLabel(month)}`}
              body="Add one to start tracking spending against a monthly limit."
              action={
                <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>
                  Add budget
                </Button>
              }
            />
          ) : (
            budgets.map((b) => (
              <BudgetBar
                key={b.id}
                budget={b}
                category={categoryById.get(b.categoryId)}
                onClick={() => setEditing(b)}
                onViewTransactions={() =>
                  onNavigate("transactions", { categoryId: b.categoryId })
                }
              />
            ))
          )}
        </div>
      </Panel>

      {editing && (
        <BudgetDialog
          budget={editing === "new" ? null : editing}
          month={month}
          categories={categories}
          existingCategoryIds={new Set(budgets.map((b) => b.categoryId))}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function BudgetBar({
  budget,
  category,
  onClick,
  onViewTransactions,
}: {
  budget: BudgetWithSpend;
  category: Category | undefined;
  onClick: () => void;
  onViewTransactions: () => void;
}) {
  const pct = budget.amountCents > 0 ? budget.spentCents / budget.amountCents : 0;
  const over = pct > 1;
  const color = category?.color ?? "var(--color-accent)";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick()}
      style={{
        display: "block",
        width: "100%",
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        font: "inherit",
        color: "inherit",
        textAlign: "left",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          fontSize: "var(--text-sm)",
          marginBottom: 5,
        }}
      >
        <span style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 7 }}>
          <span
            aria-hidden="true"
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: color,
              flex: "none",
            }}
          />
          {category?.name ?? "Unknown category"}
        </span>
        <span style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span
            style={{
              color: over ? "var(--color-negative)" : "var(--content-tertiary)",
            }}
          >
            {formatCents(budget.spentCents)} of {formatCents(budget.amountCents)}
            {over && " — over"}
          </span>
          <button
            title="View this category's transactions"
            onClick={(e) => {
              e.stopPropagation();
              onViewTransactions();
            }}
            style={{
              border: 0,
              background: "none",
              cursor: "pointer",
              font: "inherit",
              fontSize: "var(--text-xs)",
              fontWeight: 600,
              color: "var(--content-tertiary)",
              padding: 0,
            }}
          >
            Transactions →
          </button>
        </span>
      </div>
      <div
        style={{
          height: 7,
          borderRadius: 99,
          background: "var(--color-neutral-900)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            borderRadius: 99,
            width: `${Math.min(pct, 1) * 100}%`,
            background: over ? "var(--color-negative)" : color,
            transition: "width .3s ease",
          }}
        />
      </div>
    </div>
  );
}

function BudgetDialog({
  budget,
  month,
  categories,
  existingCategoryIds,
  onClose,
  onSaved,
}: {
  budget: BudgetWithSpend | null;
  month: string;
  categories: Category[];
  existingCategoryIds: Set<string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = useApp((s) => s.client);
  const available = categories.filter(
    (c) => !existingCategoryIds.has(c.id) || c.id === budget?.categoryId,
  );
  const [categoryId, setCategoryId] = useState(budget?.categoryId ?? available[0]?.id ?? "");
  const [amount, setAmount] = useState(
    budget ? (budget.amountCents / 100).toFixed(2) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountCents = parseAmountToCents(amount);
  const valid = categoryId && amountCents !== null && amountCents > 0;

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (budget) {
        await client.updateBudget(budget.id, { amountCents: amountCents! });
      } else {
        await client.createBudget({
          categoryId,
          amountCents: amountCents!,
          rollover: false,
          month,
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!budget || busy) return;
    setBusy(true);
    try {
      await client.deleteBudget(budget.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={budget ? "Edit budget" : "Add budget"}
      onClose={onClose}
      actions={
        <>
          {budget && (
            <Button variant="ghost" onClick={() => void remove()} disabled={busy}>
              Delete
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!valid || busy}>
            {busy ? <Spinner label="Saving" /> : "Save"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {!budget && (
          <Select
            label="Category"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        <Field
          label="Monthly amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          autoFocus
          placeholder="600.00"
          error={
            amount && (amountCents === null || amountCents <= 0)
              ? "Enter a positive amount like 600.00"
              : undefined
          }
          hint={
            budget
              ? "Changes apply from this budget's start month onward."
              : `Applies from ${monthLabel(month)} onward, until you change it.`
          }
        />
        {error && (
          <div role="alert" style={{ fontSize: "var(--text-sm)", color: "var(--color-negative)" }}>
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
