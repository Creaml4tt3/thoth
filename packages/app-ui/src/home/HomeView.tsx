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

/** The Today card (ADR-0050): today's date in the reader's language, and whether today's page exists yet. */
export interface HomeToday {
  date: string;
  exists: boolean;
  /** Set when the last try to make the page failed. */
  error?: string | null;
  open(options: { newTab: boolean }): void;
}

function TodayCard({ today }: { today: HomeToday }) {
  const t = useStrings().home;
  return (
    <div className="home-section home-today">
      <h2>{t.today}</h2>
      <button
        type="button"
        className="home-row home-today-card"
        aria-describedby="home-today-template"
        aria-keyshortcuts="Control+Enter Meta+Enter"
        onClick={(event: MouseEvent) => today.open({ newTab: clickOpens(event)?.newTab === true })}
        onKeyDown={(event: KeyboardEvent) => {
          if (!isOpenInNewTabKey(event)) return;
          event.preventDefault();
          today.open({ newTab: true });
        }}
      >
        <PageIcon />
        <span className="home-row-title">{today.date}</span>
        <span className="home-row-meta">{today.exists ? t.openToday : t.startToday}</span>
      </button>
      <p id="home-today-template" className="muted home-empty">{t.todayTemplate}</p>
      {today.error && (
        <p className="home-empty" role="alert">
          {t.todayFailed(today.error)}
        </p>
      )}
    </div>
  );
}

export function HomeView({ recent, favorites, today }: { recent: readonly HomeRow[]; favorites: readonly HomeRow[]; today?: HomeToday }) {
  const t = useStrings().home;
  return (
    <div className="home" data-testid="home">
      <div className="home-inner">
        <header className="home-head">
          <Mark size={40} />
          <h1>{t.greeting}</h1>
          <p className="muted">{t.lead}</p>
        </header>
        {today && <TodayCard today={today} />}
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
