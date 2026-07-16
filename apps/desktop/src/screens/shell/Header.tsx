import { Button, Tag } from "@vault/ui";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../state/store.js";
import type { PageId } from "./AppShell.js";

export function Header({
  title,
  onToggleSidebar,
  onNavigate,
}: {
  title: string;
  onToggleSidebar: () => void;
  onNavigate: (page: PageId) => void;
}) {
  const user = useApp((s) => s.user);
  const signOut = useApp((s) => s.signOut);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const fullDate = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <header
      style={{
        height: 58,
        flex: "none",
        borderBottom: "1px solid var(--color-divider)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "0 16px 0 12px",
        background: "color-mix(in srgb, var(--color-bg) 88%, transparent)",
        backdropFilter: "blur(12px)",
        position: "relative",
        zIndex: 50,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <Button
          variant="ghost"
          onClick={onToggleSidebar}
          aria-label="Toggle navigation"
          title="Toggle navigation"
          style={{ fontSize: 16, padding: "6px 10px" }}
        >
          ☰
        </Button>
        <h1
          style={{
            fontSize: 17,
            fontWeight: 600,
            margin: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            letterSpacing: "-.01em",
          }}
        >
          {title}
        </h1>
        <Tag variant="neutral" style={{ whiteSpace: "nowrap" }}>
          {fullDate}
        </Tag>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
        <Button
          variant="primary"
          style={{ whiteSpace: "nowrap" }}
          onClick={() => onNavigate("assistant")}
        >
          ✦ Ask AI
        </Button>
        <div style={{ position: "relative" }} ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Account"
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              border: "1px solid var(--color-divider)",
              cursor: "pointer",
              background: user?.avatarColor ?? "var(--color-accent-800)",
              color: "var(--color-accent-100)",
              fontWeight: 600,
              fontSize: 13,
              fontFamily: "var(--font-body)",
            }}
          >
            {(user?.displayName.trim()[0] ?? "?").toUpperCase()}
          </button>
          {menuOpen && (
            <div
              style={{
                position: "absolute",
                right: 0,
                top: "calc(100% + 8px)",
                zIndex: 60,
                background: "var(--color-surface)",
                border: "1px solid var(--color-divider)",
                borderRadius: 10,
                boxShadow: "var(--shadow-lg)",
                minWidth: 190,
                padding: 6,
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--color-divider)",
                  marginBottom: 4,
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13 }}>{user?.displayName}</div>
                <div style={{ fontSize: 11.5, color: "var(--color-neutral-500)" }}>
                  {user?.email}
                </div>
              </div>
              <Button
                variant="ghost"
                style={{ justifyContent: "flex-start", width: "100%", fontSize: 13 }}
                onClick={() => {
                  setMenuOpen(false);
                  onNavigate("settings");
                }}
              >
                Account settings
              </Button>
              <Button
                variant="ghost"
                style={{ justifyContent: "flex-start", width: "100%", fontSize: 13 }}
                onClick={() => void signOut()}
              >
                Switch user / sign out
              </Button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
