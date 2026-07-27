import {
  AI_MODEL_SUGGESTIONS,
  AI_PROVIDER_LABELS,
  AI_QUALITY_LABELS,
  AI_QUALITY_LEVELS,
  AiProvider,
  BANK_PROVIDER_LABELS,
  BankProvider,
  CLOUD_PROVIDERS,
  type AiStatus,
  type BankStatus,
  type DeviceSession,
} from "@vault/shared";
import { THEMES, THEME_LABELS } from "@vault/design-tokens";
import { Button, Card, Dialog, Field, Segmented, Select, Spinner, Tag } from "@vault/ui";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useData } from "../../lib/useData.js";
import { APP_VERSION, useApp } from "../../state/store.js";

export function SettingsPage() {
  // Uses the shared `.page` wrapper (centered, max-width, consistent rhythm)
  // like every other screen — a narrower cap keeps settings forms readable while
  // staying centered instead of hugging the left edge.
  return (
    <div className="page" style={{ maxWidth: 780 }}>
      <AppearanceSection />
      <CategoryTreeSection />
      <CategorizationRulesSection />
      <BankSection />
      <AiSection />
      <TwoFactorSection />
      <UpdatesSection />
      <SessionsSection />
      <ServerSection />
    </div>
  );
}

function UpdatesSection() {
  const platform = useApp((s) => s.platform);
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "checking" }
    | { phase: "none" }
    | { phase: "available"; version: string }
    | { phase: "installing"; progress: number }
    | { phase: "error"; message: string }
  >({ phase: "idle" });

  // Browser dev mode has no updater — hide the card entirely.
  if (platform.kind !== "tauri") return null;

  const check = async () => {
    setState({ phase: "checking" });
    try {
      const update = await platform.checkForUpdate();
      setState(update ? { phase: "available", version: update.version } : { phase: "none" });
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : "Couldn't reach the update server.",
      });
    }
  };

  const install = async () => {
    setState({ phase: "installing", progress: 0 });
    try {
      await platform.installUpdateAndRestart((progress) =>
        setState({ phase: "installing", progress }),
      );
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : "The update failed to install.",
      });
    }
  };

  return (
    <Card kicker="Application" title={`Updates — v${APP_VERSION}`}>
      <p className="card-body">
        Updates are downloaded from the project's GitHub releases and
        signature-checked before install — the only network request this app
        ever makes outside your own server.
      </p>
      {state.phase === "available" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Tag variant="accent">v{state.version} available</Tag>
          <Button variant="primary" onClick={() => void install()}>
            Install & restart
          </Button>
        </div>
      ) : state.phase === "installing" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Spinner label="Installing update" />
          <span style={{ fontSize: 13 }}>
            Downloading… {Math.round(state.progress * 100)}%
          </span>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Button
            variant="secondary"
            onClick={() => void check()}
            disabled={state.phase === "checking"}
          >
            {state.phase === "checking" ? <Spinner label="Checking" /> : "Check for updates"}
          </Button>
          {state.phase === "none" && (
            <span style={{ fontSize: 13, color: "var(--color-neutral-500)" }}>
              You're on the latest version.
            </span>
          )}
          {state.phase === "error" && (
            <span role="alert" style={{ fontSize: 13, color: "var(--color-negative)" }}>
              {state.message}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

const STRUCTURE_COLORS = [
  "#7c5cff",
  "#5b8def",
  "#3ecf8e",
  "#e0a458",
  "#c96f9c",
  "#4db6d0",
  "#8b7cf0",
  "#5fbf8f",
];

type TreeCat = {
  id: string;
  name: string;
  color: string;
  parentCategoryId: string | null;
  sortOrder: number;
  kind: "income" | "expense";
  isSystem: boolean;
};

const treeIconBtn: CSSProperties = {
  border: 0,
  background: "none",
  cursor: "pointer",
  color: "var(--color-neutral-400)",
  font: "inherit",
  fontSize: 15,
  lineHeight: 1,
  padding: "0 2px",
};

function CategoryTreeNode({
  cat,
  childrenOf,
  onAdd,
  onRename,
  onRemove,
  onMove,
  onDragStartNode,
  onDropOnNode,
  isFirst,
  isLast,
  busy,
}: {
  cat: TreeCat;
  childrenOf: (id: string | null) => TreeCat[];
  onAdd: (parentId: string | null) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: "up" | "down") => void;
  onDragStartNode: (id: string) => void;
  onDropOnNode: (targetId: string | null) => void;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
}) {
  const kids = childrenOf(cat.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cat.name);
  const [over, setOver] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      <div
        draggable={!editing}
        onDragStart={(e) => {
          e.stopPropagation();
          onDragStartNode(cat.id);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          onDropOnNode(cat.id);
        }}
        title="Drag onto another category to move it there"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "6px 9px",
          border: over ? "1px solid var(--color-accent)" : "1px solid var(--color-divider)",
          borderRadius: 8,
          background: over
            ? "color-mix(in srgb, var(--color-accent) 12%, var(--color-surface))"
            : "var(--color-surface)",
          whiteSpace: "nowrap",
          boxShadow: "var(--shadow-sm)",
          cursor: "grab",
        }}
      >
        <span
          style={{ width: 10, height: 10, borderRadius: 3, background: cat.color, flex: "0 0 auto" }}
        />
        {editing ? (
          <input
            autoFocus
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (draft.trim() && draft.trim() !== cat.name) onRename(cat.id, draft.trim());
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setDraft(cat.name);
                setEditing(false);
              }
            }}
            style={{ width: 150, padding: "2px 6px", fontSize: 13 }}
          />
        ) : (
          <button
            onClick={() => {
              setDraft(cat.name);
              setEditing(true);
            }}
            title="Rename"
            style={{
              background: "none",
              border: 0,
              font: "inherit",
              fontWeight: 600,
              fontSize: 13,
              cursor: "text",
              color: "var(--color-text)",
            }}
          >
            {cat.name}
          </button>
        )}
        {cat.isSystem && <Tag>system</Tag>}
        <button
          title="Move up"
          disabled={isFirst}
          onClick={() => onMove(cat.id, "up")}
          style={{ ...treeIconBtn, opacity: isFirst ? 0.25 : 1, cursor: isFirst ? "default" : "pointer" }}
        >
          ▲
        </button>
        <button
          title="Move down"
          disabled={isLast}
          onClick={() => onMove(cat.id, "down")}
          style={{ ...treeIconBtn, opacity: isLast ? 0.25 : 1, cursor: isLast ? "default" : "pointer" }}
        >
          ▼
        </button>
        <button title="Add branch" onClick={() => onAdd(cat.id)} style={treeIconBtn}>
          ＋
        </button>
        {!cat.isSystem && (
          <button
            title="Delete"
            disabled={busy}
            onClick={() => onRemove(cat.id)}
            style={{ ...treeIconBtn, color: "var(--color-negative)" }}
          >
            ×
          </button>
        )}
      </div>
      {kids.length > 0 && (
        <>
          <div
            style={{ width: 20, height: 1, background: "var(--color-divider)", flex: "0 0 auto" }}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              borderLeft: "1px solid var(--color-divider)",
            }}
          >
            {kids.map((k, i) => (
              <div key={k.id} style={{ display: "flex", alignItems: "center" }}>
                <div
                  style={{ width: 14, height: 1, background: "var(--color-divider)", flex: "0 0 auto" }}
                />
                <CategoryTreeNode
                  cat={k}
                  childrenOf={childrenOf}
                  onAdd={onAdd}
                  onRename={onRename}
                  onRemove={onRemove}
                  onMove={onMove}
                  onDragStartNode={onDragStartNode}
                  onDropOnNode={onDropOnNode}
                  isFirst={i === 0}
                  isLast={i === kids.length - 1}
                  busy={busy}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Interactive tree editor for the category hierarchy — the structure that
 * shapes the cash-flow Sankey. It grows to the right: a category's sub-branches
 * sit to its right, connected by lines. Click a name to rename, ＋ to add a
 * branch, × to delete.
 */
function CategoryTreeSection() {
  const client = useApp((s) => s.client);
  const { data, reload } = useData(() => client.categories(), [client]);
  // Spending tree = expense categories only; income sources are managed on the
  // Income page.
  const categories = (data?.categories ?? []).filter(
    (c) => (c as TreeCat).kind !== "income",
  ) as TreeCat[];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const childrenOf = (id: string | null) =>
    categories
      .filter((c) => (c.parentCategoryId ?? null) === id)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  const addChild = async (parentId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await client.createCategory({
        name: "New category",
        color: STRUCTURE_COLORS[categories.length % STRUCTURE_COLORS.length]!,
        parentCategoryId: parentId,
      });
      await reload();
    } catch {
      setError("Couldn't add the branch.");
    } finally {
      setBusy(false);
    }
  };
  const rename = async (id: string, name: string) => {
    await client.updateCategory(id, { name }).catch(() => setError("Couldn't rename."));
    await reload();
  };
  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await client.deleteCategory(id);
      await reload();
    } catch {
      setError(
        "That category is in use (transactions or budgets) or is a system default — reassign those first.",
      );
    } finally {
      setBusy(false);
    }
  };
  const move = async (id: string, direction: "up" | "down") => {
    setError(null);
    await client.moveCategory(id, direction).catch(() => setError("Couldn't reorder that category."));
    await reload();
  };

  // Drag-to-reparent. dragId is held in a ref (survives re-renders during drag).
  const dragId = useRef<string | null>(null);
  const isDescendant = (targetId: string, ancestorId: string): boolean => {
    let cur = categories.find((c) => c.id === targetId);
    while (cur?.parentCategoryId) {
      if (cur.parentCategoryId === ancestorId) return true;
      cur = categories.find((c) => c.id === cur!.parentCategoryId);
    }
    return false;
  };
  const onDropOn = async (targetId: string | null) => {
    const src = dragId.current;
    dragId.current = null;
    if (!src || src === targetId) return;
    // Can't move a node under itself or one of its own descendants.
    if (targetId && isDescendant(targetId, src)) {
      setError("Can't move a category under one of its own branches.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.updateCategory(src, { parentCategoryId: targetId });
      await reload();
    } catch {
      setError("Couldn't move that category.");
    } finally {
      setBusy(false);
    }
  };

  const roots = childrenOf(null);
  return (
    <Card kicker="Categories" title="Category tree">
      <p className="card-meta">
        The one place to shape both the cash-flow and budget-planner Sankeys. The tree grows to the
        right — a category’s sub-branches sit to its right. Click a name to rename, ▲▼ to reorder
        among siblings, ＋ to add a branch, × to delete, and drag a node onto another to move it (or
        onto “Top level” to un-nest it).
      </p>
      <div style={{ overflowX: "auto", padding: "10px 2px" }}>
        {roots.length === 0 ? (
          <p className="card-meta">No categories yet — add one below.</p>
        ) : (
          <div
            style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: "max-content" }}
          >
            {roots.map((c, i) => (
              <CategoryTreeNode
                key={c.id}
                cat={c}
                childrenOf={childrenOf}
                onAdd={addChild}
                onRename={rename}
                onRemove={remove}
                onMove={move}
                onDragStartNode={(id) => (dragId.current = id)}
                onDropOnNode={onDropOn}
                isFirst={i === 0}
                isLast={i === roots.length - 1}
                busy={busy}
              />
            ))}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
        <Button variant="secondary" onClick={() => void addChild(null)}>
          ＋ Add top-level category
        </Button>
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void onDropOn(null);
          }}
          style={{
            fontSize: 12,
            color: "var(--color-neutral-500)",
            border: "1px dashed var(--color-divider)",
            borderRadius: 8,
            padding: "6px 12px",
          }}
        >
          ↳ Drop here for “Top level”
        </div>
      </div>
      {error && (
        <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)", marginTop: 8 }}>
          {error}
        </div>
      )}
    </Card>
  );
}

