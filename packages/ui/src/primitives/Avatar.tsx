export interface AvatarProps {
  name: string;
  /** Hex tint from the user's avatarColor. */
  color: string;
  size?: number;
  /** Render as a button (header account menu). */
  onClick?: () => void;
  title?: string;
}

/** Initial-bubble avatar, used in the header, login profiles and member lists. */
export function Avatar({ name, color, size = 40, onClick, title }: AvatarProps) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  const style = {
    width: size,
    height: size,
    background: color,
    fontSize: Math.round(size * 0.4),
  };
  if (onClick) {
    return (
      <button className="avatar" style={style} onClick={onClick} aria-label={title ?? name} type="button">
        {initial}
      </button>
    );
  }
  return (
    <span className="avatar" style={style} aria-hidden="true">
      {initial}
    </span>
  );
}
