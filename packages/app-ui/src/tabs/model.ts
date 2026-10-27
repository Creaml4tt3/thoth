/**
 * Tabs (ADR-0016 rule 5), as plain data. A tab shows one target; the app decides what a target looks like on
 * screen. The functions here are pure, so the open, close, switch and restore rules are tested without a browser.
 *
 * - Clicking a page opens it in the current tab; Cmd/Ctrl+click, middle-click and Cmd/Ctrl+Enter open a new tab
 *   (`open(state, target, { newTab: true })`). A new tab goes right after the current one, as in a browser.
 * - Settings is one tab: opening it again goes to it. If the current tab is empty, Settings takes it. A session of
 *   the assistant (desktop only) is one tab per run in the same way: opening the same run again goes to its tab.
 * - There is always at least one tab. Closing the last one leaves an empty tab.
 * - Only the current tab is mounted. Leaving a tab writes its pending edits first (`flushAll`, done by the app),
 *   so a switch never loses an edit.
 * - Pinned tabs (ADR-0027) sit together at the start of the list and keep their order among themselves; nothing moves
 *   a tab across that boundary but pinning and unpinning it. A pinned tab is not closed (`close` and `closeOthers`
 *   leave it), and it keeps its page: opening a page "in the current tab" while a pinned tab is current opens a new
 *   tab after the pinned ones instead. An empty tab is never pinned (there is nothing to keep).
 */
import { isStableId } from "@thoth/domain";

export type TabTarget =
  /** A page of the Private Space (desktop). */
  | { kind: "page"; path: string }
  /** A page of a workspace on a server. */
  | { kind: "workspace"; server: string; workspace: string; page: string }
  | { kind: "settings"; section?: "servers" | "agents" | "import" }
  /** A session of the assistant: one conversation, by its first run's UUIDv7 (desktop only; the web client drops it). */
  | { kind: "agent-run"; run: string }
  /** A new, empty tab. */
  | { kind: "blank" };

/** How a page is opened: in the current tab (the default), or in a new one. */
export interface OpenOptions {
  newTab?: boolean;
}

export interface Tab {
  id: string;
  target: TabTarget;
  /** Kept at the start of the bar, compact, and not closed by accident (ADR-0027). Absent: not pinned. */
  pinned?: boolean;
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

/** How many tabs are pinned: they are the first ones of the list. */
export const pinnedCount = (state: TabsState): number => state.tabs.filter((t) => t.pinned).length;

export const isPinned = (state: TabsState, id: string): boolean => state.tabs.some((t) => t.id === id && t.pinned === true);

/** The indexes a tab may take: its own group, the pinned tabs or the others. */
function groupRange(state: TabsState, tab: Tab): [number, number] {
  const pinned = pinnedCount(state);
  return tab.pinned ? [0, pinned - 1] : [pinned, state.tabs.length - 1];
}

export function sameTarget(a: TabTarget, b: TabTarget): boolean {
  switch (a.kind) {
    case "page":
      return b.kind === "page" && a.path === b.path;
    case "workspace":
      return b.kind === "workspace" && a.server === b.server && a.workspace === b.workspace && a.page === b.page;
    case "settings":
      return b.kind === "settings";
    case "agent-run":
      return b.kind === "agent-run" && a.run === b.run;
    case "blank":
      return b.kind === "blank";
  }
}

function insertAfterActive(state: TabsState, target: TabTarget): TabsState {
  if (state.tabs.length >= MAX_TABS) {
    // Full: the current tab shows it instead, or the last one when the current one is pinned (it keeps its page).
    const spare = activeTab(state).pinned ? [...state.tabs].reverse().find((t) => !t.pinned) : activeTab(state);
    return spare ? { ...retarget(state, spare.id, target), active: spare.id } : state;
  }
  const seq = state.seq + 1;
  const tab: Tab = { id: makeId(seq), target };
  // Right after the current tab, as in a browser; never among the pinned tabs.
  const at = Math.max(activeIndex(state) + 1, pinnedCount(state));
  return { tabs: [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)], active: tab.id, seq };
}

/** Shows `target` in the tab `id` (a link followed in place). */
export function retarget(state: TabsState, id: string, target: TabTarget): TabsState {
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, target } : t)) };
}

/** Opens `target` in the current tab, or in a new one next to it. */
export function open(state: TabsState, target: TabTarget, options: OpenOptions = {}): TabsState {
  if (target.kind === "settings" || target.kind === "agent-run") {
    const existing = state.tabs.find((t) => (target.kind === "settings" ? t.target.kind === "settings" : sameTarget(t.target, target)));
    if (existing) return { ...retarget(state, existing.id, target), active: existing.id };
    return activeTab(state).target.kind === "blank" ? retarget(state, state.active, target) : insertAfterActive(state, target);
  }
  // A pinned tab keeps its page: what would replace it opens beside the pinned tabs instead.
  return options.newTab || activeTab(state).pinned ? insertAfterActive(state, target) : retarget(state, state.active, target);
}

/** A new, empty tab after the current one. */
export const newTab = (state: TabsState): TabsState => insertAfterActive(state, BLANK);

/**
 * Closes a tab. The current tab passes to the one on its right, else the one on its left. The last tab is replaced by
 * an empty one. A pinned tab is not closed (unpin it first): the same state comes back.
 */
export function close(state: TabsState, id: string): TabsState {
  const at = state.tabs.findIndex((t) => t.id === id);
  if (at < 0 || state.tabs[at]!.pinned) return state;
  return closeAt(state, id, at);
}

