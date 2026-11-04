/**
 * Connections (ADR-0050): one page's links, its backlinks, and pages that mention it without a link, each mention with
 * a button that turns it into a link. The same panel in the Private Space and in workspaces; where the lists come from
 * and how a mention is linked is the `source`'s business.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useStrings } from "../strings/index.ts";
import { clickOpens, isMiddleClick, isOpenInNewTabKey } from "../tabs/open-keys.ts";
import type { OpenOptions } from "../tabs/model.ts";
import { isTooShort, type LinkOutcome, type Mention } from "./mentions.ts";

export interface ConnectedPage {
  /** Opens it: a vault path or a page ID. */
  ref: string;
  title: string;
  /** Where it is, under the title (a path or folder); optional. */
  detail?: string;
}

export interface MentionRow {
  page: ConnectedPage;
  mention: Mention;
}

export interface ConnectionsSource {
  /** The open page's title: what mentions are looked for. */
  title: string;
  /** Changes whenever the lists may have changed (index revision, the workspace tree). */
  tick: unknown;
  links(): Promise<ConnectedPage[]>;
  /** Null: this space cannot list backlinks (a server without search). */
  backlinks(): Promise<ConnectedPage[]> | null;
  /** Null: this space cannot look for mentions. `capped`: more were found than are listed. */
  mentions(): Promise<{ rows: MentionRow[]; capped: boolean }> | null;
  /** Absent: the reader may not write (a viewer); mentions are listed without a Link button. */
  link?(row: MentionRow): Promise<LinkOutcome>;
  open(ref: string, options?: OpenOptions): void;
}

type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "none" };

function useLoad<T>(load: () => Promise<T> | null, deps: unknown[]): Load<T> {
  const [value, setValue] = useState<Load<T>>({ state: "loading" });
  useEffect(() => {
    let live = true;
    const pending = load();
    if (!pending) {
      setValue({ state: "none" });
      return;
    }
    pending.then(
      (v) => live && setValue({ state: "ready", value: v }),
      () => live && setValue({ state: "none" }),
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

function PageButton({ page, open, children }: { page: ConnectedPage; open: ConnectionsSource["open"]; children?: React.ReactNode }) {
  return (
    <button
      type="button"
      className="connection-page"
      aria-keyshortcuts="Control+Enter Meta+Enter"
      onClick={(event: MouseEvent) => open(page.ref, clickOpens(event))}
      onAuxClick={(event) => {
        if (!isMiddleClick(event)) return;
        event.preventDefault();
        open(page.ref, { newTab: true });
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (!isOpenInNewTabKey(event)) return;
        event.preventDefault();
        open(page.ref, { newTab: true });
      }}
    >
      <span>{page.title}</span>
      {children ?? (page.detail ? <span className="muted mono">{page.detail}</span> : null)}
    </button>
  );
}

function PageList({ pages, open, empty }: { pages: ConnectedPage[]; open: ConnectionsSource["open"]; empty: string }) {
  if (pages.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul>
      {pages.map((page) => (
        <li key={page.ref}>
          <PageButton page={page} open={open} />
        </li>
      ))}
    </ul>
  );
}

const rowKey = (row: MentionRow) => `${row.page.ref}\n${row.mention.start}`;

export function Connections({ source }: { source: ConnectionsSource }) {
  const t = useStrings().connections;
  const id = useId();
  const links = useLoad(() => source.links(), [source.tick]);
  const backlinks = useLoad(() => source.backlinks(), [source.tick]);
  const [open, setOpen] = useState(false);
  const [mentions, setMentions] = useState<Load<{ rows: MentionRow[]; capped: boolean }>>({ state: "loading" });
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const short = isTooShort(source.title);

  // The count is said when the part opens, not when the lists refresh (that would talk over "Linked in …").
  const announce = useRef(false);
  useEffect(() => {
    announce.current = open;
  }, [open]);
  useEffect(() => {
    if (!open || short) return;
    let live = true;
    const pending = source.mentions();
    if (!pending) {
      setMentions({ state: "none" });
      return;
    }
    setMentions((m) => (m.state === "ready" ? m : { state: "loading" }));
    pending.then(
      (value) => {
        if (!live) return;
        setMentions({ state: "ready", value });
        if (announce.current) setSaid(t.mentionsFound(value.rows.length));
        announce.current = false;
      },
      () => live && setMentions({ state: "none" }),
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, short, source.tick, source.title]);

  const link = async (row: MentionRow, index: number) => {
    if (!source.link || busy) return;
    setBusy(rowKey(row));
    try {
      const outcome = await source.link(row);
      if (outcome === "linked") {
        setSaid(t.linked(row.page.title));
        setMentions((m) => (m.state === "ready" ? { state: "ready", value: { ...m.value, rows: m.value.rows.filter((r) => rowKey(r) !== rowKey(row)) } } : m));
        // Focus the next Link button (the one now at this index), else the disclosure.
        requestAnimationFrame(() => {
          const buttons = list.current?.querySelectorAll<HTMLButtonElement>(".connection-link");
          const next = buttons?.[Math.min(index, buttons.length - 1)];
          (next ?? toggle.current)?.focus();
        });
      } else setSaid(outcome === "changed" ? t.linkChanged(row.page.title) : t.linkGone(row.page.title));
    } catch {
      setSaid(t.linkFailed(row.page.title));
    } finally {
      setBusy(null);
    }
  };

  const count = (load: Load<unknown[]>) => (load.state === "ready" ? ` (${load.value.length})` : "");
  const mentionCount = mentions.state === "ready" && open ? ` (${mentions.value.rows.length})` : "";

  return (
    <section className="backlinks connections" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t.title}</h2>

      <h3>{t.links}{count(links as Load<unknown[]>)}</h3>
      {links.state === "ready" && <PageList pages={links.value} open={source.open} empty={t.noLinks} />}

      {backlinks.state !== "none" && (
        <>
          <h3>{t.backlinks}{count(backlinks as Load<unknown[]>)}</h3>
          {backlinks.state === "ready" && <PageList pages={backlinks.value} open={source.open} empty={t.noBacklinks} />}
        </>
      )}

      <h3>
        <button ref={toggle} type="button" className="connections-toggle" aria-expanded={open} aria-controls={`${id}-mentions`} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> {t.mentions}{mentionCount}
        </button>
      </h3>
      <div id={`${id}-mentions`} hidden={!open}>
        {open && short && <p className="muted">{t.titleTooShort}</p>}
        {open && !short && mentions.state === "loading" && <p className="muted">{t.searching}</p>}
        {open && !short && mentions.state === "none" && <p className="muted">{t.mentionsUnavailable}</p>}
        {open && !short && mentions.state === "ready" && (
          <>
            {mentions.value.rows.length === 0 ? (
              <p className="muted">{t.noMentions}</p>
            ) : (
              <ul ref={list}>
                {mentions.value.rows.map((row, index) => (
                  <li key={rowKey(row)} className="connection-mention">
                    <PageButton page={row.page} open={source.open}>
                      <span className="connection-context">
                        {row.mention.before}
                        <mark>{row.mention.text}</mark>
                        {row.mention.after}
                      </span>
                    </PageButton>
                    {source.link && (
                      <button type="button" className="btn btn-sm btn-ghost connection-link" aria-label={t.linkLabel(row.page.title)} disabled={busy !== null} onClick={() => void link(row, index)}>
                        {t.link}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {mentions.value.capped && <p className="muted">{t.mentionsCapped}</p>}
          </>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
    </section>
  );
}
