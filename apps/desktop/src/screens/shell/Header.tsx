import { Avatar, Button, Icon } from "@vault/ui";
import { useEffect, useRef, useState } from "react";
import type { LayoutMode } from "../../lib/useLayout.js";
import { useApp } from "../../state/store.js";
import type { PageId } from "./nav.js";
import { UpdateButton } from "./UpdateButton.js";

export function Header({
  title,
  mode,
  onOpenPalette,
  onNavigate,
}: {
  title: string;
  mode: LayoutMode;
  onOpenPalette: () => void;
  onNavigate: (page: PageId) => void;
}) {
  const user = useApp((s) => s.user);
  const aiVisible = useApp((s) => s.aiVisible);
  const signOut = useApp((s) => s.signOut);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const narrow = mode === "narrow";
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <header className="app-header">
      <div className="row" style={{ minWidth: 0, gap: "var(--space-3)" }}>
        <h1 className="truncate" style={{ font: "inherit", fontWeight: 600, fontSize: "var(--text-lg)", margin: 0 }}>
          {title}
        </h1>
      </div>

      <div className="row" style={{ gap: "var(--space-2)", flex: "none" }}>
        {narrow ? (
          <Button variant="ghost" icon="search" onClick={onOpenPalette} aria-label="Search" />
        ) : (
          <button className="search-trigger" onClick={onOpenPalette}>
            <Icon name="search" size={15} />
            <span style={{ flex: 1, textAlign: "left" }}>Search…</span>
            <span className="kbd">{mac ? "⌘" : "Ctrl"}</span>
            <span className="kbd">K</span>
          </button>
        )}

        {aiVisible && !narrow && (
          <Button variant="glass" icon="sparkle" onClick={() => onNavigate("assistant")}>
            Ask AI
          </Button>
        )}

        <UpdateButton />

        <div style={{ position: "relative" }} ref={menuRef}>
          <Avatar
            name={user?.displayName ?? "?"}
            color={user?.avatarColor ?? "var(--color-accent)"}
            size={32}
            title="Account"
            translucent
            onClick={() => setMenuOpen((v) => !v)}
          />
          {menuOpen && (
            <div className="menu" style={{ right: 0, top: "calc(100% + var(--space-2))" }}>
              <div className="menu-head">
                <div className="t-sm t-semibold truncate">{user?.displayName}</div>
                <div className="t-xs t-tertiary truncate">{user?.email}</div>
              </div>
              <button
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onNavigate("settings");
                }}
              >
                <Icon name="settings" size={16} />
                Settings
              </button>
              <div className="menu-sep" />
              <button className="menu-item menu-item-danger" onClick={() => void signOut()}>
                <Icon name="logout" size={16} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