/**
 * Manage explicit keyword → category rules for local auto-categorization. These
 * run alongside history-learning (which needs no config); both are local and
 * never involve the AI assistant.
 */
function CategorizationRulesSection() {
  const client = useApp((s) => s.client);
  const { data: ruleData, reload } = useData(() => client.categorizationRules(), [client]);
  const { data: catData } = useData(() => client.categories(), [client]);
  const rules = ruleData?.rules ?? [];
  const categories = catData?.categories ?? [];
  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? "Unknown";

  const [keyword, setKeyword] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!keyword.trim() || !categoryId) return;
    setBusy(true);
    setError(null);
    try {
      await client.createCategorizationRule({ keyword: keyword.trim(), categoryId });
      setKeyword("");
      setCategoryId("");
      await reload();
    } catch {
      setError("Couldn't add that rule.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    await client.deleteCategorizationRule(id).catch(() => {});
    await reload();
  };

  return (
    <Card kicker="Categorization" title="Auto-categorization rules">
      <p className="card-meta">
        When a transaction’s merchant name contains a keyword, file it under the chosen category —
        applied on CSV import and when you press “Auto-categorize” on the Transactions page. Entirely
        local; the AI assistant is never involved. Beyond these rules, the app also learns from how
        you’ve categorized transactions before.
      </p>

      <div style={{ margin: "12px 0" }}>
        {rules.length === 0 ? (
          <p className="card-meta">No keyword rules yet — history-learning still works without them.</p>
        ) : (
          rules.map((r) => (
            <div
              key={r.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 0",
                borderTop: "1px solid var(--color-divider)",
              }}
            >
              <span style={{ fontWeight: 600, fontSize: 13 }}>“{r.keyword}”</span>
              <span style={{ color: "var(--color-neutral-500)", fontSize: 13 }}>
                → {catName(r.categoryId)}
              </span>
              <div style={{ marginLeft: "auto" }}>
                <Button variant="ghost" onClick={() => remove(r.id)}>
                  Delete
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: 2, minWidth: 150 }}>
          <Field
            label="Keyword in merchant name"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="e.g. Starbucks"
          />
        </div>
        <div style={{ flex: 1, minWidth: 150 }}>
          <Select label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Choose…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="primary" onClick={add} disabled={busy || !keyword.trim() || !categoryId}>
          Add rule
        </Button>
      </div>
      {error && (
        <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)", marginTop: 8 }}>
          {error}
        </div>
      )}
    </Card>
  );
}

