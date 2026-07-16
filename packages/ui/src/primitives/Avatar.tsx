export interface AvatarProps {
  name: string;
  /** Hex tint from the user's avatarColor. */
  color: string;
  size?: number;
}

/** Initial-bubble avatar, as used across the design's login and header. */
export function Avatar({ name, color, size = 40 }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        fontSize: size * 0.4,
        color: "var(--color-accent-100)",
        flex: "none",
      }}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
