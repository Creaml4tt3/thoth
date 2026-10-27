import type { ReactNode } from "react";

/**
 * The icons of toolbars and icon buttons: hand-drawn on a 24-unit grid, shown at 16px, 1.8 stroke, round caps, `currentColor`
 * (the same style as the gear and the folder icons in the sidebar). Decorative: the button around one carries the name.
 */
export type IconName = "page-plus" | "folder-plus" | "plus" | "close" | "gear" | "sparkle" | "select" | "done" | "blocks" | "text" | "copy" | "move-in" | "sign-out" | "shrink" | "expand" | "bell" | "grip" | "people" | "open-tab" | "star" | "pin" | "share" | "import" | "home" | "sidebar";

const DRAWINGS: Record<IconName, ReactNode> = {
  /** A house: Home (ADR-0029). */
  home: (
    <>
      <path d="M4 11l8-7 8 7" />
      <path d="M6 9.5V20h12V9.5" />
      <path d="M10 20v-5.5h4V20" />
    </>
  ),
  /** A window with a panel on its left: the sidebar, hidden or shown. */
  sidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  /** A five-pointed star: a favorite (ADR-0027). Filled by CSS when pressed (`.icon-star-fill`). */
  star: <path className="icon-star" d="M12 3.6l2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.62l-5.1 2.68.97-5.68L3.75 9.6l5.7-.83z" />,
  /** A push pin: a pinned tab. */
  pin: (
    <>
      <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z" />
      <path d="M12 14v6" />
    </>
  ),
  /** Six dots: something that can be dragged to a new place (a sidebar section's handle). */
  grip: (
    <>
      <circle cx="9" cy="6" r="0.6" />
      <circle cx="15" cy="6" r="0.6" />
      <circle cx="9" cy="12" r="0.6" />
      <circle cx="15" cy="12" r="0.6" />
      <circle cx="9" cy="18" r="0.6" />
      <circle cx="15" cy="18" r="0.6" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
      <path d="M15.5 5.2a3.2 3.2 0 0 1 0 6" />
      <path d="M17.5 14.2a5.5 5.5 0 0 1 3 5.3" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
      <path d="M10 21a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  "page-plus": (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M12 12v6M9 15h6" />
    </>
  ),
  "folder-plus": (
    <>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </>
  ),
  select: (
    <>
      <path d="M9 11.5l3 3 7.5-7.5" />
      <path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  done: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  blocks: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  text: <path d="M4 6h16M4 12h16M4 18h10" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  "move-in": (
    <>
      <path d="M12 3v12M7 10.5l5 4.5 5-4.5" />
      <path d="M4 20h16" />
    </>
  ),
  shrink: (
    <>
      <path d="M4 14h6v6M20 10h-6V4" />
      <path d="M10 14l-6 6M14 10l6-6" />
    </>
  ),
  expand: (
    <>
      <path d="M14 4h6v6M10 20H4v-6" />
      <path d="M20 4l-6 6M4 20l6-6" />
    </>
  ),
  // A page with an arrow leaving it: "open this in a tab of its own".
  "open-tab": (
    <>
      <path d="M13.5 4H20v6.5" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </>
  ),
  "sign-out": (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5M21 12H9" />
    </>
  ),
  // An arrow leaving a tray: "send this page out".
  share: (
    <>
      <path d="M12 15V3.5M7.5 8L12 3.5 16.5 8" />
      <path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    </>
  ),
  // An arrow coming down into a tray: "bring pages in".
  import: (
    <>
      <path d="M12 3.5V15M7.5 10.5L12 15l4.5-4.5" />
      <path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {DRAWINGS[name]}
    </svg>
  );
}