function AiSection() {
  const client = useApp((s) => s.client);
  const user = useApp((s) => s.user);
  const refreshAiEnabled = useApp((s) => s.refreshAiEnabled);
  const { data: status, reload } = useData<AiStatus>(() => client.aiStatus(), [client]);

  const [provider, setProvider] = useState<AiProvider>("ollama");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [qualityModels, setQualityModels] = useState<Record<string, string>>({});
  const [showModelNames, setShowModelNames] = useState(false);
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the form from server state until the user starts editing.
  useEffect(() => {
    if (status && !dirty) {
      setProvider(status.provider);
      setModel(status.model);
      setBaseUrl(status.baseUrl);
      setEnabled(status.enabled);
      setQualityModels(status.qualityModels ?? {});
      setShowModelNames(status.showModelNames);
      setInstalledModels(status.availableModels);
      setApiKey(""); // never populated — the key is write-only
    }
  }, [status, dirty]);

  const isOwner = user?.role === "owner";
  const touch = () => setDirty(true);
  const isCloud = CLOUD_PROVIDERS.has(provider);

  const refreshModels = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const r = await client.aiModels();
      setInstalledModels(r.models);
      if (r.models.length === 0) setError("No installed models found — is Ollama running with a model pulled?");
    } catch {
      setError("Couldn't reach the provider to list models.");
    } finally {
      setRefreshing(false);
    }
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // For Ollama the concrete "model" is derived from the quality map (Normal
      // tier is the sensible default the provider config falls back to).
      const resolvedModel =
        provider === "ollama"
          ? qualityModels.normal || installedModels[0] || model || "llama3.2:3b"
          : model;
      await client.updateAiSettings({
        enabled,
        provider,
        model: resolvedModel.trim(),
        // Only send the key when the user typed one — blank leaves the stored
        // key untouched (they can clear it with the button below).
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        baseUrl: baseUrl.trim(),
        ...(provider === "ollama" ? { qualityModels } : {}),
        showModelNames,
      });
      setApiKey("");
      setDirty(false);
      reload();
      await refreshAiEnabled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save AI settings.");
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    try {
      await client.updateAiSettings({ enabled, provider, model: model.trim(), apiKey: "", baseUrl: baseUrl.trim() });
      setApiKey("");
      setDirty(false);
      reload();
      await refreshAiEnabled();
    } finally {
      setBusy(false);
    }
  };

  const statusLine = (s: AiStatus): string => {
    if (!s.enabled) return "Off";
    if (!s.configured) return "Needs configuration";
    if (s.reachable) {
      return s.availableModels.length > 0
        ? `Connected — ${s.availableModels.length} model${s.availableModels.length === 1 ? "" : "s"} available`
        : "Connected";
    }
    return "Unreachable";
  };

  return (
    <Card kicker="AI assistant" title="AI assistant (optional)">
      {status === null ? (
        <Spinner label="Checking AI status" />
      ) : (
        <>
          <p className="card-body">
            Off by default. Turn it on and connect a provider to get spending
            explanations, forecasts, and monthly summaries. The server talks to
            the provider — the desktop app never holds your key.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: !status.enabled
                  ? "var(--color-neutral-600)"
                  : status.configured && status.reachable
                    ? "var(--color-positive)"
                    : "var(--color-negative)",
              }}
            />
            <span style={{ fontSize: 13 }}>{statusLine(status)}</span>
            {status.enabled && status.configured && (
              <Button variant="ghost" onClick={reload} style={{ marginLeft: "auto" }}>
                Test connection
              </Button>
            )}
          </div>

          {!isOwner ? (
            <p className="card-meta">Only the owner can change AI settings.</p>
          ) : (
            <>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <Select
                    label="Provider"
                    value={provider}
                    onChange={(e) => {
                      const next = e.target.value as AiProvider;
                      setProvider(next);
                      // Reset per-provider fields to that provider's default.
                      setModel(AI_MODEL_SUGGESTIONS[next][0] ?? "");
                      if (next === "ollama" && !baseUrl.trim()) setBaseUrl("http://ollama:11434");
                      setApiKey("");
                      touch();
                    }}
                  >
                    {AiProvider.options.map((p) => (
                      <option key={p} value={p}>
                        {AI_PROVIDER_LABELS[p]}
                      </option>
                    ))}
                  </Select>
                </div>
                {isCloud && (
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <Field
                      label="Model"
                      value={model}
                      list="ai-model-suggestions"
                      onChange={(e) => {
                        setModel(e.target.value);
                        touch();
                      }}
                      placeholder={AI_MODEL_SUGGESTIONS[provider][0]}
                    />
                    <datalist id="ai-model-suggestions">
                      {AI_MODEL_SUGGESTIONS[provider].map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </div>
                )}
              </div>

              {provider === "ollama" ? (
                <Field
                  label="Ollama base URL"
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    touch();
                  }}
                  placeholder="http://ollama:11434"
                  hint={'"ollama" is the bundled Docker service; or an address elsewhere on your network.'}
                />
              ) : (
                <Field
                  label={`${AI_PROVIDER_LABELS[provider]} API key`}
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    touch();
                  }}
                  placeholder={
                    status.hasApiKey && status.provider === provider
                      ? "•••••••• (saved — leave blank to keep)"
                      : "sk-…"
                  }
                  hint={
                    status.hasApiKey && status.provider === provider ? (
                      <>
                        A key is saved.{" "}
                        <button
                          type="button"
                          onClick={() => void clearKey()}
                          style={{
                            background: "none",
                            border: 0,
                            padding: 0,
                            color: "var(--color-accent)",
                            cursor: "pointer",
                            font: "inherit",
                          }}
                        >
                          Remove it
                        </button>
                        .
                      </>
                    ) : (
                      "Stored on your server, never on this device."
                    )
                  }
                />
              )}

              {provider === "ollama" && (
                <div style={{ marginTop: 4 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600 }}>Model quality levels</span>
                    <Button
                      variant="ghost"
                      onClick={() => void refreshModels()}
                      disabled={refreshing}
                    >
                      {refreshing ? "Refreshing…" : "Refresh installed models"}
                    </Button>
                  </div>
                  <p className="card-meta" style={{ marginTop: 2 }}>
                    Assign an installed model to each quality tier — the app requests a tier and you
                    decide which model runs it.
                  </p>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                      gap: 10,
                      marginTop: 8,
                    }}
                  >
                    {AI_QUALITY_LEVELS.map((level) => {
                      const val = qualityModels[level] ?? "";
                      const missing = val !== "" && !installedModels.includes(val);
                      return (
                        <div key={level}>
                          <Select
                            label={
                              showModelNames && val
                                ? `${AI_QUALITY_LABELS[level]} (${val})`
                                : AI_QUALITY_LABELS[level]
                            }
                            value={val}
                            onChange={(e) => {
                              const m = e.target.value;
                              setQualityModels((prev) => ({ ...prev, [level]: m }));
                              touch();
                            }}
                          >
                            <option value="">Not set</option>
                            {installedModels.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                            {missing && <option value={val}>{val} (not installed)</option>}
                          </Select>
                          {missing && (
                            <div
                              style={{ fontSize: 11.5, color: "var(--color-negative)", marginTop: 3 }}
                            >
                              Not installed — pull it or pick another.
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <label className="radio" style={{ fontSize: 13, marginTop: 10 }}>
                    <input
                      type="checkbox"
                      checked={showModelNames}
                      onChange={(e) => {
                        setShowModelNames(e.target.checked);
                        touch();
                      }}
                    />
                    <span className="dot" style={{ borderRadius: 4 }} />
                    Show technical model names
                  </label>
                </div>
              )}

              {isCloud && (
                <div
                  role="note"
                  style={{
                    fontSize: 12.5,
                    lineHeight: 1.6,
                    padding: "10px 12px",
                    borderRadius: "var(--radius-md)",
                    background: "color-mix(in srgb, var(--color-negative) 10%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--color-negative) 35%, transparent)",
                  }}
                >
                  <strong>Heads up:</strong> {AI_PROVIDER_LABELS[provider]} is a cloud
                  service. When you ask a question, a summary of your accounts,
                  spending, and budgets is sent to {AI_PROVIDER_LABELS[provider]} under
                  your API key. Choose Ollama to keep everything on your own hardware.
                </div>
              )}

              <label className="radio" style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => {
                    setEnabled(e.target.checked);
                    touch();
                  }}
                />
                <span className="dot" style={{ borderRadius: 4 }} />
                Enable the AI assistant
              </label>

              {error && (
                <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)" }}>
                  {error}
                </div>
              )}
              <div>
                <Button variant="primary" onClick={() => void save()} disabled={!dirty || busy}>
                  {busy ? <Spinner label="Saving" /> : "Save & test"}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Optional bank linking (ADR-0007). Off by default. The "mock" provider is
 * fully local; "plaid" routes data through Plaid under the owner's own keys —
 * the privacy tradeoff the banner spells out before it's enabled.
 */
function BankSection() {
  const client = useApp((s) => s.client);
  const user = useApp((s) => s.user);
  const { data: status, reload } = useData<BankStatus>(() => client.bankStatus(), [client]);

  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<BankProvider>("mock");
  const [plaidClientId, setPlaidClientId] = useState("");
  const [plaidSecret, setPlaidSecret] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (status && !dirty) {
      setEnabled(status.enabled);
      setProvider(status.provider);
      setPlaidClientId("");
      setPlaidSecret("");
    }
  }, [status, dirty]);

  const isOwner = user?.role === "owner";
  const touch = () => setDirty(true);
  const isPlaid = provider === "plaid";

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await client.updateBankSettings({
        enabled,
        provider,
        ...(plaidClientId.trim() ? { plaidClientId: plaidClientId.trim() } : {}),
        ...(plaidSecret.trim() ? { plaidSecret: plaidSecret.trim() } : {}),
      });
      setPlaidSecret("");
      setDirty(false);
      await reload();
      setMessage("Saved.");
    } catch {
      setError("Couldn't save bank settings.");
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await client.bankConnect();
      setMessage(
        `Connected ${r.institutionName}: ${r.accountsLinked} accounts, ${r.imported} transactions imported.`,
      );
      await reload();
    } catch {
      setError("Connect failed — make sure the provider is enabled and configured.");
    } finally {
      setBusy(false);
    }
  };

  const sync = async (id: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await client.bankSync(id);
      setMessage(`Synced: ${r.imported} new, ${r.skippedDuplicates} already imported.`);
      await reload();
    } catch {
      setError("Sync failed.");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (id: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await client.bankDisconnect(id);
      await reload();
      setMessage("Disconnected. The imported accounts and history were kept.");
    } catch {
      setError("Disconnect failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card kicker="Bank linking" title="Connected banks (optional)">
      <p className="card-body">
        Off by default. Pull accounts and transactions automatically instead of importing CSVs.
        Imported transactions run through your local categorization rules.
      </p>

      {!isOwner ? (
        <p className="card-meta">Only the owner can change bank settings.</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <Select
                label="Provider"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as BankProvider);
                  touch();
                }}
              >
                {BankProvider.options.map((p) => (
                  <option key={p} value={p}>
                    {BANK_PROVIDER_LABELS[p]}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {isPlaid && (
            <div
              role="note"
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.5,
                background: "color-mix(in srgb, var(--color-negative) 10%, var(--color-surface))",
                border: "1px solid color-mix(in srgb, var(--color-negative) 30%, transparent)",
              }}
            >
              <strong>Heads up — this sends data off your server.</strong> With Plaid, your bank
              login and transactions flow through Plaid's cloud under your own API keys. That breaks
              the app's otherwise-local guarantee. The Sandbox provider keeps everything on your
              machine.
            </div>
          )}

          {isPlaid && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <Field
                  label="Plaid client ID"
                  value={plaidClientId}
                  onChange={(e) => {
                    setPlaidClientId(e.target.value);
                    touch();
                  }}
                  placeholder={status?.hasPlaidCredentials ? "•••• (saved)" : "client_id"}
                />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <Field
                  label="Plaid secret"
                  type="password"
                  value={plaidSecret}
                  onChange={(e) => {
                    setPlaidSecret(e.target.value);
                    touch();
                  }}
                  placeholder={status?.hasPlaidCredentials ? "•••• (saved — blank keeps it)" : "secret"}
                />
              </div>
            </div>
          )}

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 12,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                touch();
              }}
            />
            Enable bank linking
          </label>

          <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
              Save
            </Button>
            {status?.enabled && status?.configured && (
              <Button variant="secondary" onClick={() => void connect()} disabled={busy}>
                {provider === "mock" ? "Connect a sandbox bank" : "Connect a bank"}
              </Button>
            )}
          </div>

          {message && (
            <div role="status" style={{ fontSize: 13, color: "var(--color-neutral-300)", marginTop: 8 }}>
              {message}
            </div>
          )}
          {error && (
            <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)", marginTop: 8 }}>
              {error}
            </div>
          )}

          {status && status.connections.length > 0 && (
            <div style={{ marginTop: 14 }}>
              {status.connections.map((c) => (
                <div
                  key={c.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 0",
                    borderTop: "1px solid var(--color-divider)",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{c.institutionName}</div>
                    <div style={{ fontSize: 12, color: "var(--color-neutral-500)" }}>
                      {c.accountCount} account{c.accountCount === 1 ? "" : "s"} ·{" "}
                      {c.lastSyncedAt
                        ? `synced ${new Date(c.lastSyncedAt).toLocaleString()}`
                        : "never synced"}
                    </div>
                  </div>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <Button variant="secondary" onClick={() => void sync(c.id)} disabled={busy}>
                      Sync
                    </Button>
                    <Button variant="ghost" onClick={() => void disconnect(c.id)} disabled={busy}>
                      Disconnect
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function AppearanceSection() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  return (
    <Card kicker="Appearance" title="Theme">
      <p className="card-body">
        Automatic follows your system's light/dark preference.
      </p>
      <Segmented
        aria-label="Theme"
        options={THEMES.map((t) => ({ value: t, label: THEME_LABELS[t].split(" ")[0]! }))}
        value={theme}
        onChange={(t) => void setTheme(t)}
      />
    </Card>
  );
}

/**
 * TOTP two-factor authentication. Off by default. Setup shows the secret + an
 * otpauth URI for an authenticator app; a confirmed code turns it on. Disabling
 * requires the account password (re-auth).
 */
function TwoFactorSection() {
  const client = useApp((s) => s.client);
  const { data, reload } = useData(() => client.totpStatus(), [client]);
  const enabled = data?.enabled ?? false;

  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startSetup = async () => {
    setBusy(true);
    setError(null);
    setCode("");
    try {
      setSetup(await client.totpSetup());
    } catch {
      setError("Couldn't start setup. Is the server reachable?");
    } finally {
      setBusy(false);
    }
  };
  const confirmEnable = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.totpEnable(code.replace(/\s/g, ""));
      setSetup(null);
      reload();
    } catch {
      setError("That code isn't valid — enter the current one.");
    } finally {
      setBusy(false);
    }
  };
  const confirmDisable = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.totpDisable(password);
      setDisabling(false);
      setPassword("");
      reload();
    } catch {
      setError("That password isn't right.");
    } finally {
      setBusy(false);
    }
  };

  const groupedSecret = setup ? setup.secret.replace(/(.{4})/g, "$1 ").trim() : "";

  return (
    <Card kicker="Security" title="Two-factor authentication">
      <p className="card-body">
        Add a second step at sign-in: a rotating 6-digit code from an authenticator app
        (Google Authenticator, Authy, 1Password…), on top of your password.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: "50%", background: enabled ? "var(--color-positive)" : "var(--color-neutral-600)" }}
        />
        <span style={{ fontSize: 13 }}>{enabled ? "On — a code is required to sign in" : "Off"}</span>
        <div style={{ marginLeft: "auto" }}>
          {enabled ? (
            <Button variant="ghost" onClick={() => { setDisabling(true); setError(null); setPassword(""); }}>
              Turn off
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void startSetup()} disabled={busy}>
              {busy ? <Spinner label="Starting" /> : "Set up"}
            </Button>
          )}
        </div>
      </div>
      {error && !setup && !disabling && (
        <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)", marginTop: 8 }}>
          {error}
        </div>
      )}

      {setup && (
        <Dialog
          open
          title="Set up two-factor authentication"
          onClose={() => setSetup(null)}
          actions={
            <>
              <Button variant="secondary" onClick={() => setSetup(null)} disabled={busy}>Cancel</Button>
              <Button variant="primary" onClick={() => void confirmEnable()} disabled={busy || code.length < 6}>
                {busy ? <Spinner label="Enabling" /> : "Turn on"}
              </Button>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p className="card-body" style={{ margin: 0 }}>
              In your authenticator app, add an account by entering this key manually
              (or paste the setup link), then type the current 6-digit code below.
            </p>
            <div>
              <div className="eyebrow" style={{ marginBottom: 4 }}>Setup key</div>
              <div
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 15,
                  letterSpacing: "0.08em",
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "var(--color-neutral-900)",
                  border: "1px solid var(--color-divider)",
                  userSelect: "all",
                  wordBreak: "break-all",
                }}
              >
                {groupedSecret}
              </div>
            </div>
            <details>
              <summary style={{ fontSize: 12, color: "var(--color-neutral-500)", cursor: "pointer" }}>
                Setup link (for apps that accept a pasted otpauth URI)
              </summary>
              <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, wordBreak: "break-all", marginTop: 6, userSelect: "all", color: "var(--color-neutral-400)" }}>
                {setup.otpauthUri}
              </div>
            </details>
            <Field
              label="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
              maxLength={7}
              autoFocus
              placeholder="123456"
            />
            {error && (
              <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)" }}>{error}</div>
            )}
          </div>
        </Dialog>
      )}

      {disabling && (
        <Dialog
          open
          title="Turn off two-factor?"
          onClose={() => setDisabling(false)}
          actions={
            <>
              <Button variant="secondary" onClick={() => setDisabling(false)} disabled={busy}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => void confirmDisable()}
                disabled={busy || !password}
                style={{ background: "var(--color-negative)", borderColor: "var(--color-negative)", color: "#fff" }}
              >
                {busy ? <Spinner label="Disabling" /> : "Turn off"}
              </Button>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p className="card-body" style={{ margin: 0 }}>
              Enter your account password to disable two-factor authentication.
            </p>
            <Field
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            {error && (
              <div role="alert" style={{ fontSize: 13, color: "var(--color-negative)" }}>{error}</div>
            )}
          </div>
        </Dialog>
      )}
    </Card>
  );
}

