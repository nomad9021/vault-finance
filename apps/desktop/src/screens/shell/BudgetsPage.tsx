import {
  formatCents,
  formatCentsWhole,
  parseAmountToCents,
  type BudgetWithSpend,
  type Category,
} from "@vault/shared";
import { Button, Card, Dialog, Field, Select, Spinner, Tag } from "@vault/ui";
import { useState } from "react";
import { useData } from "../../lib/useData.js";
import { useApp } from "../../state/store.js";

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

export function BudgetsPage() {
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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        maxWidth: 860,
        margin: "0 auto",
        animation: "fadeUp .3s both",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="ghost" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
          ←
        </Button>
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15, minWidth: 140, textAlign: "center" }}>
          {monthLabel(month)}
        </span>
        <Button variant="ghost" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
          →
        </Button>
        <div style={{ marginLeft: "auto" }}>
          <Button variant="primary" onClick={() => setEditing("new")}>
            + Add budget
          </Button>
        </div>
      </div>

      <div
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-divider)",
          borderRadius: 12,
          padding: "16px 18px",
          boxShadow: "var(--shadow-sm)",
          display: "flex",
          flexWrap: "wrap",
          gap: 24,
          alignItems: "baseline",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              letterSpacing: ".04em",
              textTransform: "uppercase",
              color: "var(--color-neutral-500)",
              fontWeight: 600,
            }}
          >
            {monthLabel(month)} total
          </div>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 24 }}>
            {formatCentsWhole(totalSpent)}{" "}
            <span style={{ fontSize: 14, color: "var(--color-neutral-500)", fontWeight: 500 }}>
              of {formatCentsWhole(totalBudgeted)}
            </span>
          </div>
        </div>
        {totalBudgeted > 0 && (
          <Tag variant={leftCents < 0 ? "outline" : "accent"}>
            {pctUsed}% used ·{" "}
            {leftCents < 0
              ? `${formatCentsWhole(-leftCents)} over`
              : `${formatCentsWhole(leftCents)} left`}
          </Tag>
        )}
      </div>

      <div
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-divider)",
          borderRadius: 12,
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div
          style={{
            padding: "14px 18px 8px",
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            fontSize: 14,
          }}
        >
          Category budgets
        </div>
        <div
          style={{
            padding: "8px 18px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 15,
          }}
        >
          {loading && !data ? (
            <Spinner label="Loading budgets" />
          ) : budgets.length === 0 ? (
            <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>
              No budgets for {monthLabel(month)}. Add one to start tracking
              spending against a monthly limit.
            </p>
          ) : (
            budgets.map((b) => (
              <BudgetBar
                key={b.id}
                budget={b}
                category={categoryById.get(b.categoryId)}
                onClick={() => setEditing(b)}
              />
            ))
          )}
        </div>
      </div>

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
}: {
  budget: BudgetWithSpend;
  category: Category | undefined;
  onClick: () => void;
}) {
  const pct = budget.amountCents > 0 ? budget.spentCents / budget.amountCents : 0;
  const over = pct > 1;
  const color = category?.color ?? "var(--color-accent)";

  return (
    <button
      onClick={onClick}
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
          fontSize: 13,
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
        <span
          style={{
            color: over ? "var(--color-negative)" : "var(--color-neutral-500)",
          }}
        >
          {formatCents(budget.spentCents)} of {formatCents(budget.amountCents)}
          {over && " — over"}
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
    </button>
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
          <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)" }}>
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
