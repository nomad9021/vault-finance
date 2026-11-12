import type { ReactNode } from "react";

/**
 * Centered card on the radial-glow ground — the design's login/splash
 * treatment (design/reference/Finance App v3.dc.html, isLogin block).
 */
export function AuthLayout({ children, width = 380 }: { children: ReactNode; width?: number }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background:
          "radial-gradient(900px 500px at 50% -10%, color-mix(in srgb, var(--color-section) 45%, var(--color-bg)) 0%, var(--color-bg) 70%)",
        display: "flex",
        // Clear the iPhone notch / home indicator (env() is 0 on desktop).
        padding:
          "max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left))",
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

/** The gradient app mark used on the login card and sidebar. */
export function AppMark({ size = 40 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        background:
          "linear-gradient(135deg, var(--color-accent) 0%, var(--color-section-glow) 100%)",
        boxShadow: "0 0 20px color-mix(in srgb, var(--color-accent) 45%, transparent)",
        display: "inline-block",
        flex: "none",
      }}
    />
  );
}

export function AuthHeading({ title, subtitle }: { title: string; subtitle: string }) {
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
      <AppMark />
      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: "var(--text-xl)" }}>
        {title}
      </div>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--content-tertiary)" }}>{subtitle}</div>
    </div>
  );
}
