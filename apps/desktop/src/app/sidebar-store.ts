/**
 * The sidebar's layout per Private Space: the width the person chose by dragging its edge, the order of its sections
 * and which sections are folded (ADR-0019 amendment). Like the open tabs, the language and the theme it is an app
 * preference kept in the webview's localStorage; the key names the vault's folder.
 *
 * The value is versioned JSON, `{"v":2,"width":300,"order":["server:demo","private"],"collapsed":["agents"]}`, with the
 * defaults left out, and nothing stored at all when everything is the default. Version 1 was the width alone ("300"),
 * which is still read. Only section ids are stored: no page, folder or server name.
 *
 * Every window on the same Private Space reads the same key. A change made in one window reaches the others through the
 * `storage` event where the webview sends it (`subscribeSidebarLayout`), and otherwise on their next read.
 */
import { parseSidebarWidth } from "@thoth/app-ui/ui/SidebarResizer.tsx";

export const SIDEBAR_KEY_PREFIX = "thoth.desktop.sidebar.";
const VERSION = 2;
/** More ids than this are not a sidebar a person made; the rest is dropped. */
const MAX_IDS = 64;
const MAX_ID_LENGTH = 256;

export interface SidebarLayout {
  /** Null: the default width. */
  width: number | null;
  /** Section ids in the order chosen; empty: the natural order. */
  order: string[];
  /** Section ids folded away. */
  collapsed: string[];
}

const EMPTY: SidebarLayout = { width: null, order: [], collapsed: [] };

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage can be disabled; the layout then lasts for the session
  }
}

export const sidebarKey = (root: string): string => `${SIDEBAR_KEY_PREFIX}${root}`;

/** A list of section ids: strings of a sane length, no repeats, at most `MAX_IDS`. Anything else is an empty list. */
function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH || /[\u0000-\u001f]/.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length === MAX_IDS) break;
  }
  return out;
}

/** The stored value as a layout: version 2, or a bare width (version 1); anything else is the default. */
export function parseSidebarLayout(raw: string | null | undefined): SidebarLayout {
  if (raw === null || raw === undefined) return { ...EMPTY };
  const width = parseSidebarWidth(raw);
  if (width !== null) return { ...EMPTY, width };
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value) || (value as { v?: unknown }).v !== VERSION) return { ...EMPTY };
    const v = value as { width?: unknown; order?: unknown; collapsed?: unknown };
    return { width: typeof v.width === "number" ? parseSidebarWidth(String(v.width)) : null, order: ids(v.order), collapsed: ids(v.collapsed) };
  } catch {
    return { ...EMPTY };
  }
}

/** The text to store, or null when everything is the default (then nothing is stored). */
function serialize(layout: SidebarLayout): string | null {
  const out: { v: number; width?: number; order?: string[]; collapsed?: string[] } = { v: VERSION };
  if (layout.width !== null) out.width = layout.width;
  if (layout.order.length > 0) out.order = ids(layout.order);
  if (layout.collapsed.length > 0) out.collapsed = ids(layout.collapsed);
  return Object.keys(out).length === 1 ? null : JSON.stringify(out);
}

export function loadSidebarLayout(root: string): SidebarLayout {
  try {
    return parseSidebarLayout(storage()?.getItem(sidebarKey(root)));
  } catch {
    return { ...EMPTY };
  }
}

const listeners = new Set<() => void>();

function update(root: string, change: Partial<SidebarLayout>): void {
  try {
    const text = serialize({ ...loadSidebarLayout(root), ...change });
    if (text === null) storage()?.removeItem(sidebarKey(root));
    else storage()?.setItem(sidebarKey(root), text);
  } catch {
    // quota or privacy mode: the layout lasts for the session
  }
  for (const listener of listeners) listener();
}

/** The saved width of a Private Space's sidebar, or null for the default. */
export function loadSidebarWidth(root: string): number | null {
  return loadSidebarLayout(root).width;
}

export function saveSidebarWidth(root: string, width: number | null): void {
  update(root, { width });
}

export function saveSectionOrder(root: string, order: readonly string[]): void {
  update(root, { order: [...order] });
}

export function saveSectionCollapsed(root: string, collapsed: readonly string[]): void {
  update(root, { collapsed: [...collapsed] });
}

/**
 * Calls `listener` when the layout of `root` may have changed: in this window (a save) or in another window on the same
 * Private Space (the `storage` event). Returns the remover.
 */
export function subscribeSidebarLayout(root: string, listener: () => void): () => void {
  const key = sidebarKey(root);
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) listener();
  };
  listeners.add(listener);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}
