/**
 * Favorites of workspace pages (ADR-0027): per person and local to this app, never sent to the server. One versioned
 * localStorage key holds a list per server address, account and workspace:
 * `{"v":1,"lists":[{"server":"https://…","account":"usr_…","workspace":"…","pages":["…"]}]}`. Only ids are kept: no
 * page title, no text. The desktop keeps it in its webview, the web client in the browser.
 *
 * Lists keep the order in which their workspace got its first favorite; pages keep the order the person gave them. A
 * change in another window reaches subscribers through the `storage` event.
 */

export const WORKSPACE_FAVORITES_KEY = "thoth.favorites.workspaces";
const VERSION = 1;
const MAX_LISTS = 64;
const MAX_PAGES = 200;

export interface WorkspaceScope {
  /** The server's address (`ServerInfo.url`): the same server keeps its favorites when it is added again. */
  server: string;
  /** The signed-in account's id: two people on one computer each have their own. */
  account: string;
  workspace: string;
}

export interface WorkspaceFavoritesList extends WorkspaceScope {
  pages: string[];
}

type StorageLike = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;

const text = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
const same = (a: WorkspaceScope, b: WorkspaceScope) => a.server === b.server && a.account === b.account && a.workspace === b.workspace;

export function parseWorkspaceFavorites(raw: string | null | undefined): WorkspaceFavoritesList[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null || (data as { v?: unknown }).v !== VERSION || !Array.isArray((data as { lists?: unknown }).lists)) return [];
  const out: WorkspaceFavoritesList[] = [];
  for (const entry of (data as { lists: unknown[] }).lists.slice(0, MAX_LISTS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (!text(e["server"], 2048) || !text(e["account"]) || !text(e["workspace"]) || !Array.isArray(e["pages"])) continue;
    const pages = [...new Set((e["pages"] as unknown[]).filter((p): p is string => text(p)))].slice(0, MAX_PAGES);
    const scope = { server: e["server"], account: e["account"], workspace: e["workspace"] };
    if (pages.length > 0 && !out.some((l) => same(l, scope))) out.push({ ...scope, pages });
  }
  return out;
}

export interface WorkspaceFavorites {
  get(scope: WorkspaceScope): string[];
  set(scope: WorkspaceScope, pages: readonly string[]): void;
  /** Every list of `account` on `server`, in the order their workspaces got their first favorite. */
  lists(server: string, account: string): WorkspaceFavoritesList[];
  subscribe(listener: () => void): () => void;
  /** Changes with every change heard (here or in another window): a `useSyncExternalStore` snapshot. */
  version(): number;
}

export function createWorkspaceFavorites(storage: () => StorageLike | null): WorkspaceFavorites {
  /** What was written last, for when storage is unavailable (the favorites then last for the session). */
  let fallback: WorkspaceFavoritesList[] = [];
  let version = 0;
  const listeners = new Set<() => void>();
  const read = (): WorkspaceFavoritesList[] => {
    try {
      const s = storage();
      return s ? parseWorkspaceFavorites(s.getItem(WORKSPACE_FAVORITES_KEY)) : fallback;
    } catch {
      return fallback;
    }
  };
  const write = (lists: WorkspaceFavoritesList[]) => {
    fallback = lists;
    try {
      const s = storage();
      if (s && lists.length === 0) {
        if (s.removeItem) s.removeItem(WORKSPACE_FAVORITES_KEY);
        else s.setItem(WORKSPACE_FAVORITES_KEY, ""); // reads as none
      }
      else s?.setItem(WORKSPACE_FAVORITES_KEY, JSON.stringify({ v: VERSION, lists }));
    } catch {
      // quota or privacy mode: they last for the session
    }
    version++;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: (scope) => read().find((l) => same(l, scope))?.pages ?? [],
    set: (scope, pages) => {
      const lists = read();
      const at = lists.findIndex((l) => same(l, scope));
      const next = [...new Set(pages)].slice(0, MAX_PAGES);
      const entry = { server: scope.server, account: scope.account, workspace: scope.workspace, pages: next };
      if (at >= 0) lists.splice(at, 1, ...(next.length > 0 ? [entry] : []));
      else if (next.length > 0) lists.push(entry);
      write(lists.slice(0, MAX_LISTS));
    },
    version: () => version,
    lists: (server, account) => read().filter((l) => l.server === server && l.account === account),
    subscribe: (listener) => {
      const onStorage = (event: StorageEvent) => {
        if (event.key !== WORKSPACE_FAVORITES_KEY && event.key !== null) return;
        version++;
        listener();
      };
      listeners.add(listener);
      globalThis.addEventListener?.("storage", onStorage);
      return () => {
        listeners.delete(listener);
        globalThis.removeEventListener?.("storage", onStorage);
      };
    },
  };
}
