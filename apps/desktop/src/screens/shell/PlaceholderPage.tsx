import { Tag } from "@vault/ui";

/** Stand-in for modules that land in M3–M5, so navigation is honest about scope. */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 320,
        gap: 12,
        textAlign: "center",
      }}
    >
      <Tag variant="outline">coming soon</Tag>
      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 18 }}>
        {title} isn't built yet
      </div>
      <p className="text-muted" style={{ fontSize: 13, maxWidth: 380 }}>
        This module arrives in an upcoming milestone. The navigation is wired
        so the shell matches the full design from day one.
      </p>
    </div>
  );
}
