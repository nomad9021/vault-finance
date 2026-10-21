export interface AvatarProps {
  name: string;
  /** Hex tint from the user's avatarColor. */
  color: string;
  /** Profile picture (a data: URL); falls back to the initial on the colour. */
  image?: string | null;
  size?: number;
  /** Render as a button (header account menu). */
  onClick?: () => void;
  title?: string;
  /**
   * Frosted rather than a solid disc of `color` — for chrome that sits on the
   * blurred header bar. The colour survives as a faint tint.
   */
  translucent?: boolean;
}

/** Initial-bubble avatar, used in the header, login profiles and member lists. */
export function Avatar({ name, color, image, size = 40, onClick, title, translucent = false }: AvatarProps) {
  const initial = image ? (
    <img src={image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%", display: "block" }} />
  ) : (
    (name.trim()[0] ?? "?").toUpperCase()
  );
  const style = translucent
    ? {
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        // .avatar-glass mixes this down to a tint; it must not paint the disc.
        ["--avatar-tint" as string]: color,
      }
    : {
        width: size,
        height: size,
        background: color,
        fontSize: Math.round(size * 0.4),
      };
  const cls = translucent ? "avatar avatar-glass" : "avatar";
  const shown = image ? { ...style, overflow: "hidden", padding: 0 } : style;
  if (onClick) {
    return (
      <button className={cls} style={shown} onClick={onClick} aria-label={title ?? name} type="button">
        {initial}
      </button>
    );
  }
  return (
    <span className={cls} style={shown} aria-hidden="true">
      {initial}
    </span>
  );
}
