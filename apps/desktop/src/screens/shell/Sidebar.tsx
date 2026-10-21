import { Icon } from "@vault/ui";
import { APP_VERSION, useApp } from "../../state/store.js";
import { AppMark } from "../AuthLayout.js";
import { NAV_GROUPS, visiblePages, type PageId } from "./nav.js";

/**
 * The wide-width navigation: groups as labelled sections.
 *
 * Section labels are what make eleven destinations feel like five decisions.
 * Without them this is just a long list again.
 */
export function Sidebar({ page, onNavigate }: { page: PageId; onNavigate: (p: PageId) => void }) {
  const user = useApp((s) => s.user);
  const aiVisible = useApp((s) => s.aiVisible);
  const householdName = useApp((s) => s.householdName);
  const collapsed = useApp((s) => s.navCollapsed);
  const setCollapsed = useApp((s) => s.setNavCollapsed);
  const setMini = useApp((s) => s.setSidebarMini);
  const toggle = (id: string) =>
    void setCollapsed(collapsed.includes(id) ? collapsed.filter((g) => g !== id) : [...collapsed, id]);

  return (
    <aside
      style={{
        width: "var(--sidebar-w)",
        flex: "none",
        borderRight: "1px solid var(--color-divider)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--color-bg)",
      }}
    >
      <div style={{ padding: "var(--space-5) var(--space-4) var(--space-4)" }}>
        <div className="brand">
          <div style={{ minWidth: 0 }}>
            <div className="brand-name truncate">Vault Finance</div>
            <div className="brand-sub truncate" title={householdName ?? undefined}>
              {householdName ?? "Household finance"}
            </div>
          </div>
        </div>
      </div>

      <nav
        style={{
          flex: 1,
          overflow: "auto",
          padding: "var(--space-2) var(--space-3) var(--space-4)",
        }}
        aria-label="Main"
      >
        {NAV_GROUPS.map((group) => {
          const all = visiblePages(group, aiVisible);
          if (all.length === 0) return null;
          const folded = collapsed.includes(group.id);
          // A folded group still shows the page you're on.
          const pages = folded ? all.filter((p) => p.id === page) : all;
          return (
            <div className="nav-group" key={group.id}>
              <button
                className="nav-group-label"
                onClick={() => toggle(group.id)}
                aria-expanded={!folded}
                title={folded ? `Show ${group.label}` : `Fold ${group.label}`}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: 0, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
              >
                <span>{group.label}</span>
                <Icon name={folded ? "chevronRight" : "chevronDown"} size={12} />
              </button>
              {pages.map((p) => (
                <button
                  key={p.id}
                  className="nav-item"
                  data-active={page === p.id ? "true" : undefined}
                  aria-current={page === p.id ? "page" : undefined}
                  onClick={() => onNavigate(p.id)}
                >
                  <span className="nav-item-icon">
                    <Icon name={p.icon} size={17} />
                  </span>
                  <span className="nav-item-label">{p.label}</span>
                </button>
              ))}
            </div>
          );
        })}
      </nav>

      <div
        style={{
          padding: "var(--space-3) var(--space-4)",
          borderTop: "1px solid var(--color-divider)",
        }}
        className="t-2xs t-tertiary"
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="truncate">{user?.displayName}</div>
            <div>Self-hosted · v{APP_VERSION}</div>
          </div>
          <button
            className="rail-item"
            onClick={() => void setMini(true)}
            aria-label="Shrink the sidebar to icons"
            title="Shrink the sidebar to icons"
            style={{ width: 30, height: 30 }}
          >
            <Icon name="chevronLeft" size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

/**
 * The medium-width navigation: the same groups collapsed to an icon rail.
 * Group boundaries survive as separators so the grouping isn't lost with the
 * labels, and each icon keeps its name in a hover tooltip.
 */
export function Rail({ page, onNavigate, expandable = false }: { page: PageId; onNavigate: (p: PageId) => void; expandable?: boolean }) {
  const aiVisible = useApp((s) => s.aiVisible);
  const setMini = useApp((s) => s.setSidebarMini);

  return (
    <aside
      style={{
        width: "var(--rail-w)",
        flex: "none",
        borderRight: "1px solid var(--color-divider)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "var(--space-4) 0",
        minHeight: 0,
        background: "var(--color-bg)",
      }}
    >
      <AppMark size={28} />
      <nav
        style={{
          flex: 1,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          marginTop: "var(--space-3)",
          width: "100%",
        }}
        aria-label="Main"
      >
        {NAV_GROUPS.map((group, gi) => {
          const pages = visiblePages(group, aiVisible);
          if (pages.length === 0) return null;
          return (
            <div key={group.id} style={{ display: "contents" }}>
              {gi > 0 && (
                <span
                  aria-hidden="true"
                  style={{
                    width: 24,
                    height: 1,
                    background: "var(--hairline)",
                    margin: "var(--space-2) 0",
                  }}
                />
              )}
              {pages.map((p) => (
                <button
                  key={p.id}
                  className="rail-item"
                  data-label={p.label}
                  data-active={page === p.id ? "true" : undefined}
                  aria-label={p.label}
                  aria-current={page === p.id ? "page" : undefined}
                  onClick={() => onNavigate(p.id)}
                >
                  <Icon name={p.icon} size={19} />
                </button>
              ))}
            </div>
          );
        })}
      </nav>
      {expandable && (
        <button className="rail-item" data-label="Show the full sidebar" aria-label="Show the full sidebar" onClick={() => void setMini(false)}>
          <Icon name="chevronRight" size={19} />
        </button>
      )}
    </aside>
  );
}
