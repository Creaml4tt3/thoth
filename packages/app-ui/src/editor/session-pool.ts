/**
 * One page session per page per window, shared by every editor that shows the page (ADR-0030 rule 10): with two panes
 * on one page there is one base hash, one autosave, one save and one conflict dialog, so the second editor never makes
 * a conflict with the first.
 *
 * - The session talks to all the page's editors through one bridge: a load (open, a change on disk, a resolution)
 *   reaches every editor; what is saved is the text of the *lead*, the editor that was edited or focused last.
 * - The other editors catch up from the lead `syncMs` after an edit, and at once when one of them gets focus, so
 *   nothing is typed into a stale copy. Catching up is a load: it replaces that editor's document and undo history.
 * - An editor that leaves gives its text to the others first. When the last leaves, the session flushes (the text is
 *   read at once) and is disposed once the flush has ended; an editor that comes back for the page before then joins
 *   it with the text just read, instead of a new session reading a disk the flush is still writing.
 *
 * No React here; `usePageSession` holds a member per mounted editor.
 */
import type { EditorBridge, PageSession, PageSessionDeps, PageStore } from "./page-session.ts";
import { createPageSession } from "./page-session.ts";

export const SYNC_MS = 150;

export interface PoolOptions {
  autosaveMs: number;
  now(): Date;
  /** The window's `registerFlush`: one per page, not one per editor. */
  registerFlush(flush: () => Promise<boolean>): () => void;
  /** How long after an edit the other editors catch up. */
  syncMs?: number;
}

export interface MemberOptions {
  store: PageStore;
  /** This editor (read lazily: it may be swapped, Blocks for Plain). */
  editor: { readonly current: EditorBridge | null };
  onWritten(): void;
  changedAgain?: PageSessionDeps["changedAgain"];
}

/** One editor's hold on the shared session of its page. */
export interface Member {
  readonly session: PageSession;
  /** This editor was edited: it leads, the session schedules a save, and the others catch up shortly. */
  edited(): void;
  /** This editor got focus: the others' last edit reaches it first, then it leads. */
  focused(): void;
  /** True when this editor shows the page's dialogs (the conflict) and tells of them: the lead, else the first. */
  owner(): boolean;
  /** Told when `owner()` may have changed. */
  subscribe(listener: () => void): () => void;
  /** This editor goes away (unmount). */
  release(): void;
}

interface Entry {
  session: PageSession;
  members: MemberImpl[];
  lead: MemberImpl | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  unregister: (() => void) | null;
  /** The text read when the last editor left, while its flush runs. */
  parting: string | null;
  onWritten: () => void;
}

interface MemberImpl extends Member {
  editor: { readonly current: EditorBridge | null };
  listeners: Set<() => void>;
}

export interface SessionPool {
  acquire(key: string, options: MemberOptions): Member;
  /** For tests: how many pages have a session now. */
  size(): number;
}

