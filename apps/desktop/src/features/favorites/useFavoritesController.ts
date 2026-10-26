/**
 * Favorites in the desktop app (ADR-0027): the Private Space's in `.thoth/favorites.json` (stable page ids, written with
 * compare-and-swap), each workspace's in this app's localStorage (per server address, account and workspace; never
 * sent, `useWorkspaceFavorites`). The shell owns one controller and hands it to the views: the Favorites section, the
 * star in a page's header, the tree and tab menus, the palette and Cmd/Ctrl+D.
 *
 * A Private Space favorite whose page is not in the index is not shown. Its id stays in the file until the next change
 * to the favorites, which writes only ids that are pages; a page that comes back first (an undo, a sync) is a favorite
 * again. Workspace favorites drop out as `useWorkspaceFavorites` says.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageSummary } from "@thoth/domain";
import { favoritePage, readFavorites, updateFavorites } from "@thoth/local-store";
import type { FavoriteRef, FavoritesApi } from "@thoth/app-ui/favorites/context.ts";
import type { FavoriteItem } from "@thoth/app-ui/favorites/FavoritesList.tsx";
import { moveInGroup } from "@thoth/app-ui/favorites/list.ts";
import { useWorkspaceFavorites, workspaceRefOf } from "@thoth/app-ui/favorites/useWorkspaceFavorites.ts";
import { createWorkspaceFavorites } from "@thoth/app-ui/favorites/workspace-favorites.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { remoteTitle } from "@thoth/app-ui/tabs/remote.ts";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** One store for the app: every window reads the same key, and hears the others through the `storage` event. */
export const workspaceFavorites = createWorkspaceFavorites(storage);

const PRIVATE_GROUP = "private";
const privateKey = (id: string) => `p:${id}`;

export interface FavoritesController {
  api: FavoritesApi;
  /** In order: the Private Space's, then each workspace's. Empty: the section is hidden. */
  items: FavoriteItem[];
  open(key: string, options: { newTab: boolean }): void;
  move(key: string, to: number): void;
  remove(key: string): void;
  /** What was last said (added, removed), for the live region. */
  said: string;
  error: string | null;
  dismissError(): void;
}

export function useFavoritesController({ pages, current }: { pages: readonly PageSummary[] | null; current: FavoriteRef | null }): FavoritesController {
  const { vault, revision, refresh, flushAll, openPage, openWorkspacePage, servers } = useSession();
  const t = useStrings().favorites;
  const untitled = useStrings().tabs.untitled;
  const local = useDesktopStrings().shell.local;
  const [privateIds, setPrivateIds] = useState<string[]>([]);
  const [said, setSaid] = useState("");
  const [error, setError] = useState<string | null>(null);
  const remote = useWorkspaceFavorites(servers, workspaceFavorites, current?.kind === "workspace" ? current : null);

  // The file is read again after every change to the index and when the window comes back (another window may have
  // starred something; the watcher does not report `.thoth/`).
  const [readTick, setReadTick] = useState(0);
  useEffect(() => {
    const again = () => setReadTick((n) => n + 1);
    globalThis.addEventListener?.("focus", again);
    return () => globalThis.removeEventListener?.("focus", again);
  }, []);
  useEffect(() => {
    let live = true;
    void readFavorites(vault).then((read) => live && setPrivateIds(read.pages));
    return () => {
      live = false;
    };
  }, [vault, revision, readTick]);

  const byId = useMemo(() => new Map((pages ?? []).map((p) => [p.id, p])), [pages]);
  const byPath = useMemo(() => new Map((pages ?? []).map((p) => [p.path, p])), [pages]);
  const known = useMemo(() => new Set((pages ?? []).map((p) => p.id)), [pages]);

  const items = useMemo<FavoriteItem[]>(() => {
    const mine = privateIds.flatMap((id): FavoriteItem[] => {
      const page = byId.get(id);
      if (!page) return [];
      return [{ key: privateKey(id), group: PRIVATE_GROUP, title: page.title, hint: local, detail: page.path, ...(current?.kind === "private" && current.path === page.path ? { current: true } : {}) }];
    });
    return [...mine, ...remote.items];
  }, [privateIds, byId, remote.items, current, local]);

  const fail = useCallback((failure: unknown) => setError(t.failed(failure instanceof Error ? failure.message : String(failure))), [t]);

  /** Changes to the file run one after another, so two quick stars in this window do not race each other. */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(
    (job: () => Promise<void>) => {
      const run = chain.current.then(job).catch(fail);
      chain.current = run;
      return run;
    },
    [fail],
  );

  const has = useCallback(
    (ref: FavoriteRef): boolean => {
      if (ref.kind === "workspace") return remote.has(ref);
      const page = byPath.get(ref.path);
      return page !== undefined && privateIds.includes(page.id);
    },
    [byPath, privateIds, remote],
  );

  const toggle = useCallback(
    (ref: FavoriteRef) => {
      setError(null);
      if (ref.kind === "workspace") {
        if (!remote.can(ref)) return;
        const title = remoteTitle(servers.getState(), ref) || untitled;
        setSaid(remote.toggle(ref) ? t.added(title) : t.removed(title));
        return;
      }
      const page = byPath.get(ref.path);
      const title = page?.title ?? ref.path;
      const on = has(ref);
      void enqueue(async () => {
        if (on && page) {
          setPrivateIds(await updateFavorites(vault, (list) => list.filter((id) => id !== page.id), { keep: known }));
        } else {
          // Starring gives the page a stable id in its frontmatter (ADR-0003): what is on screen is written first.
          if (!(await flushAll())) return;
          const id = await favoritePage(vault, ref.path);
          setPrivateIds((list) => (list.includes(id) ? list : [...list, id]));
          await refresh();
        }
        setSaid(on ? t.removed(title) : t.added(title));
      });
    },
    [remote, servers, untitled, t, byPath, has, enqueue, vault, known, flushAll, refresh],
  );

  const can = useCallback((ref: FavoriteRef) => (ref.kind === "private" ? true : remote.can(ref)), [remote]);

  const refOf = useCallback(
    (key: string): FavoriteRef | null => {
      const ws = workspaceRefOf(key);
      if (ws) return { kind: "workspace", ...ws };
      const page = key.startsWith("p:") ? byId.get(key.slice(2)) : undefined;
      return page ? { kind: "private", path: page.path } : null;
    },
    [byId],
  );

  const open = useCallback(
    (key: string, options: { newTab: boolean }) => {
      const ref = refOf(key);
      const how = options.newTab ? { newTab: true } : undefined;
      if (ref?.kind === "private") openPage(ref.path, how);
      else if (ref) openWorkspacePage({ server: ref.server, workspace: ref.workspace, page: ref.page }, how);
    },
    [refOf, openPage, openWorkspacePage],
  );

  const move = useCallback(
    (key: string, to: number) => {
      setError(null);
      const ws = workspaceRefOf(key);
      if (ws) return remote.move(ws, to);
      const id = key.slice(2);
      // `to` counts the favorites shown; the file may hold others (pages gone for now), which this write drops.
      void enqueue(async () => {
        setPrivateIds(await updateFavorites(vault, (list) => moveInGroup(list.filter((x) => known.has(x)), id, to), { keep: known }));
      });
    },
    [remote, enqueue, vault, known],
  );

  const remove = useCallback(
    (key: string) => {
      const ref = refOf(key);
      if (ref) toggle(ref);
    },
    [refOf, toggle],
  );

  const api = useMemo<FavoritesApi>(() => ({ has, toggle, can }), [has, toggle, can]);
  return { api, items, open, move, remove, said, error, dismissError: () => setError(null) };
}
