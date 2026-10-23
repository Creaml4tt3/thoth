import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useStrings } from "../strings/index.ts";
import { usePageHost } from "./host.ts";
import type { PageEditorHandle } from "./PageEditor.tsx";
import { createPageSession, type PageSession, type PageState, type PageStore } from "./page-session.ts";

/**
 * Creates the `PageSession` for the open page and keeps it in step with its
 * store: whenever `checkTick` changes (watcher, import, own save, change feed)
 * the stored version is compared with what the page last saw.
 */
export function usePageSession(
  store: PageStore,
  editor: React.RefObject<PageEditorHandle | null>,
  sync: { checkTick: number; onWritten(): void },
): { session: PageSession | null; state: PageState } {
  const { autosaveMs, now, registerFlush } = usePageHost();
  const changedAgain = useStrings().editor.changedAgain;
  const [page, setPage] = useState<PageSession | null>(null);
  const written = useRef(sync.onWritten);
  written.current = sync.onWritten;

  useEffect(() => {
    // The editor handle is attached by the time effects run; bridge calls are forwarded lazily.
    const bridge = {
      markdown: () => editor.current?.markdown() ?? null,
      load: (source: string) => editor.current?.load(source),
      setEditable: (editable: boolean) => editor.current?.setEditable(editable),
    };
    const session = createPageSession({ store, editor: bridge, autosaveMs, now, onWritten: () => written.current(), changedAgain });
    setPage(session);
    void session.open();
    const unregister = registerFlush(() => session.flush());
    return () => {
      unregister();
      // Leaving the page: write pending edits first (the snapshot is taken synchronously), then retire the session.
      void session.flush().catch(() => false).finally(() => session.dispose());
      setPage(null);
    };
  }, [store, editor, autosaveMs, now, registerFlush, changedAgain]);

  useEffect(() => {
    if (page) void page.checkDisk();
  }, [page, sync.checkTick]);

  const state = useSyncExternalStore(
    (listener) => (page ? page.subscribe(listener) : () => undefined),
    () => page?.getState() ?? LOADING,
  );
  return { session: page, state };
}

const LOADING: PageState = { phase: "loading", editable: true, save: "idle", conflict: null, error: null, conflictCopy: null };