export function createSessionPool(options: PoolOptions): SessionPool {
  const entries = new Map<string, Entry>();
  const syncMs = options.syncMs ?? SYNC_MS;

  const textOf = (m: MemberImpl | null | undefined): string | null => m?.editor.current?.markdown() ?? null;
  const leadOf = (entry: Entry): MemberImpl | null => entry.lead ?? entry.members[0] ?? null;
  const notify = (entry: Entry) => {
    for (const m of entry.members) for (const l of [...m.listeners]) l();
  };

  /** Brings every other editor to the lead's text. */
  const syncNow = (entry: Entry) => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    const lead = leadOf(entry);
    const text = textOf(lead);
    if (text === null) return;
    for (const m of entry.members) {
      if (m === lead) continue;
      const ed = m.editor.current;
      if (ed && ed.markdown() !== text) ed.load(text);
    }
  };

  const setLead = (entry: Entry, m: MemberImpl | null) => {
    if (entry.lead === m) return;
    entry.lead = m;
    notify(entry);
  };

  const create = (key: string, first: MemberOptions): Entry => {
    const entry: Entry = { session: null as unknown as PageSession, members: [], lead: null, timer: undefined, unregister: null, parting: null, onWritten: first.onWritten };
    const bridge: EditorBridge = {
      // What is saved: the lead's text; the text read as the last editor left, while that flush runs.
      markdown: () => (entry.members.length === 0 ? entry.parting : textOf(leadOf(entry))),
      load: (source) => {
        for (const m of entry.members) m.editor.current?.load(source);
      },
      setEditable: (editable) => {
        for (const m of entry.members) m.editor.current?.setEditable(editable);
      },
    };
    entry.session = createPageSession({
      store: first.store,
      editor: bridge,
      autosaveMs: options.autosaveMs,
      now: options.now,
      onWritten: () => entry.onWritten(),
      ...(first.changedAgain ? { changedAgain: first.changedAgain } : {}),
    });
    entries.set(key, entry);
    entry.unregister = options.registerFlush(() => entry.session.flush());
    void entry.session.open();
    return entry;
  };

  const acquire = (key: string, opts: MemberOptions): Member => {
    const existing = entries.get(key);
    const entry = existing ?? create(key, opts);
    const joining = existing !== undefined;
    if (joining && entry.unregister === null) entry.unregister = options.registerFlush(() => entry.session.flush());
    const member: MemberImpl = {
      session: entry.session,
      editor: opts.editor,
      listeners: new Set(),
      edited() {
        if (!entry.members.includes(member)) return;
        setLead(entry, member);
        entry.session.noteEdited();
        if (entry.members.length > 1) {
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = setTimeout(() => syncNow(entry), syncMs);
        }
      },
      focused() {
        if (!entry.members.includes(member) || entry.lead === member) return;
        // The other editor's last edit reaches this one before anything is typed here.
        if (entry.members.length > 1) syncNow(entry);
        setLead(entry, member);
      },
      owner: () => leadOf(entry) === member,
      subscribe(listener) {
        member.listeners.add(listener);
        return () => void member.listeners.delete(listener);
      },
      release() {
        const at = entry.members.indexOf(member);
        if (at < 0) return;
        if (entry.members.length > 1) {
          // Its text goes to the others first, so an edit it led is not lost with it.
          if (leadOf(entry) === member) syncNow(entry);
          entry.members.splice(at, 1);
          if (entry.lead === member) entry.lead = null;
          notify(entry);
          return;
        }
        // The last editor: read its text now (the flush snapshots it before anything can change), then let go.
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.parting = textOf(member) ?? entry.session.known();
        const flushed = entry.session.flush().catch(() => false);
        entry.members.splice(at, 1);
        entry.lead = null;
        entry.unregister?.();
        entry.unregister = null;
        void flushed.finally(() => {
          if (entry.members.length > 0) return;
          entry.session.dispose();
          if (entries.get(key) === entry) entries.delete(key);
        });
      },
    };
    if (joining) {
      // A loaded page: this editor starts with what the others show (unsaved edits included), or what the last one left.
      const text = textOf(leadOf(entry)) ?? (entry.members.length === 0 ? entry.parting : null) ?? entry.session.known();
      const state = entry.session.getState();
      if (state.phase === "ready" && text !== null) {
        opts.editor.current?.load(text);
        opts.editor.current?.setEditable(state.editable && state.conflict === null);
      }
    }
    entry.members.push(member);
    entry.onWritten = opts.onWritten;
    if (entry.members.length === 1) entry.parting = null;
    notify(entry);
    return member;
  };

  return { acquire, size: () => entries.size };
}

/** One pool per window: keyed by its page host, which both clients make once per window. */
const pools = new WeakMap<object, SessionPool>();
export function poolFor(host: object, options: PoolOptions): SessionPool {
  let pool = pools.get(host);
  if (!pool) {
    pool = createSessionPool(options);
    pools.set(host, pool);
  }
  return pool;
}

/** The key of a page in the pool: where it lives and its mode key (Private Space folder and path; server, workspace, page). */
export const pageKey = (store: PageStore, space: string, page: string): string => `${store.kind}\n${space}\n${page}`;
