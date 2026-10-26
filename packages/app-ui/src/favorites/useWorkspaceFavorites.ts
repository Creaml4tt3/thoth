/**
 * Workspace favorites as a view (ADR-0027), shared by the desktop and the web client: the rows of the Favorites list,
 * whether a page is starred, and the changes, over the store in `workspace-favorites.ts`.
 *
 * - Lists are kept per server address, account and workspace. A signed-out server shows none of its favorites (whose
 *   they are is not known); they come back with the sign-in.
 * - A favorite is dropped from the store once the server has said it is gone (`remoteGone`: the page is not in the
 *   loaded tree, or the workspace is not in the list, so losing access drops it too). While its tree is loading or
 *   could not load it stays, marked unavailable.
 * - Workspaces with favorites load their trees (as background tabs do), so titles are known.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useStrings } from "../strings/index.ts";
import { remoteGone, remoteTitle } from "../tabs/remote.ts";
import { workspaceKey, type DirectoryState, type ServerDirectory, type WorkspacePageRef } from "../workspace/directory.ts";
import type { FavoriteItem } from "./FavoritesList.tsx";
import { moveInGroup } from "./list.ts";
import type { WorkspaceFavorites, WorkspaceScope } from "./workspace-favorites.ts";

export const workspaceFavoriteKey = (ref: WorkspacePageRef) => `w:${ref.server}\n${ref.workspace}\n${ref.page}`;

/** The workspace page of a key made by `workspaceFavoriteKey`, or null for another kind of key. */
export function workspaceRefOf(key: string): WorkspacePageRef | null {
  if (!key.startsWith("w:")) return null;
  const [server, workspace, page] = key.slice(2).split("\n");
  return server && workspace && page ? { server, workspace, page } : null;
}

/** Who is signed in to a server: the host's word (`ServerInfo.account`), unless the app knows better. */
type AccountOf = (server: string) => string | undefined;

/** The account signed in to the entry, or undefined while it is signed out or not known. */
function accountIn(state: DirectoryState, server: string, accountOf?: AccountOf): string | undefined {
  const entry = state.servers.find((s) => s.info.id === server);
  if (!entry || entry.info.auth === "signed-out") return undefined;
  return accountOf?.(server) ?? entry.info.account?.id;
}

/** The scope a workspace favorite is kept under: null while the server is signed out (no account known). */
export function scopeOf(state: DirectoryState, server: string, workspace: string, accountOf?: AccountOf): WorkspaceScope | null {
  const entry = state.servers.find((s) => s.info.id === server);
  const account = accountIn(state, server, accountOf);
  return entry && account ? { server: entry.info.url, account, workspace } : null;
}

export interface WorkspaceFavoritesView {
  items: FavoriteItem[];
  has(ref: WorkspacePageRef): boolean;
  can(ref: WorkspacePageRef): boolean;
  /** Stars or unstars; returns true when it is a favorite now. */
  toggle(ref: WorkspacePageRef): boolean;
  /** Moves the favorite `ref` to index `to` among those of its workspace. */
  move(ref: WorkspacePageRef, to: number): void;
}

/**
 * `accountOf` names the signed-in account where the host's server list does not (the web client learns it from
 * `GET /me` after the list was made).
 */
export function useWorkspaceFavorites(directory: ServerDirectory, store: WorkspaceFavorites, current: WorkspacePageRef | null, accountOf?: AccountOf): WorkspaceFavoritesView {
  const t = useStrings();
  const state = useSyncExternalStore(directory.subscribe, directory.getState);
  const version = useSyncExternalStore(store.subscribe, store.version);

  const lists = useMemo(() => {
    void version;
    return state.servers.flatMap((entry) => {
      const account = accountIn(state, entry.info.id, accountOf);
      return account ? store.lists(entry.info.url, account).map((list) => ({ server: entry.info.id, list })) : [];
    });
  }, [state, store, version, accountOf]);

  const wanted = [...new Set(lists.map((l) => `${l.server}\n${l.list.workspace}`))].join("\u0000");
  useEffect(() => {
    for (const key of wanted ? wanted.split("\u0000") : []) {
      const [server, workspace] = key.split("\n") as [string, string];
      if (directory.workspace(server, workspace)) directory.expand(server, workspace);
    }
    // `state` changes with every poll; the workspaces wanted and the servers' lists are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, directory, state.servers]);

  useEffect(() => {
    for (const { server, list } of lists) {
      const keep = list.pages.filter((page) => !remoteGone(state, { server, workspace: list.workspace, page }));
      if (keep.length !== list.pages.length) store.set(list, keep);
    }
  }, [lists, state, store]);

  const items = useMemo<FavoriteItem[]>(
    () =>
      lists.flatMap(({ server, list }) => {
        const entry = state.servers.find((s) => s.info.id === server);
        const workspace = entry?.workspaces?.find((w) => w.id === list.workspace);
        const tree = state.trees[workspaceKey(server, list.workspace)];
        return list.pages.flatMap((page): FavoriteItem[] => {
          const ref = { server, workspace: list.workspace, page };
          if (remoteGone(state, ref)) return [];
          const title = remoteTitle(state, ref);
          const isCurrent = current?.server === server && current.workspace === list.workspace && current.page === page;
          return [
            {
              key: workspaceFavoriteKey(ref),
              group: workspaceKey(server, list.workspace),
              title: title === null ? t.favorites.unavailable : title || t.tabs.untitled,
              hint: workspace?.name ?? entry?.info.label ?? "",
              ...(title === null || !tree || tree.error ? { unavailable: true } : {}),
              ...(isCurrent ? { current: true } : {}),
            },
          ];
        });
      }),
    [lists, state, current, t],
  );

  const has = useCallback(
    (ref: WorkspacePageRef) => {
      void version;
      const scope = scopeOf(state, ref.server, ref.workspace, accountOf);
      return scope !== null && store.get(scope).includes(ref.page);
    },
    [state, store, version, accountOf],
  );
  const can = useCallback((ref: WorkspacePageRef) => scopeOf(state, ref.server, ref.workspace, accountOf) !== null, [state, accountOf]);
  const toggle = useCallback(
    (ref: WorkspacePageRef) => {
      const scope = scopeOf(state, ref.server, ref.workspace, accountOf);
      if (!scope) return false;
      const list = store.get(scope);
      const on = list.includes(ref.page);
      store.set(scope, on ? list.filter((p) => p !== ref.page) : [...list, ref.page]);
      return !on;
    },
    [state, store, accountOf],
  );
  const move = useCallback(
    (ref: WorkspacePageRef, to: number) => {
      const scope = scopeOf(state, ref.server, ref.workspace, accountOf);
      if (scope) store.set(scope, moveInGroup(store.get(scope), ref.page, to));
    },
    [state, store, accountOf],
  );
  return { items, has, can, toggle, move };
}
