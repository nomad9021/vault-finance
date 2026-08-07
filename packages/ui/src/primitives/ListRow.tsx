import type { ReactNode } from "react";
import { Icon } from "./Icon.js";

export interface ListRowProps {
  /** Colour swatch, icon tile, or avatar shown at the leading edge. */
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned value — usually an amount. */
  trailing?: ReactNode;
  /** Second, quieter line under the trailing value. */
  trailingSub?: ReactNode;
  onClick?: () => void;
  /** Show a chevron to signal the row drills in. Implied by `onClick`. */
  chevron?: boolean;
}

/**
 * The atom of every list in the app — transactions, accounts, bills, holdings.
 * Both shells render the same shape, which is most of why a phone list and a
 * desktop list feel like the same product.
 */
export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  trailingSub,
  onClick,
  chevron,
}: ListRowProps) {
  const showChevron = chevron ?? !!onClick;
  const inner = (
    <>
      {leading}
      <div className="list-row-main">
        <div className="list-row-title">{title}</div>
        {subtitle && <div className="list-row-sub">{subtitle}</div>}
      </div>
      {(trailing || trailingSub) && (
        <div style={{ textAlign: "right", flex: "none" }}>
          {trailing && <div className="list-row-amount">{trailing}</div>}
          {trailingSub && <div className="list-row-sub">{trailingSub}</div>}
        </div>
      )}
      {showChevron && (
        <Icon name="chevronRight" size={16} style={{ color: "var(--content-tertiary)", flex: "none" }} />
      )}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className="list-row" onClick={onClick}>
        {inner}
      </button>
    );
  }
  return <div className="list-row">{inner}</div>;
}
