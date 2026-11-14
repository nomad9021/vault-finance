import { Icon } from "@vault/ui";
import { useApp } from "../../state/store.js";
import { NAV_GROUPS, visiblePages, type GroupId, type NavGroup, type NavPage, type PageId } from "./nav.js";

/**
 * The last group ("More" in the sidebar) opens on the AI assistant, so on the
 * phone its tab says so. With the assistant switched off it opens Settings.
 */
function tabLook(g: NavGroup, first: NavPage): { label: string; icon: NavGroup["icon"] } {
  if (g.id !== "more") return { label: g.label, icon: g.icon };
  return first.ai ? { label: "AI", icon: first.icon } : { label: first.label, icon: first.icon };
}

/**
 * The narrow-width navigation: one tab per group, exactly like the phone
 * viewer's. Tapping a group lands on its first page; the pages themselves
 * appear as a tab strip at the top of the content (see GroupTabs).
 */
export function TabBar({
  group,
  onSelectGroup,
}: {
  group: GroupId;
  onSelectGroup: (g: GroupId, firstPage: PageId) => void;
}) {
  const aiVisible = useApp((s) => s.aiVisible);
  const shown = NAV_GROUPS.filter((g) => visiblePages(g, aiVisible).length > 0);
  const index = Math.max(0, shown.findIndex((g) => g.id === group));
  return (
    <nav
      className="tabbar"
      aria-label="Sections"
      style={{ ["--tab-index" as string]: index, ["--tab-count" as string]: shown.length }}
    >
      {/* The selected lozenge, gliding between tabs (components.css). */}
      <span className="tabbar-indicator" aria-hidden="true" />
      {NAV_GROUPS.map((g) => {
        const pages = visiblePages(g, aiVisible);
        const first = pages[0];
        if (!first) return null;
        const active = g.id === group;
        const tab = tabLook(g, first);
        return (
          <button
            key={g.id}
            className="tab-item"
            data-active={active ? "true" : undefined}
            aria-current={active ? "page" : undefined}
            onClick={() => onSelectGroup(g.id, first.id)}
          >
            <span className="tab-item-icon">
              <Icon name={tab.icon} size={21} />
            </span>
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * The pages of the current group, as a top tab strip. This is the narrow-width
 * stand-in for the sidebar's section — the second level of the same hierarchy,
 * so nothing becomes unreachable when the sidebar disappears.
 */
export function GroupTabs({
  group,
  page,
  onNavigate,
}: {
  group: GroupId;
  page: PageId;
  onNavigate: (p: PageId) => void;
}) {
  const aiVisible = useApp((s) => s.aiVisible);
  const meta = NAV_GROUPS.find((g) => g.id === group);
  const pages = meta ? visiblePages(meta, aiVisible) : [];
  // A single-page group (Home) needs no strip.
  if (pages.length <= 1) return null;

  return (
    <div className="tabs no-scrollbar" role="tablist" aria-label={meta?.label}>
      {pages.map((p) => (
        <button
          key={p.id}
          className="tab"
          role="tab"
          aria-selected={p.id === page}
          data-active={p.id === page ? "true" : undefined}
          onClick={() => onNavigate(p.id)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
