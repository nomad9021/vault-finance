export interface AvatarProps {
  name: string;
  /** Hex tint from the user's avatarColor. */
  color: string;
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
export function Avatar({ name, color, size = 40, onClick, title, translucent = false }: AvatarProps) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
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
  if (onClick) {
    return (
      <button className={cls} style={style} onClick={onClick} aria-label={title ?? name} type="button">
        {initial}
      </button>
    );
  }
  return (
    <span className={cls} style={style} aria-hidden="true">
      {initial}
    </span>
  );
}
