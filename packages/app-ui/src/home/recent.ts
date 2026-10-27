/**
 * Recent pages (ADR-0029): the pages opened last, newest first, for the Home view. Kept in localStorage, never in the
 * vault and never sent: per Private Space on the desktop, per account on the web. Each entry is a path or the three
 * workspace ids, and the time it was opened; no title (titles are looked up the way tab labels are).
 *
 * Stored as `{"v":1,"pages":[{"k":"page","path":"Notes/Plan.md","at":1761555000000},{"k":"ws","server":"…",
 * "workspace":"…","page":"…","at":…}]}`. Up to `RECENT_KEEP` are kept and `RECENT_SHOWN` shown. A change made in
 * another window reaches the others through the `storage` event.
 */
import type { TabTarget } from "../tabs/model.ts";

export type RecentRef = { kind: "private"; path: string } | { kind: "workspace"; server: string; workspace: string; page: string };

export interface RecentEntry {
  ref: RecentRef;
  /** When it was opened (ms since the epoch). */
  at: number;
}

export const RECENT_KEEP = 20;
export const RECENT_SHOWN = 5;
const VERSION = 1;

const same = (a: RecentRef, b: RecentRef): boolean =>
  a.kind === "private" ? b.kind === "private" && a.path === b.path : b.kind === "workspace" && a.server === b.server && a.workspace === b.workspace && a.page === b.page;

/** The page a tab shows, as a recent entry; null for Home, Settings, a session or an empty tab. */
export function recentOf(target: TabTarget): RecentRef | null {
  if (target.kind === "page") return { kind: "private", path: target.path };
  if (target.kind === "workspace") return { kind: "workspace", server: target.server, workspace: target.workspace, page: target.page };
  return null;
}

/** `ref` opened at `at`: first in the list, once, and the list cut to `RECENT_KEEP`. */
export function recordRecent(list: readonly RecentEntry[], ref: RecentRef, at: number): RecentEntry[] {
  return [{ ref, at }, ...list.filter((e) => !same(e.ref, ref))].slice(0, RECENT_KEEP);
}

/** A page or folder moved: entries on it, or on a page under it, follow (as tabs do). */
export function remapRecent(list: readonly RecentEntry[], from: string, to: string): readonly RecentEntry[] {
  let changed = false;
  const out = list.map((e) => {
    if (e.ref.kind !== "private" || (e.ref.path !== from && !e.ref.path.startsWith(`${from}/`))) return e;
    changed = true;
    return { ...e, ref: { kind: "private" as const, path: to + e.ref.path.slice(from.length) } };
  });
  // A move onto a page that was already in the list leaves one entry for it.
  return changed ? out.filter((e, i) => out.findIndex((x) => same(x.ref, e.ref)) === i) : list;
}

/** Drops the pages that are gone (`gone` says so only when it is sure). */
export function pruneRecent(list: readonly RecentEntry[], gone: (ref: RecentRef) => boolean): readonly RecentEntry[] {
  const out = list.filter((e) => !gone(e.ref));
  return out.length === list.length ? list : out;
}

const text = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);

export function parseRecent(raw: string | null | undefined): RecentEntry[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null || (data as { v?: unknown }).v !== VERSION || !Array.isArray((data as { pages?: unknown }).pages)) return [];
  const out: RecentEntry[] = [];
  for (const value of (data as { pages: unknown[] }).pages.slice(0, RECENT_KEEP)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const at = typeof v["at"] === "number" && Number.isFinite(v["at"]) ? v["at"] : 0;
    const ref: RecentRef | null =
      v["k"] === "page" && text(v["path"], 4096)
        ? { kind: "private", path: v["path"] }
        : v["k"] === "ws" && text(v["server"]) && text(v["workspace"]) && text(v["page"])
          ? { kind: "workspace", server: v["server"], workspace: v["workspace"], page: v["page"] }
          : null;
    if (ref && !out.some((e) => same(e.ref, ref))) out.push({ ref, at });
  }
  return out;
}

/** The text to store, or null for an empty list (then nothing is stored). */
export function serializeRecent(list: readonly RecentEntry[]): string | null {
  if (list.length === 0) return null;
  const pages = list.map(({ ref, at }) => (ref.kind === "private" ? { k: "page", path: ref.path, at } : { k: "ws", server: ref.server, workspace: ref.workspace, page: ref.page, at }));
  return JSON.stringify({ v: VERSION, pages });
}

type StorageLike = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;

export interface RecentStore {
  get(): readonly RecentEntry[];
  record(ref: RecentRef, at?: number): void;
  remap(from: string, to: string): void;
  prune(gone: (ref: RecentRef) => boolean): void;
  subscribe(listener: () => void): () => void;
  /** Changes with every change heard: a `useSyncExternalStore` snapshot. */
  version(): number;
}

/** The recent pages under `key` in `storage` (the list lasts for the session where storage is unavailable). */
export function createRecentStore(storage: () => StorageLike | null, key: string): RecentStore {
  let fallback: readonly RecentEntry[] = [];
  let version = 0;
  const listeners = new Set<() => void>();
  const read = (): readonly RecentEntry[] => {
    try {
      const s = storage();
      return s ? parseRecent(s.getItem(key)) : fallback;
    } catch {
      return fallback;
    }
  };
  const write = (list: readonly RecentEntry[]) => {
    fallback = list;
    try {
      const s = storage();
      const value = serializeRecent(list);
      if (value !== null) s?.setItem(key, value);
      else if (s?.removeItem) s.removeItem(key);
      else s?.setItem(key, "");
    } catch {
      // quota or privacy mode: the list lasts for the session
    }
    version++;
    for (const listener of [...listeners]) listener();
  };
  const change = (next: (list: readonly RecentEntry[]) => readonly RecentEntry[]) => {
    const list = read();
    const out = next(list);
    if (out !== list) write(out);
  };
  return {
    get: read,
    record: (ref, at = Date.now()) => change((list) => recordRecent(list, ref, at)),
    remap: (from, to) => change((list) => remapRecent(list, from, to)),
    prune: (gone) => change((list) => pruneRecent(list, gone)),
    version: () => version,
    subscribe: (listener) => {
      const onStorage = (event: StorageEvent) => {
        if (event.key !== key && event.key !== null) return;
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
