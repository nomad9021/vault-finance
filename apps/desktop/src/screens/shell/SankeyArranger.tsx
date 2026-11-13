import type { Category } from "@vault/shared";
import { Button, Icon, Spinner } from "@vault/ui";
import { useRef, useState, type ReactElement } from "react";
import { reorder, useDragSort, type DropZone } from "../../lib/dragSort.js";
import { useData } from "../../lib/useData.js";
import { useChat } from "../../state/chat.js";
import { useApp } from "../../state/store.js";

/**
 * Edit the Sankey right where it's drawn: the category tree behind it, as a
 * list you drag to rearrange. Drop on the top or bottom edge of a row to put
 * it before or after; drop on the middle to tuck it inside. Rename, recolour,
 * add and delete in place. Every change redraws the diagram (and the planned
 * and budget-vs-actual ones, which use the same tree).
 */

const COLORS = ["#7c5cff", "#5b8def", "#3ecf8e", "#f5a623", "#ec6a9c", "#43cfc0", "#d8b23c", "#b47ef0"];

export function SankeyArranger({ onChanged }: { onChanged?: () => void }) {
  const client = useApp((s) => s.client);
  const refreshAll = useChat((s) => s.refreshData);
  const { data, reload } = useData(() => client.categories(), [client]);
  const all = data?.categories ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const byId = new Map(all.map((c) => [c.id, c]));
  const childrenOf = (id: string | null, kind: Category["kind"]) =>
    all
      .filter((c) => (c.parentCategoryId ?? null) === id && c.kind === kind)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  /** `id` is `ancestorId` or somewhere inside it. */
  const within = (id: string | null, ancestorId: string) => {
    for (let cur = id ? byId.get(id) : undefined, n = 0; cur && n < 50; cur = cur.parentCategoryId ? byId.get(cur.parentCategoryId) : undefined, n++) {
      if (cur.id === ancestorId) return true;
    }
    return false;
  };

  const run = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : failure);
    } finally {
      await reload();
      setBusy(false);
      onChanged?.();
      refreshAll();
    }
  };

  const dnd = useDragSort({
    zoneFor: (rect, _x, y) => (y < rect.top + rect.height * 0.3 ? "before" : y > rect.bottom - rect.height * 0.3 ? "after" : "inside"),
    canDrop: (dragId, targetId, zone) => {
      if (targetId.startsWith("top:")) return byId.get(dragId)?.kind === targetId.slice(4);
      const d = byId.get(dragId);
      const t = byId.get(targetId);
      if (!d || !t || d.kind !== t.kind) return false;
      const parent = zone === "inside" ? t.id : (t.parentCategoryId ?? null);
      return !within(parent, d.id);
    },
    onDrop: (dragId, targetId, zone) => void (targetId.startsWith("top:") ? toTop(dragId) : move(dragId, targetId, zone)),
  });

  const toTop = (id: string) =>
    run(async () => {
      const d = byId.get(id);
      if (!d) return;
      if (d.parentCategoryId) await client.updateCategory(id, { parentCategoryId: null });
      const order = childrenOf(null, d.kind).map((c) => c.id).filter((x) => x !== id);
      await client.reorderCategories([...order, id]);
    }, "Couldn't move that category.");

  const move = async (dragId: string, targetId: string, zone: DropZone) => {
    const d = byId.get(dragId)!;
    const t = byId.get(targetId)!;
    const parent = zone === "inside" ? t.id : (t.parentCategoryId ?? null);
    await run(async () => {
      if ((d.parentCategoryId ?? null) !== parent) await client.updateCategory(d.id, { parentCategoryId: parent });
      const siblings = childrenOf(parent, d.kind).map((c) => c.id).filter((id) => id !== d.id);
      const order = zone === "inside" ? [...siblings, d.id] : reorder([...siblings, d.id], d.id, t.id, zone);
      if (order.length > 1) await client.reorderCategories(order);
    }, "Couldn't move that category.");
  };

  const recolorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recolor = (id: string, color: string) => {
    if (recolorTimer.current) clearTimeout(recolorTimer.current);
    recolorTimer.current = setTimeout(() => void run(() => client.updateCategory(id, { color }), "Couldn't change the colour."), 300);
  };

  const add = (parentId: string | null, kind: Category["kind"]) =>
    run(
      () =>
        client.createCategory({
          name: kind === "income" ? "New income" : "New category",
          color: (parentId ? byId.get(parentId)?.color : undefined) ?? COLORS[all.length % COLORS.length]!,
          parentCategoryId: parentId,
          kind,
        }),
      "Couldn't add a category.",
    );

  const rows = (parent: string | null, kind: Category["kind"], depth: number): ReactElement[] =>
    childrenOf(parent, kind).flatMap((c) => [
      <div
        key={c.id}
        className="arr-row"
        {...dnd.item(c.id)}
        style={{ ...dnd.item(c.id).style, paddingLeft: 6 + depth * 20 }}
      >
        <span className="arr-grip" aria-label={`Drag ${c.name}`} role="button" tabIndex={-1} {...dnd.handle(c.id)}>
          <span aria-hidden="true">⋮⋮</span>
        </span>
        <label className="arr-swatch" style={{ background: c.color }} title="Change colour">
          <input type="color" value={c.color} aria-label={`Colour of ${c.name}`} onChange={(e) => recolor(c.id, e.target.value)} />
        </label>
        {editing === c.id ? (
          <input
            className="input arr-name-input"
            defaultValue={c.name}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            maxLength={60}
            aria-label="Category name"
            onBlur={(e) => {
              const name = e.target.value.trim();
              setEditing(null);
              if (name && name !== c.name) void run(() => client.updateCategory(c.id, { name }), "Couldn't rename that.");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(null);
            }}
          />
        ) : (
          <button type="button" className="arr-name truncate" title="Rename" onClick={() => setEditing(c.id)}>
            {c.name}
          </button>
        )}
        <button type="button" className="arr-btn" aria-label={`Add a category inside ${c.name}`} title="Add inside" disabled={busy} onClick={() => void add(c.id, c.kind)}>
          <Icon name="plus" size={14} />
        </button>
        {confirmDelete === c.id ? (
          <button
            type="button"
            className="panel-link"
            style={{ color: "var(--color-negative)" }}
            onClick={() => {
              setConfirmDelete(null);
              void run(() => client.deleteCategory(c.id), "That category is in use (transactions or budgets) — move those first.");
            }}
          >
            Delete?
          </button>
        ) : (
          <button type="button" className="arr-btn" aria-label={`Delete ${c.name}`} title="Delete" disabled={busy || c.isSystem} onClick={() => setConfirmDelete(c.id)}>
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>,
      ...rows(c.id, kind, depth + 1),
    ]);

  return (
    <div className="arranger">
      <div className="row-between" style={{ marginBottom: "var(--space-2)" }}>
        <div className="t-xs t-tertiary">Drag ⋮⋮ to move: drop on a row's edge to place it, on its middle to put it inside. Tap a name to rename.</div>
        {busy && <Spinner label="Saving" />}
      </div>
      {!data ? (
        <Spinner label="Loading categories" />
      ) : (
        (["expense", "income"] as const).map((kind) => (
          <div key={kind} className="arr-group">
            <div className="row-between">
              <div className="eyebrow">{kind === "income" ? "Money in" : "Spending"}</div>
              <Button variant="ghost" size="sm" icon="plus" disabled={busy} onClick={() => void add(null, kind)}>
                Add
              </Button>
            </div>
            <div className="arr-list">{rows(null, kind, 0)}</div>
            {dnd.drag && byId.get(dnd.drag.id)?.kind === kind && (byId.get(dnd.drag.id)?.parentCategoryId ?? null) !== null && (
              // Dropping here takes a category back to the top level.
              <div className="arr-top-drop" {...dnd.item(`top:${kind}`)}>
                Drop here to make it a main {kind === "income" ? "income source" : "category"}
              </div>
            )}
          </div>
        ))
      )}
      {error && (
        <div role="alert" className="t-sm" style={{ color: "var(--color-negative)", marginTop: 8 }}>
          {error}
        </div>
      )}
    </div>
  );
}
