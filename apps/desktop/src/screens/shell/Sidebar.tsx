import { Icon } from "@vault/ui";
import { useApp } from "../../state/store.js";
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
          <AppMark size={28} />
          <div style={{ minWidth: 0 }}>
            <div className="brand-name truncate">Vault Finance</div>
            <div className="brand-sub">Household finance</div>
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
          const pages = visiblePages(group, aiVisible);
          if (pages.length === 0) return null;
          return (
            <div className="nav-group" key={group.id}>
              <div className="nav-group-label">{group.label}</div>
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
        <div className="truncate">{user?.displayName}</div>
        <div>Self-hosted · v0.1</div>
      </div>
    </aside>
  );
}

/**
 * The medium-width navigation: the same groups collapsed to an icon rail.
 * Group boundaries survive as separators so the grouping isn't lost with the
 * labels, and each icon keeps its name in a hover tooltip.
 */
export function Rail({ page, onNavigate }: { page: PageId; onNavigate: (p: PageId) => void }) {
  const aiVisible = useApp((s) => s.aiVisible);

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
    </aside>
  );
}
