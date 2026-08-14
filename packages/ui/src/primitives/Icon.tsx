import type { SVGProps } from "react";

/**
 * The Vault icon set.
 *
 * Hand-drawn on a 24×24 grid with a 1.75 stroke, round caps and round joins,
 * so every glyph shares one weight and one corner language. Everything is
 * `currentColor` and inherits size from the `size` prop, which means an icon
 * always matches the text it sits next to.
 *
 * These are inline paths on purpose: the app makes no third-party network
 * requests, so an icon font or a CDN sprite is not an option, and shipping our
 * own set keeps the bundle at a couple of KB.
 */

const PATHS = {
  // ── navigation ──────────────────────────────────────────────────────────
  home: "M3 10.6 12 3.5l9 7.1M5.6 9.6V19a1.6 1.6 0 0 0 1.6 1.6h9.6A1.6 1.6 0 0 0 18.4 19V9.6",
  bank: "M3.2 9.4 12 4.2l8.8 5.2M5.5 11v7M9.8 11v7M14.2 11v7M18.5 11v7M3 20.5h18",
  card: "M3 7.5A2.5 2.5 0 0 1 5.5 5h13A2.5 2.5 0 0 1 21 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9ZM3 10h18M6.5 15h3",
  income: "M4 16.8 9.6 11.2l3.4 3.4L20 7.6M15 7.6h5v5",
  target: "M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6ZM12 7.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8ZM12 11.4a.6.6 0 1 0 0 1.2.6.6 0 0 0 0-1.2Z",
  layers: "M12 3.4 3.2 8 12 12.6 20.8 8 12 3.4ZM3.2 12.6 12 17.2l8.8-4.6M3.2 17.2 12 21.8l8.8-4.6",
  receipt: "M5.8 3.4h12.4v17.2l-3.1-1.9-3.1 1.9-3.1-1.9-3.1 1.9V3.4ZM9 8.4h6M9 12.4h6",
  flow: "M3.4 20V4.6M3.4 20h17M7 16.4l4-4.6 3.4 2.8L20 7.4M20 7.4h-3.6M20 7.4V11",
  invest: "M4.6 20.4V13M9.8 20.4V7.6M15 20.4v-4.8M20.2 20.4V4.2",
  flag: "M6 21V4.2M6 4.6h9.6l-1.8 3.4 1.8 3.4H6",
  gift:
    "M4 11.4h16v8.2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8.2ZM3 7.6h18v3.8H3V7.6ZM12 7.6v13M12 7.6S10.4 3.4 8.2 3.4a2.1 2.1 0 0 0 0 4.2H12ZM12 7.6s1.6-4.2 3.8-4.2a2.1 2.1 0 0 1 0 4.2H12Z",
  report: "M6.4 2.8h7.4l4.4 4.4v13.2a.8.8 0 0 1-.8.8H6.4a.8.8 0 0 1-.8-.8V3.6a.8.8 0 0 1 .8-.8ZM13.6 3v4.4H18M8.8 12.4h6.4M8.8 16.4h6.4",
  sparkle: "M12 3.2 13.7 9l5.8 1.7-5.8 1.7L12 18.2l-1.7-5.8-5.8-1.7L10.3 9 12 3.2ZM18.6 16.4l.7 2.2 2.2.7-2.2.7-.7 2.2-.7-2.2-2.2-.7 2.2-.7.7-2.2Z",
  settings:
    "M12 8.9a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2ZM19.2 14.4a1.5 1.5 0 0 0 .3 1.6l.1.1a1.8 1.8 0 1 1-2.5 2.5l-.1-.1a1.5 1.5 0 0 0-2.6 1v.2a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-2.7-1l-.1.1a1.8 1.8 0 1 1-2.5-2.5l.1-.1a1.5 1.5 0 0 0-1-2.6h-.2a1.8 1.8 0 1 1 0-3.6h.1a1.5 1.5 0 0 0 1-2.7l-.1-.1a1.8 1.8 0 1 1 2.5-2.5l.1.1a1.5 1.5 0 0 0 1.6.3h.1a1.5 1.5 0 0 0 .9-1.4v-.2a1.8 1.8 0 1 1 3.6 0v.1a1.5 1.5 0 0 0 2.6 1l.1-.1a1.8 1.8 0 1 1 2.5 2.5l-.1.1a1.5 1.5 0 0 0-.3 1.6v.1a1.5 1.5 0 0 0 1.4.9h.2a1.8 1.8 0 1 1 0 3.6h-.1a1.5 1.5 0 0 0-1.4.9Z",
  scale:
    "M12 3.4v17.2M7.2 5.6h9.6M4.4 20.6h15.2M6.6 6 3.4 13h6.4L6.6 6ZM17.4 6 14.2 13h6.4L17.4 6Z",
  wallet:
    "M3.4 7.6A2.2 2.2 0 0 1 5.6 5.4h11.8a2.2 2.2 0 0 1 2.2 2.2v9.2a2.2 2.2 0 0 1-2.2 2.2H5.6a2.2 2.2 0 0 1-2.2-2.2V7.6ZM16 11.6h4.6v3.2H16a1.6 1.6 0 1 1 0-3.2Z",

  // ── actions & controls ──────────────────────────────────────────────────
  search: "M11 4.4a6.6 6.6 0 1 0 0 13.2 6.6 6.6 0 0 0 0-13.2ZM15.8 15.8l4 4",
  plus: "M12 5.4v13.2M5.4 12h13.2",
  minus: "M5.4 12h13.2",
  close: "M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8",
  check: "M4.8 12.6l4.8 4.8L19.2 7.2",
  menu: "M4 7h16M4 12h16M4 17h16",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  filter: "M3.6 5.4h16.8l-6.6 7.8v5.6l-3.6 2v-7.6L3.6 5.4Z",
  calendar:
    "M5.6 5.6h12.8a1.2 1.2 0 0 1 1.2 1.2v12a1.2 1.2 0 0 1-1.2 1.2H5.6a1.2 1.2 0 0 1-1.2-1.2v-12a1.2 1.2 0 0 1 1.2-1.2ZM8.4 3.4v4M15.6 3.4v4M4.4 10.4h15.2",
  edit: "M4.4 19.6h3.4L18.2 9.2a2.4 2.4 0 0 0-3.4-3.4L4.4 16.2v3.4ZM13.8 6.8l3.4 3.4",
  trash: "M4.8 6.6h14.4M9.4 6.6V4.8a1 1 0 0 1 1-1h3.2a1 1 0 0 1 1 1v1.8M6.6 6.6l.9 12.6a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l.9-12.6M10 10.4v5.6M14 10.4v5.6",
  download: "M12 3.8v11.4M7.6 11l4.4 4.4L16.4 11M4.6 19.8h14.8",
  upload: "M12 15.2V3.8M7.6 8.2 12 3.8l4.4 4.4M4.6 19.8h14.8",
  external: "M14 4.4h5.6V10M19.6 4.4 11 13M17 13.6v5a1 1 0 0 1-1 1H5.4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5",
  lock: "M6.6 10.4h10.8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6.6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1ZM8.4 10.2V7.8a3.6 3.6 0 0 1 7.2 0v2.4",
  user: "M12 3.8a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6ZM4.6 20.4a7.4 7.4 0 0 1 14.8 0",
  logout: "M9.4 20.2H5.6a1.2 1.2 0 0 1-1.2-1.2V5a1.2 1.2 0 0 1 1.2-1.2h3.8M15 16.4l4.6-4.4L15 7.6M19.4 12H9",
  refresh:
    "M20 12a8 8 0 1 1-2.6-5.9M20 4.2V9h-4.8",
  sun: "M12 7.4a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2ZM12 2.6v2M12 19.4v2M4.6 12h-2M21.4 12h-2M6.5 6.5 5.1 5.1M18.9 18.9l-1.4-1.4M6.5 17.5l-1.4 1.4M18.9 5.1l-1.4 1.4",
  moon: "M20 13.6A8.4 8.4 0 0 1 10.4 4a8.4 8.4 0 1 0 9.6 9.6Z",

  // ── directional ─────────────────────────────────────────────────────────
  chevronRight: "M9.4 5.6 15.8 12l-6.4 6.4",
  chevronLeft: "M14.6 5.6 8.2 12l6.4 6.4",
  chevronDown: "M5.6 9.4 12 15.8l6.4-6.4",
  chevronUp: "M5.6 14.6 12 8.2l6.4 6.4",
  arrowRight: "M4.4 12h15.2M13.6 6l6 6-6 6",
  arrowLeft: "M19.6 12H4.4M10.4 6l-6 6 6 6",
  arrowUp: "M12 19.6V4.4M6 10.4l6-6 6 6",
  arrowDown: "M12 4.4v15.2M6 13.6l6 6 6-6",
  trendUp: "M4 16.8 9.6 11.2l3.4 3.4L20 7.6M15 7.6h5v5",
  trendDown: "M4 7.6 9.6 13.2l3.4-3.4L20 16.8M15 16.8h5v-5",

  // ── status ──────────────────────────────────────────────────────────────
  alert: "M12 4.2 2.8 20h18.4L12 4.2ZM12 10v4.2M12 17.2h.01",
  info: "M12 3.4a8.6 8.6 0 1 0 0 17.2 8.6 8.6 0 0 0 0-17.2ZM12 11v5.4M12 7.8h.01",
  clock: "M12 3.4a8.6 8.6 0 1 0 0 17.2 8.6 8.6 0 0 0 0-17.2ZM12 7v5.4l3.4 2",
  inbox:
    "M3.6 13.4 6.2 5a1.2 1.2 0 0 1 1.1-.8h9.4a1.2 1.2 0 0 1 1.1.8l2.6 8.4M3.6 13.4v5a1.2 1.2 0 0 0 1.2 1.2h14.4a1.2 1.2 0 0 0 1.2-1.2v-5M3.6 13.4h4.6l1.2 2.4h5.2l1.2-2.4h4.6",
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Edge length in px; the stroke scales with it so weight stays even. */
  size?: number;
}

export function Icon({ name, size = 18, strokeWidth, ...rest }: IconProps & { strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      // Scale the stroke a little at small sizes so 14px icons don't go faint.
      strokeWidth={strokeWidth ?? (size <= 16 ? 1.9 : 1.75)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Names, for callers that want to validate or enumerate (e.g. nav configs). */
export const ICON_NAMES = Object.keys(PATHS) as IconName[];
