import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from "react";
import { useStrings } from "../strings/index.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { Button } from "../ui/Button.tsx";
import { describeNotification, notificationTarget, type NotificationCenter, type NotificationEntry, type NotificationTarget } from "./core.ts";

interface Props {
  center: NotificationCenter;
  /** Whether the list is open (the palette's "Show notifications" opens it too). */
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Opens what an entry is about (a run, a page, a folder). */
  onOpenTarget(target: NotificationTarget): void;
  /**
   * Something waiting for the person, shown first in the list for as long as it waits and counted in the badge (the
   * desktop's proposed changes from connected apps, ADR-0048). Not a notification: "Mark all read" and "Clear" leave it.
   */
  pinned?: Pinned | null | readonly (Pinned | null)[];
}

const PANEL_WIDTH = 340;
const GAP = 6;
const MARGIN = 8;

/**
 * The bell in the sidebar and its list (ADR-0018): the unread count is in its name, new entries are said politely,
 * the list is a non-modal dialog right after the bell in the focus order. Arrows move between entries, Esc closes
 * and returns focus to the bell, a click elsewhere or focus leaving closes it.
 */
interface Pinned {
  count: number;
  title: string;
  body: string;
  onOpen(): void;
}

export function NotificationBell({ center, open, onOpenChange, onOpenTarget, pinned }: Props) {
  const strings = useStrings();
  const t = strings.notifications;
  const state = useSyncExternalStore(center.subscribe, center.getState);
  const bell = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const headingId = useId();
  const [place, setPlace] = useState<CSSProperties>({});
  const change = useRef(onOpenChange);
  change.current = onOpenChange;

  // Above the bell, inside the window. Measured once when it opens (not while rendering).
  useLayoutEffect(() => {
    if (!open || !bell.current) return;
    const rect = bell.current.getBoundingClientRect();
    const width = Math.min(PANEL_WIDTH, window.innerWidth - 2 * MARGIN);
    // From the sidebar's start when there is one (the list reads from the left edge, like the tree), else the bell's.
    const start = bell.current.closest(".sidebar")?.getBoundingClientRect().left ?? rect.left - MARGIN;
    const left = Math.max(MARGIN, Math.min(start + MARGIN, window.innerWidth - width - MARGIN));
    setPlace({ left, width, bottom: Math.max(MARGIN, window.innerHeight - rect.top + GAP), maxHeight: Math.max(160, rect.top - GAP - MARGIN) });
  }, [open]);

  // Focus goes to the newest entry, or to the list itself when it is empty.
  useEffect(() => {
    if (!open) return;
    (panel.current?.querySelector<HTMLElement>(".notif-item") ?? panel.current)?.focus();
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !bell.current?.contains(target)) change.current(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const close = (refocus: boolean) => {
    onOpenChange(false);
    if (refocus) bell.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>(".notif-item") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (items.length === 0 || at === -1) return;
    const go = (i: number) => {
      event.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
  };

  const choose = (entry: NotificationEntry) => {
    center.markRead(entry.id);
    onOpenChange(false);
    onOpenTarget(notificationTarget(entry.event));
  };

  const clear = () => {
    center.clear();
    panel.current?.focus();
  };

  const time = new Intl.DateTimeFormat(strings.lang, { hour: "numeric", minute: "2-digit" });
  const waitingList = (Array.isArray(pinned) ? pinned : [pinned]).filter((p): p is Pinned => p !== null && p !== undefined && p.count > 0);
  const waiting = waitingList.length > 0 ? waitingList : null;
  const count = state.unread + waitingList.reduce((n, p) => n + p.count, 0);
  const label = count > 0 ? t.bellUnread(count) : t.bell;

  return (
    <span className="notif">
      <IconButton
        ref={bell}
        icon="bell"
        label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => onOpenChange(!open)}
      />
      {count > 0 && (
        <span className="notif-badge" aria-hidden="true" data-testid="notification-badge">
          {count > 99 ? "99+" : count.toLocaleString(strings.lang)}
        </span>
      )}
      <span className="sr-only" aria-live="polite" data-testid="notification-live">
        {state.announcement?.text ?? ""}
      </span>
      {open && (
        <div
          ref={panel}
          id={panelId}
          className="notif-panel"
          role="dialog"
          aria-labelledby={headingId}
          tabIndex={-1}
          style={place}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            if (next && (panel.current?.contains(next) || bell.current?.contains(next))) return;
            // Focus left for the page or the next control: close without taking it back.
            if (next) onOpenChange(false);
          }}
        >
          <div className="notif-head">
            <h2 id={headingId}>{t.heading}</h2>
            <span className="notif-actions">
              <Button variant="quiet" small disabled={state.unread === 0} onClick={() => center.markAllRead()}>
                {t.markAllRead}
              </Button>
              <Button variant="quiet" small disabled={state.entries.length === 0} onClick={clear}>
                {t.clear}
              </Button>
            </span>
          </div>
          {waiting && (
            <ul className="notif-list notif-pinned">
              {waiting.map((w) => (
                <li key={w.title}>
                  <button
                    type="button"
                    className="notif-item"
                    data-kind="pinned"
                    data-unread
                    onClick={() => {
                      onOpenChange(false);
                      w.onOpen();
                    }}
                  >
                    <span className="notif-title">{w.title}</span>
                    <span className="notif-body">{w.body}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {state.entries.length === 0 ? (
            !waiting && <p className="notif-empty muted">{t.empty}</p>
          ) : (
            <ul className="notif-list">
              {state.entries.map((entry) => {
                const text = describeNotification(entry.event, t);
                return (
                  <li key={entry.id}>
                    <button type="button" className="notif-item" data-kind={entry.event.kind} data-unread={!entry.read || undefined} onClick={() => choose(entry)}>
                      {!entry.read && <span className="sr-only">{`${t.unread}: `}</span>}
                      <span className="notif-title">{text.title}</span>
                      <span className="notif-body">{text.body}</span>
                      <time className="notif-time" dateTime={new Date(entry.at).toISOString()}>
                        {time.format(entry.at)}
                      </time>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </span>
  );
}
