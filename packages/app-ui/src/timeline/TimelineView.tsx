/**
 * Timeline (ADR-0051 rules 14–17): the pages of one space by date, newest first, under a heading per day. Each row
 * shows the title, folder, time and tags, and opens the page the way Home's rows do (click or Enter in this tab;
 * Cmd/Ctrl+click, middle-click or Cmd/Ctrl+Enter in a new tab). Edited / Dated and the tags are labelled groups of
 * toggle buttons; after a change the number of pages shown is said politely. The desktop app (Private Space and
 * workspaces) and the web client (workspaces) give it their spaces as `sources`; it never reads a page.
 */
import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { PageIcon } from "../order/icons.tsx";
import { useStrings } from "../strings/index.ts";
import { clickOpens, isMiddleClick, isOpenInNewTabKey } from "../tabs/open-keys.ts";
import { tipIfClipped } from "../ui/Tooltip.tsx";
import { dayLabel, groupTimeline, tagsOf, timeLabel, type TimelineItem, type TimelineMode } from "./timeline.ts";

export interface TimelineSource {
  /** Unique among the sources. */
  id: string;
  /** "Private Space", or the workspace's name. */
  label: string;
  /** Null while loading. */
  items: readonly TimelineItem[] | null;
  /** Tags and dates are known (always in the Private Space; a workspace on a server with `page-tags`). */
  tags: boolean;
  error?: string | null;
  /** Called when the source is shown (a workspace's tree starts loading). */
  load?(): void;
  open(item: TimelineItem, options: { newTab: boolean }): void;
}

const MODES: TimelineMode[] = ["edited", "dated"];

export function TimelineView({ sources, now = new Date() }: { sources: readonly TimelineSource[]; now?: Date }) {
  const strings = useStrings();
  const t = strings.timeline;
  const [source, setSource] = useState<string | null>(null);
  const shown = sources.find((s) => s.id === source) ?? sources[0];
  const load = shown?.load;
  useEffect(() => load?.(), [shown?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [mode, setMode] = useState<TimelineMode>("edited");
  const [wanted, setWanted] = useState<string[]>([]);
  const [said, setSaid] = useState("");
  const [changed, setChanged] = useState(0);
  // Another space has other tags: start again from all its pages.
  useEffect(() => setWanted([]), [shown?.id]);

  const tagged = shown?.tags === true;
  const effectiveMode: TimelineMode = tagged ? mode : "edited";
  const items = shown?.items ?? null;
  const allTags = useMemo(() => (tagged && items ? tagsOf(items) : []), [tagged, items]);
  const active = wanted.filter((tag) => allTags.includes(tag));
  const days = useMemo(() => (items ? groupTimeline(items, effectiveMode, active) : []), [items, effectiveMode, active.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = days.reduce((n, d) => n + d.rows.length, 0);
  // Dated moves only pages that name a date; with none, the list is Edited's, and the switch would seem to do nothing.
  const undated = effectiveMode === "dated" && total > 0 && days.every((d) => d.rows.every((r) => r.timed));

  // Said after a filter changes (rule 17), not on every reload of the list.
  useEffect(() => {
    if (changed > 0) setSaid(t.count(total));
  }, [changed]); // eslint-disable-line react-hooks/exhaustive-deps
  const touch = () => setChanged((n) => n + 1);

  const toggleTag = (tag: string) => {
    setWanted((list) => (list.includes(tag) ? list.filter((x) => x !== tag) : [...list, tag]));
    touch();
  };

  return (
    <div className="home timeline" data-testid="timeline">
      <div className="home-inner">
        <header className="home-head">
          <h1>{t.title}</h1>
          <p className="muted">{t.lead}</p>
        </header>
        <div className="timeline-controls">
          {sources.length > 1 && (
            <label className="timeline-space">
              <span>{t.space}</span>
              <select value={shown?.id} onChange={(event) => setSource(event.target.value)}>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {tagged && (
            <div className="mode-switch timeline-modes" role="group" aria-label={t.sortBy}>
              {MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className="timeline-toggle"
                  aria-pressed={effectiveMode === m}
                  title={m === "edited" ? t.editedHint : t.datedHint}
                  onClick={() => {
                    setMode(m);
                    touch();
                  }}
                >
                  {m === "edited" ? t.edited : t.dated}
                </button>
              ))}
            </div>
          )}
        </div>
        {shown && !tagged && <p className="muted home-empty timeline-note">{t.noTags}</p>}
        {undated && <p className="muted home-empty timeline-note">{t.noDates}</p>}
        {allTags.length > 0 && (
          <div className="timeline-tags" role="group" aria-label={t.tags} aria-describedby="timeline-tags-hint">
            <span id="timeline-tags-hint" className="sr-only">
              {t.tagsHint}
            </span>
            {allTags.map((tag) => (
              <button key={tag} type="button" className="timeline-tag" aria-pressed={active.includes(tag)} onClick={() => toggleTag(tag)}>
                #{tag}
              </button>
            ))}
            {active.length > 0 && (
              <button
                type="button"
                className="timeline-tag timeline-clear"
                onClick={() => {
                  setWanted([]);
                  touch();
                }}
              >
                {t.clearTags}
              </button>
            )}
          </div>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {said}
        </p>
        {shown?.error ? (
          <p className="home-empty" role="alert">
            {shown.error}
          </p>
        ) : items === null ? (
          <p className="muted home-empty">{t.loading}</p>
        ) : total === 0 ? (
          <p className="muted home-empty">{active.length > 0 ? t.emptyFiltered : t.empty}</p>
        ) : (
          // Feed-like (rule 17): one list of page links per day, named by its h2. Not role="feed", which wants articles.
          <div className="timeline-days">
            {days.map((day) => {
              const heading = dayLabel(day.day, now, strings.lang, { today: t.today, yesterday: t.yesterday });
              const id = `timeline-day-${day.day}`;
              return (
                <div key={day.day} className="home-section timeline-day">
                  <h2 id={id}>{heading}</h2>
                  <ul className="home-list" aria-labelledby={id}>
                    {day.rows.map(({ item, timed }) => (
                      <li key={item.id}>
                        <Row item={item} time={timed ? timeLabel(item.editedMs, strings.lang) : null} topLevel={t.topLevel} open={(o) => shown!.open(item, o)} />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ item, time, topLevel, open }: { item: TimelineItem; time: string | null; topLevel: string; open(options: { newTab: boolean }): void }) {
  return (
    <button
      type="button"
      className="home-row timeline-row"
      aria-keyshortcuts="Control+Enter Meta+Enter"
      onClick={(event: MouseEvent) => open({ newTab: clickOpens(event)?.newTab === true })}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault(); // no auto-scroll cursor
      }}
      onAuxClick={(event) => {
        if (!isMiddleClick(event)) return;
        event.preventDefault();
        open({ newTab: true });
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (!isOpenInNewTabKey(event)) return;
        event.preventDefault();
        open({ newTab: true });
      }}
    >
      <PageIcon />
      <span className="timeline-main">
        <span className="home-row-title" {...tipIfClipped(item.title)}>
          {item.title}
        </span>
        {item.tags.length > 0 && <span className="timeline-row-tags">{item.tags.map((tag) => `#${tag}`).join(" ")}</span>}
      </span>
      <span className="home-row-meta">
        <span className="home-folder">{item.folder ?? topLevel}</span>
        {time && <span className="timeline-time">{time}</span>}
      </span>
    </button>
  );
}