/** Takes the tab `id` out even when it is pinned: it has left for another window (`detach`). */
export function removeTab(state: TabsState, id: string): TabsState {
  const at = state.tabs.findIndex((t) => t.id === id);
  return at < 0 ? state : closeAt(state, id, at);
}

/** Closing without the pinned check. */
function closeAt(state: TabsState, id: string, at: number): TabsState {
  if (state.tabs.length === 1) {
    const seq = state.seq + 1;
    return { tabs: [{ id: makeId(seq), target: BLANK }], active: makeId(seq), seq };
  }
  const tabs = state.tabs.filter((t) => t.id !== id);
  const active = id === state.active ? (tabs[Math.min(at, tabs.length - 1)]!.id) : state.active;
  return { ...state, tabs, active };
}

/** "Close other tabs": every tab but `id` and the pinned ones. `id` becomes current. */
export function closeOthers(state: TabsState, id: string): TabsState {
  if (!state.tabs.some((t) => t.id === id)) return state;
  const tabs = state.tabs.filter((t) => t.id === id || t.pinned);
  return tabs.length === state.tabs.length && state.active === id ? state : { ...state, tabs, active: id };
}

/**
 * Pins (`pinned`) or unpins the tab `id`. A tab being pinned goes to the end of the pinned tabs, one being unpinned to
 * the start of the others, so the pinned tabs stay together at the start. The current tab does not change.
 */
export function setPinned(state: TabsState, id: string, pinned: boolean): TabsState {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab || Boolean(tab.pinned) === pinned || (pinned && tab.target.kind === "blank")) return state;
  const rest = state.tabs.filter((t) => t.id !== id);
  const count = rest.filter((t) => t.pinned).length;
  const changed: Tab = pinned ? { ...tab, pinned: true } : { id: tab.id, target: tab.target };
  return { ...state, tabs: [...rest.slice(0, count), changed, ...rest.slice(count)] };
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
 * Moves the tab `id` to index `to` of the list (ADR-0019: a pointer drag in the tab bar, the palette, the tab's
 * menu). An index past either end is that end. The current tab stays the current tab; ids do not change.
 */
export function move(state: TabsState, id: string, to: number): TabsState {
  const from = state.tabs.findIndex((t) => t.id === id);
  if (from < 0) return state;
  // It stops at the boundary between the pinned tabs and the others (ADR-0027).
  const [lo, hi] = groupRange(state, state.tabs[from]!);
  const at = Math.max(lo, Math.min(Math.trunc(to), hi));
  if (at === from) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  tabs.splice(at, 0, state.tabs[from]!);
  return { ...state, tabs };
}

/** Alt/Option+Shift+Left and Right: the tab `id` one place (or `delta` places) along. It stops at the ends, as a browser's does. */
export function moveBy(state: TabsState, id: string, delta: number): TabsState {
  const from = state.tabs.findIndex((t) => t.id === id);
  if (from < 0) return state;
  const to = from + delta;
  const [lo, hi] = groupRange(state, state.tabs[from]!);
  return to < lo || to > hi ? state : move(state, id, to);
}

/**
 * The tab `id` leaves for a new window (ADR-0019): `source` is this window without it (the current tab passes on as
 * when it closes), `moved` is the new window's tabs (that one, current). A window's only tab cannot leave: the
 * window would be left with nothing but an empty tab. Null then, or for an unknown id. A pinned tab is pinned there too.
 */
export function detach(state: TabsState, id: string): { source: TabsState; moved: TabsState } | null {
  const at = state.tabs.findIndex((t) => t.id === id);
  const tab = state.tabs[at];
  if (!tab || state.tabs.length < 2) return null;
  const moved = initialTabs([tab.target]);
  return { source: closeAt(state, id, at), moved: tab.pinned ? setPinned(moved, moved.active, true) : moved };
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

/**
 * Stored form: targets and the current index. Names are never stored (the web client keeps no page titles). A pinned
 * tab adds `pin: true` to its entry (ADR-0027); older versions ignore the field, and lists stored before it read as
 * unpinned, so the version stays 1.
 */
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
    case "agent-run":
      return { k: "run", run: target.run };
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
      return v["section"] === "servers" || v["section"] === "agents" || v["section"] === "import" ? { kind: "settings", section: v["section"] } : { kind: "settings" };
    case "run":
      return typeof v["run"] === "string" && isStableId(v["run"]) ? { kind: "agent-run", run: v["run"] } : null;
    // The old single review tab ({ k: "agents" }) showed the current run; no run is current at start, so it is dropped.
    case "blank":
      return BLANK;
    default:
      return null;
  }
}

export function serializeTabs(state: TabsState): string {
  const entry = (t: Tab): unknown => (t.pinned ? { ...(storedTarget(t.target) as object), pin: true } : storedTarget(t.target));
  const stored: Stored = { v: 1, active: activeIndex(state), tabs: state.tabs.map(entry) };
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
  const pinned: boolean[] = [];
  // The current tab, or the first kept one after it when it was dropped; the last one when none is left after it.
  let active = -1;
  stored.tabs.slice(0, MAX_TABS).forEach((value, i) => {
    const target = targetFromStored(value);
    if (!target || !keep(target)) return;
    if (active < 0 && i >= wanted) active = targets.length;
    targets.push(target);
    pinned.push(target.kind !== "blank" && (value as { pin?: unknown }).pin === true);
  });
  const state = initialTabs(targets, active < 0 ? targets.length - 1 : active);
  if (!pinned.includes(true)) return state;
  // Pinned tabs first, each group in its stored order (a list edited by hand may have them anywhere).
  const tabs = state.tabs.map((t, i) => (pinned[i] ? { ...t, pinned: true } : t));
  return { ...state, tabs: [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)] };
}
