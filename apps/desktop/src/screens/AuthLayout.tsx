import type { ReactNode } from "react";

/** Centered card on the plain page ground: the sign-in / splash treatment. */
export function AuthLayout({ children, width = 380 }: { children: ReactNode; width?: number }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--color-bg)",
        display: "flex",
        // Clear the iPhone notch / home indicator (env() is 0 on desktop).
        padding:
          "max(20px, var(--safe-top)) max(20px, var(--safe-right)) max(20px, var(--safe-bottom)) max(20px, var(--safe-left))",
        overflow: "auto",
      }}
    >
      <div
        style={{
          // margin:auto centres like align/justify-center, but when the card is
          // taller than the view (phone keyboard open) its top stays reachable
          // instead of being pushed above the scroll area.
          margin: "auto",
          width,
          maxWidth: "100%",
          background: "var(--color-surface)",
          border: "1px solid var(--color-divider)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-lg)",
          padding: 28,
          animation: "fadeUp .3s both",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The app icon, light or dark to match the theme (--app-icon in
 * tokens.css), used on the sign-in card and in the sidebar.
 */
export function AppMark({ size = 40 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        backgroundImage: "var(--app-icon)",
        backgroundSize: "cover",
        display: "inline-block",
        flex: "none",
      }}
    />
  );
}

export function AuthHeading({
  title,
  subtitle,
  mark,
}: {
  title: string;
  subtitle: string;
  /** Replaces the app icon, e.g. the padlock on the lock screen. */
  mark?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        marginBottom: 22,
        textAlign: "center",
      }}
    >
      {mark ?? <AppMark />}
      <h1 className="auth-title">{title}</h1>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--content-tertiary)" }}>{subtitle}</div>
    </div>
  );
}
