import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useStrings } from "../strings/index.ts";
import { usePageHost } from "./host.ts";
import type { PageEditorHandle } from "./PageEditor.tsx";
import type { PageSession, PageState, PageStore } from "./page-session.ts";
import { poolFor, type Member } from "./session-pool.ts";

/**
 * The `PageSession` of the open page, shared with any other editor of this window on the same page (ADR-0030: the
 * session pool, keyed by `key`), and kept in step with its store: whenever `checkTick` changes (watcher, import, own
 * save, change feed) the stored version is compared with what the page last saw.
 */
export function usePageSession(
  store: PageStore,
  editor: React.RefObject<PageEditorHandle | null>,
  sync: { checkTick: number; onWritten(): void },
  key: string,
): { session: PageSession | null; state: PageState; member: Member | null; owner: boolean } {
  const host = usePageHost();
  const { autosaveMs, now, registerFlush } = host;
  const changedAgain = useStrings().editor.changedAgain;
  const [member, setMember] = useState<Member | null>(null);
  const written = sync.onWritten;

  // A layout effect: on mount the editor's handle is attached already, and on unmount it is still attached (React
  // detaches a child's handle after its parent's layout cleanup), so the text it leaves with can be read.
  useLayoutEffect(() => {
    // The pool reads the handle lazily (Blocks and Plain swap it).
    const pool = poolFor(host, { autosaveMs, now, registerFlush });
    const held = pool.acquire(key, { store, editor, onWritten: () => written(), changedAgain });
    setMember(held);
    return () => {
      // Leaving the page: its text goes to the other editor, or (the last one) is written before the session goes.
      held.release();
      setMember(null);
    };
    // `written` changes with every render of some callers; the pool keeps the latest it was given.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, store, editor, autosaveMs, now, registerFlush, changedAgain, key]);

  const page = member?.session ?? null;
  useEffect(() => {
    if (page) void page.checkDisk();
  }, [page, sync.checkTick]);

  const state = useSyncExternalStore(
    (listener) => (page ? page.subscribe(listener) : () => undefined),
    () => page?.getState() ?? LOADING,
  );
  const owner = useSyncExternalStore(
    (listener) => (member ? member.subscribe(listener) : () => undefined),
    () => member?.owner() ?? false,
  );
  return { session: page, state, member, owner };
}

const LOADING: PageState = { phase: "loading", editable: true, save: "idle", conflict: null, error: null, conflictCopy: null };
