/** Three blinking dots (the design's `blink` keyframe), for inline waits. */
export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--color-accent)",
            animation: `blink 1.2s ${i * 0.2}s infinite`,
          }}
        />
      ))}
    </span>
  );
}
