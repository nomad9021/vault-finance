export interface SkeletonProps {
  /** CSS length; number means px. */
  height?: number | string;
  width?: number | string;
  radius?: number | string;
  className?: string;
}

/** A shimmering placeholder block. Prefer this over a spinner for layout. */
export function Skeleton({ height = 16, width = "100%", radius, className }: SkeletonProps) {
  return (
    <div
      className={["skeleton", className].filter(Boolean).join(" ")}
      style={{ height, width, ...(radius !== undefined ? { borderRadius: radius } : {}) }}
    />
  );
}

/**
 * Stand-in for a list while it loads. Mirroring the real row height keeps the
 * page from jumping when the data lands.
 */
export function SkeletonList({ rows = 4, height = 44 }: { rows?: number; height?: number }) {
  return (
    <div className="stack-sm">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={height} />
      ))}
    </div>
  );
}
