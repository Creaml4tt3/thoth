/**
 * Tabs (ADR-0016 rule 5), as plain data. A tab shows one target; the app decides what a target looks like on
 * screen. The functions here are pure, so the open, close, switch and restore rules are tested without a browser.
 *
 * - Clicking a page opens it in the current tab; Cmd/Ctrl+click, middle-click and Cmd/Ctrl+Enter open a new tab
 *   (`open(state, target, { newTab: true })`). A new tab goes right after the current one, as in a browser.
 * - Settings is one tab: opening it again goes to it. If the current tab is empty, Settings takes it.
 * - There is always at least one tab. Closing the last one leaves an empty tab.
 * - Only the current tab is mounted. Leaving a tab writes its pending edits first (`flushAll`, done by the app),
 *   so a switch never loses an edit.
 */

export type TabTarget =
  /** A page of the Private Space (desktop). */
  | { kind: "page"; path: string }
  /** A page of a workspace on a server. */
  | { kind: "workspace"; server: string; workspace: string; page: string }
  | { kind: "settings"; section?: "servers" }
  /** A new, empty tab. */
  | { kind: "blank" };

/** How a page is opened: in the current tab (the default), or in a new one. */
export interface OpenOptions {
  newTab?: boolean;
}

export interface Tab {
  id: string;
  target: TabTarget;
}

export interface TabsState {
  tabs: readonly Tab[];
  /** The id of the current tab. */
  active: string;
  /** Counter for new ids. */
  seq: number;
}

/** The most tabs one window holds (also the most a stored list may bring back). */
export const MAX_TABS = 30;

export const BLANK: TabTarget = { kind: "blank" };

const makeId = (seq: number): string => `t${seq}`;

export function initialTabs(targets: readonly TabTarget[] = [], activeIndex = 0): TabsState {
  const list = targets.slice(0, MAX_TABS);
  const tabs: Tab[] = (list.length > 0 ? list : [BLANK]).map((target, i) => ({ id: makeId(i + 1), target }));
  const at = Math.max(0, Math.min(activeIndex, tabs.length - 1));
  return { tabs, active: tabs[at]!.id, seq: tabs.length };
}

export const activeTab = (state: TabsState): Tab => state.tabs.find((t) => t.id === state.active) ?? state.tabs[0]!;
export const activeIndex = (state: TabsState): number => Math.max(0, state.tabs.findIndex((t) => t.id === state.active));

export function sameTarget(a: TabTarget, b: TabTarget): boolean {
  switch (a.kind) {
    case "page":
      return b.kind === "page" && a.path === b.path;
    case "workspace":
      return b.kind === "workspace" && a.server === b.server && a.workspace === b.workspace && a.page === b.page;
    case "settings":
      return b.kind === "settings";
    case "blank":
      return b.kind === "blank";
  }
}

function insertAfterActive(state: TabsState, target: TabTarget): TabsState {
  if (state.tabs.length >= MAX_TABS) return retarget(state, state.active, target);
  const seq = state.seq + 1;
  const tab: Tab = { id: makeId(seq), target };
  const at = activeIndex(state) + 1;
  return { tabs: [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)], active: tab.id, seq };
}

/** Shows `target` in the tab `id` (a link followed in place). */
export function retarget(state: TabsState, id: string, target: TabTarget): TabsState {
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, target } : t)) };
}

/** Opens `target` in the current tab, or in a new one next to it. */
export function open(state: TabsState, target: TabTarget, options: OpenOptions = {}): TabsState {
  if (target.kind === "settings") {
    const existing = state.tabs.find((t) => t.target.kind === "settings");
    if (existing) return { ...retarget(state, existing.id, target), active: existing.id };
    return activeTab(state).target.kind === "blank" ? retarget(state, state.active, target) : insertAfterActive(state, target);
  }
  return options.newTab ? insertAfterActive(state, target) : retarget(state, state.active, target);
}

/** A new, empty tab after the current one. */
export const newTab = (state: TabsState): TabsState => insertAfterActive(state, BLANK);

/** Closes a tab. The current tab passes to the one on its right, else the one on its left. The last tab is replaced by an empty one. */
export function close(state: TabsState, id: string): TabsState {
  const at = state.tabs.findIndex((t) => t.id === id);
  if (at < 0) return state;
  if (state.tabs.length === 1) {
    const seq = state.seq + 1;
    return { tabs: [{ id: makeId(seq), target: BLANK }], active: makeId(seq), seq };
  }
  const tabs = state.tabs.filter((t) => t.id !== id);
  const active = id === state.active ? (tabs[Math.min(at, tabs.length - 1)]!.id) : state.active;
  return { ...state, tabs, active };
}

