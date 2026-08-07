import { Icon } from "@vault/ui";
import { useApp } from "../../state/store.js";
import { NAV_GROUPS, visiblePages, type GroupId, type PageId } from "./nav.js";

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
  return (
    <nav className="tabbar" aria-label="Sections">
      {NAV_GROUPS.map((g) => {
        const pages = visiblePages(g, aiVisible);
        const first = pages[0];
        if (!first) return null;
        const active = g.id === group;
        return (
          <button
            key={g.id}
            className="tab-item"
            data-active={active ? "true" : undefined}
            aria-current={active ? "page" : undefined}
            onClick={() => onSelectGroup(g.id, first.id)}
          >
            <span className="tab-item-icon">
              <Icon name={g.icon} size={21} />
            </span>
            {g.label}
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