function SessionsSection() {
  const client = useApp((s) => s.client);
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [confirming, setConfirming] = useState<DeviceSession | null>(null);

  const reload = useCallback(() => {
    client
      .sessions()
      .then((r) => setSessions(r.sessions))
      .catch(() => setSessions([]));
  }, [client]);

  useEffect(reload, [reload]);

  const revoke = async (session: DeviceSession) => {
    await client.revokeSession(session.id).catch(() => {});
    setConfirming(null);
    reload();
  };

  return (
    <Card kicker="Security" title="Devices signed in to your account">
      {sessions === null ? (
        <Spinner label="Loading sessions" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Platform</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.deviceName}{" "}
                  {s.isCurrent && (
                    <Tag variant="accent" style={{ marginLeft: 6 }}>
                      this device
                    </Tag>
                  )}
                </td>
                <td style={{ textTransform: "capitalize" }}>{s.platform}</td>
                <td>{new Date(s.lastUsedAt).toLocaleString()}</td>
                <td style={{ textAlign: "right" }}>
                  {!s.isCurrent && (
                    <Button variant="ghost" onClick={() => setConfirming(s)}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Dialog
        open={confirming !== null}
        title="Revoke this device?"
        onClose={() => setConfirming(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => confirming && void revoke(confirming)}
            >
              Revoke access
            </Button>
          </>
        }
      >
        “{confirming?.deviceName}” will be signed out immediately and will need
        the account password to sign in again.
      </Dialog>
    </Card>
  );
}

function ServerSection() {
  const serverAddress = useApp((s) => s.serverAddress);
  const platform = useApp((s) => s.platform);
  const changeServer = useApp((s) => s.changeServer);
  const [confirmingChange, setConfirmingChange] = useState(false);

  const rePin = async () => {
    if (serverAddress) await platform.forgetPin(serverAddress);
    await changeServer();
  };

  return (
    <Card kicker="Server" title="Connection">
      <p className="card-body" style={{ fontFamily: "ui-monospace, monospace" }}>
        {serverAddress}
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="secondary" onClick={() => setConfirmingChange(true)}>
          Connect to a different server
        </Button>
        {platform.kind === "tauri" && (
          <Button variant="ghost" onClick={() => void rePin()}>
            Re-verify server identity
          </Button>
        )}
      </div>
      <p className="card-meta">
        Re-verify after rotating your server's TLS certificate — the stored
        fingerprint pin is cleared and confirmed again on the next connect.
      </p>
      <Dialog
        open={confirmingChange}
        title="Disconnect from this server?"
        onClose={() => setConfirmingChange(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmingChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void changeServer()}>
              Disconnect
            </Button>
          </>
        }
      >
        You'll be signed out on this device and asked for a new server address.
        Nothing on the server is affected.
      </Dialog>
    </Card>
  );
}