export function activate(state: TabsState, id: string): TabsState {
  return state.tabs.some((t) => t.id === id) && id !== state.active ? { ...state, active: id } : state;
}

/** The tab `delta` places from the current one, wrapping around. */
export function step(state: TabsState, delta: number): TabsState {
  const n = state.tabs.length;
  return activate(state, state.tabs[(((activeIndex(state) + delta) % n) + n) % n]!.id);
}

/** Cmd/Ctrl+1–9: the n-th tab; 9 is the last one, as in browsers. A number past the last tab does nothing. */
export function jump(state: TabsState, n: number): TabsState {
  if (n === 9) return activate(state, state.tabs[state.tabs.length - 1]!.id);
  const tab = state.tabs[n - 1];
  return tab ? activate(state, tab.id) : state;
}

/**
 * Pages that moved: tabs showing `from` (a page) or a page under `from` (a folder that moved) follow to `to`, so
 * renaming or moving something keeps its tabs open on it instead of leaving them on a path that is gone.
 */
export function remapPaths(state: TabsState, from: string, to: string): TabsState {
  let changed = false;
  const tabs = state.tabs.map((t) => {
    if (t.target.kind !== "page") return t;
    const path = t.target.path;
    if (path !== from && !path.startsWith(`${from}/`)) return t;
    changed = true;
    return { ...t, target: { kind: "page" as const, path: to + path.slice(from.length) } };
  });
  return changed ? { ...state, tabs } : state;
}

/**
 * Closes the background tabs whose target is gone (`gone` says so only when it is sure). The current tab stays: it
 * shows the "not found" state itself, so the user sees what happened.
 */
export function prune(state: TabsState, gone: (target: TabTarget) => boolean): TabsState {
  const tabs = state.tabs.filter((t) => t.id === state.active || !gone(t.target));
  return tabs.length === state.tabs.length ? state : { ...state, tabs };
}

// ---------------------------------------------------------------------------
// Storage

/** Stored form: targets and the current index. Names are never stored (the web client keeps no page titles). */
interface Stored {
  v: 1;
  active: number;
  tabs: unknown[];
}

const text = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

function storedTarget(target: TabTarget): unknown {
  switch (target.kind) {
    case "page":
      return { k: "page", path: target.path };
    case "workspace":
      return { k: "ws", server: target.server, workspace: target.workspace, page: target.page };
    case "settings":
      return target.section ? { k: "settings", section: target.section } : { k: "settings" };
    case "blank":
      return { k: "blank" };
  }
}

function targetFromStored(value: unknown): TabTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  switch (v["k"]) {
    case "page":
      return text(v["path"], 4096) ? { kind: "page", path: v["path"] } : null;
    case "ws":
      return text(v["server"]) && text(v["workspace"]) && text(v["page"]) ? { kind: "workspace", server: v["server"], workspace: v["workspace"], page: v["page"] } : null;
    case "settings":
      return v["section"] === "servers" ? { kind: "settings", section: "servers" } : { kind: "settings" };
    case "blank":
      return BLANK;
    default:
      return null;
  }
}

export function serializeTabs(state: TabsState): string {
  const stored: Stored = { v: 1, active: activeIndex(state), tabs: state.tabs.map((t) => storedTarget(t.target)) };
  return JSON.stringify(stored);
}

/**
 * Tabs from stored text. Anything unreadable gives `null` (the app starts with one empty tab); a tab that is
 * unreadable on its own is dropped. `keep` lets the app drop targets it knows are not valid (another account's
 * workspace, a page that is gone).
 */
export function parseTabs(raw: string | null | undefined, keep: (target: TabTarget) => boolean = () => true): TabsState | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const stored = data as Partial<Stored>;
  if (stored.v !== 1 || !Array.isArray(stored.tabs)) return null;
  const wanted = typeof stored.active === "number" ? stored.active : 0;
  const targets: TabTarget[] = [];
  // The current tab, or the first kept one after it when it was dropped; the last one when none is left after it.
  let active = -1;
  stored.tabs.slice(0, MAX_TABS).forEach((value, i) => {
    const target = targetFromStored(value);
    if (!target || !keep(target)) return;
    if (active < 0 && i >= wanted) active = targets.length;
    targets.push(target);
  });
  return initialTabs(targets, active < 0 ? targets.length - 1 : active);
}
