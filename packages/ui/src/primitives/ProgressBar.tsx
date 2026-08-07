export interface ProgressBarProps {
  /** 0–1. Values above 1 are clamped; pass `over` to colour the overage. */
  value: number;
  /** Bar colour. Defaults to the accent, or the negative tone when over. */
  color?: string;
  over?: boolean;
  small?: boolean;
  label?: string;
}

/**
 * Budget / goal / allocation bar. Width and fill come through CSS custom
 * properties rather than inline styles so the animation and radius stay in
 * the stylesheet where the rest of the design lives.
 */
export function ProgressBar({ value, color, over = false, small = false, label }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const fill = over ? "var(--color-negative)" : (color ?? "var(--color-accent)");
  return (
    <div
      className={small ? "bar bar-sm" : "bar"}
      role="progressbar"
      aria-valuenow={Math.round(pct * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      style={{ ["--bar-pct" as string]: `${pct * 100}%`, ["--bar-fill" as string]: fill }}
    >
      <i />
    </div>
  );
}
