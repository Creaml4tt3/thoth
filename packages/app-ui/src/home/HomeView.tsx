/**
 * Home (ADR-0029): the Thoth mark, a short greeting, the pages opened last ("Recent") and every favorite. A new tab
 * shows it too, so a new tab is never empty. Each row is a plain button: a click or Enter opens the page in this tab;
 * Cmd/Ctrl+click, a middle-click or Cmd/Ctrl+Enter opens it in a new tab (`open-keys.ts`, as the trees do). The parts
 * are headings and lists, not landmarks: the sidebar's Favorites is the region of that name.
 */
import { type KeyboardEvent, type MouseEvent } from "react";
import { PageIcon } from "../order/icons.tsx";
import { useStrings } from "../strings/index.ts";
import { clickOpens, isMiddleClick, isOpenInNewTabKey } from "../tabs/open-keys.ts";
import { Mark } from "../ui/Mark.tsx";
import { tipIfClipped } from "../ui/Tooltip.tsx";

export interface HomeRow {
  /** Unique in its list. */
  id: string;
  title: string;
  /** Its space: "Local", or the workspace's name. */
  space: string;
  /** A Private Space page: its badge is the Private Space's colour, else a workspace's. */
  local?: boolean;
  /** The folder it is in; absent at the top level. */
  folder?: string;
  /** Can't be checked now (signed out, still loading). */
  unavailable?: boolean;
  open(options: { newTab: boolean }): void;
}

function Rows({ rows, label }: { rows: readonly HomeRow[]; label: string }) {
  const t = useStrings().home;
  return (
    <ul className="home-list" aria-label={label}>
      {rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            className="home-row"
            data-unavailable={row.unavailable || undefined}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            onClick={(event: MouseEvent) => row.open({ newTab: clickOpens(event)?.newTab === true })}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault(); // no auto-scroll cursor
            }}
            onAuxClick={(event) => {
              if (!isMiddleClick(event)) return;
              event.preventDefault();
              row.open({ newTab: true });
            }}
            onKeyDown={(event: KeyboardEvent) => {
              if (!isOpenInNewTabKey(event)) return;
              event.preventDefault();
              row.open({ newTab: true });
            }}
          >
            <PageIcon />
            <span className="home-row-title" {...tipIfClipped(row.title)}>
              {row.title}
            </span>
            <span className="home-row-meta">
              <span className={`badge home-badge ${row.local ? "badge-private" : "badge-workspace"}`}>{row.space}</span>
              <span className="home-folder">{row.folder ?? t.topLevel}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function HomeView({ recent, favorites }: { recent: readonly HomeRow[]; favorites: readonly HomeRow[] }) {
  const t = useStrings().home;
  return (
    <div className="home" data-testid="home">
      <div className="home-inner">
        <header className="home-head">
          <Mark size={40} />
          <h1>{t.greeting}</h1>
          <p className="muted">{t.lead}</p>
        </header>
        <div className="home-section">
          <h2>{t.recent}</h2>
          {recent.length > 0 ? <Rows rows={recent} label={t.recent} /> : <p className="muted home-empty">{t.recentEmpty}</p>}
        </div>
        <div className="home-section home-favorites">
          <h2>{t.favorites}</h2>
          {favorites.length > 0 ? <Rows rows={favorites} label={t.favorites} /> : <p className="muted home-empty">{t.favoritesEmpty}</p>}
        </div>
      </div>
    </div>
  );
}
