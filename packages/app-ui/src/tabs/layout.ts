/**
 * The split view (ADR-0030): a window's panes, side by side, as plain data on top of the single-strip model
 * (`model.ts`), whose functions still work on one pane. The functions here find the pane and call them.
 *
 * - One or two panes (`MAX_PANES`; nothing else here assumes two, so more can come later). Each pane is a
 *   `TabsState` with its own current tab; `active` is the pane that new pages, shortcuts and the palette act on.
 * - Tab ids are unique across the window: every operation on a pane starts from the highest counter of all panes.
 * - Home, Settings and an assistant session are one per window: opening one that the other pane shows goes there.
 * - A pane whose last tab leaves (moved, closed, sent to a window) closes; the only pane never does.
 */
import * as model from "./model.ts";
import { BLANK, MAX_TABS, type OpenOptions, type Tab, type TabTarget, type TabsState } from "./model.ts";

export interface Layout {
  /** One or two panes, left to right. */
  panes: readonly TabsState[];
  /** The index of the active pane. */
  active: number;
  /** The first pane's share of the width (0.5: half). */
  ratio: number;
}

export const MAX_PANES = 2;
export const DEFAULT_RATIO = 0.5;
export const RATIO_MIN = 0.1;
export const RATIO_MAX = 0.9;

export const single = (state: TabsState): Layout => ({ panes: [state], active: 0, ratio: DEFAULT_RATIO });

export const activePane = (layout: Layout): TabsState => layout.panes[layout.active] ?? layout.panes[0]!;
export const activeTabOf = (layout: Layout): Tab => model.activeTab(activePane(layout));

/** The index of the pane that holds the tab `id`, or -1. */
export const paneOf = (layout: Layout, id: string): number => layout.panes.findIndex((p) => p.tabs.some((t) => t.id === id));

/** Every tab of the window, pane by pane. */
export const allTabs = (layout: Layout): Tab[] => layout.panes.flatMap((p) => p.tabs);

const topSeq = (layout: Layout): number => Math.max(...layout.panes.map((p) => p.seq));

/** Applies `change` to the pane `index`, starting from the window's highest id counter (ids stay unique). */
function withPane(layout: Layout, index: number, change: (state: TabsState) => TabsState): Layout {
  const pane = layout.panes[index];
  if (!pane) return layout;
  const seq = topSeq(layout);
  const before = pane.seq === seq ? pane : { ...pane, seq };
  const after = change(before);
  if (after === before) return layout;
  return { ...layout, panes: layout.panes.map((p, i) => (i === index ? after : p)) };
}

/** Takes the pane `index` out; the remaining pane becomes active. */
function dropPane(layout: Layout, index: number): Layout {
  const panes = layout.panes.filter((_, i) => i !== index);
  const active = layout.active === index ? Math.min(index, panes.length - 1) : layout.active > index ? layout.active - 1 : layout.active;
  return { ...layout, panes, active };
}

export function focusPane(layout: Layout, index: number): Layout {
  return index >= 0 && index < layout.panes.length && index !== layout.active ? { ...layout, active: index } : layout;
}

/** The other pane (Alt/Option+Shift+\, F6); nothing with one pane. */
export const focusOther = (layout: Layout): Layout => (layout.panes.length < 2 ? layout : focusPane(layout, (layout.active + 1) % layout.panes.length));

export function setRatio(layout: Layout, ratio: number): Layout {
  const r = Number.isFinite(ratio) ? Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio)) : DEFAULT_RATIO;
  return r === layout.ratio ? layout : { ...layout, ratio: r };
}

/** The pane and tab that show the one-per-window target (Home, Settings, a session), if any. */
function findOnePerWindow(layout: Layout, target: TabTarget): { pane: number; tab: Tab } | null {
  for (let pane = 0; pane < layout.panes.length; pane++) {
    const tab = layout.panes[pane]!.tabs.find((t) => (target.kind === "settings" ? t.target.kind === "settings" : model.sameTarget(t.target, target)));
    if (tab) return { pane, tab };
  }
  return null;
}

export function open(layout: Layout, target: TabTarget, options: OpenOptions = {}): Layout {
  if (target.kind === "settings" || target.kind === "agent-run" || target.kind === "home") {
    const found = findOnePerWindow(layout, target);
    if (found) return withPane({ ...layout, active: found.pane }, found.pane, (s) => model.open(s, target, options));
  }
  return withPane(layout, layout.active, (s) => model.open(s, target, options));
}

/** The tab that shows `target` in either pane becomes current (and its pane active); else it opens in the active pane. */
export function openOrFocus(layout: Layout, target: TabTarget): Layout {
  for (let pane = 0; pane < layout.panes.length; pane++) {
    const tab = layout.panes[pane]!.tabs.find((t) => model.sameTarget(t.target, target));
    if (tab) return activate(layout, tab.id);
  }
  return withPane(layout, layout.active, (s) => model.openOrFocus(s, target));
}

export const newTab = (layout: Layout): Layout => withPane(layout, layout.active, model.newTab);

/** The tab `id` becomes current, and its pane active. */
export function activate(layout: Layout, id: string): Layout {
  const pane = paneOf(layout, id);
  if (pane < 0) return layout;
  return withPane(focusPane(layout, pane), pane, (s) => model.activate(s, id));
}

export const step = (layout: Layout, delta: number): Layout => withPane(layout, layout.active, (s) => model.step(s, delta));
export const jump = (layout: Layout, n: number): Layout => withPane(layout, layout.active, (s) => model.jump(s, n));

/** Closes `id` (not a pinned one). The last tab of a pane closes the pane, unless it is the only pane. */
export function close(layout: Layout, id: string): Layout {
  const pane = paneOf(layout, id);
  if (pane < 0 || model.isPinned(layout.panes[pane]!, id)) return layout;
  return removeTab(layout, id);
}

/** Takes the tab `id` out even when pinned (it left for another window); its pane closes if it was the last. */
export function removeTab(layout: Layout, id: string): Layout {
  const pane = paneOf(layout, id);
  if (pane < 0) return layout;
  if (layout.panes[pane]!.tabs.length === 1 && layout.panes.length > 1) return dropPane(layout, pane);
  return withPane(layout, pane, (s) => model.removeTab(s, id));
}

/** "Close other tabs" within the pane of `id`. */
export function closeOthers(layout: Layout, id: string): Layout {
  const pane = paneOf(layout, id);
  return pane < 0 ? layout : withPane(focusPane(layout, pane), pane, (s) => model.closeOthers(s, id));
}

export function setPinned(layout: Layout, id: string, pinned: boolean): Layout {
  const pane = paneOf(layout, id);
  return pane < 0 ? layout : withPane(layout, pane, (s) => model.setPinned(s, id, pinned));
}

export function move(layout: Layout, id: string, to: number): Layout {
  const pane = paneOf(layout, id);
  return pane < 0 ? layout : withPane(layout, pane, (s) => model.move(s, id, to));
}

export function moveBy(layout: Layout, id: string, delta: number): Layout {
  const pane = paneOf(layout, id);
  return pane < 0 ? layout : withPane(layout, pane, (s) => model.moveBy(s, id, delta));
}

export function prune(layout: Layout, gone: (target: TabTarget) => boolean): Layout {
  return layout.panes.reduce((l, _, i) => withPane(l, i, (s) => model.prune(s, gone)), layout);
}

export function remapPaths(layout: Layout, from: string, to: string): Layout {
  return layout.panes.reduce((l, _, i) => withPane(l, i, (s) => model.remapPaths(s, from, to)), layout);
}

/** Puts `tab` into `state` at `index` (clamped to its group: pinned or not), or after the current tab; it becomes current. */
function insertTab(state: TabsState, tab: Tab, index?: number): TabsState {
  const pinned = model.pinnedCount(state);
  const [lo, hi] = tab.pinned ? [0, pinned] : [pinned, state.tabs.length];
  const wanted = index ?? model.activeIndex(state) + 1;
  const at = Math.max(lo, Math.min(Math.trunc(wanted), hi));
  return { ...state, tabs: [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)], active: tab.id };
}

/**
 * Moves the tab `id` to the pane `to` (at `index` of its tabs, else after its current tab); `to` equal to the number of
 * panes makes a new pane on the right, when there is room. The tab becomes current there and that pane active. Its old
 * pane closes if it was its last tab; a split from the only pane's only tab leaves a new tab behind instead.
 */
export function moveToPane(layout: Layout, id: string, to: number, index?: number): Layout {
  const from = paneOf(layout, id);
  if (from < 0 || to === from || to < 0 || to > layout.panes.length) return layout;
  const tab = layout.panes[from]!.tabs.find((t) => t.id === id)!;
  if (to === layout.panes.length) {
    if (layout.panes.length >= MAX_PANES) return layout;
    const source = withPane(layout, from, (s) => model.removeTab(s, id));
    const seq = topSeq(source);
    const pane: TabsState = { tabs: [tab], active: tab.id, seq };
    return { ...source, panes: [...source.panes, pane], active: source.panes.length };
  }
  if (layout.panes[to]!.tabs.length >= MAX_TABS) return layout;
  const moved = withPane(layout, to, (s) => insertTab(s, tab, index));
  if (moved.panes[from]!.tabs.length === 1) return dropPane({ ...moved, active: to }, from);
  return { ...withPane(moved, from, (s) => model.removeTab(s, id)), active: to };
}

/** "Split right": the tab into a new right pane; with two panes already, to the other pane. */
export function split(layout: Layout, id: string): Layout {
  const from = paneOf(layout, id);
  if (from < 0) return layout;
  return layout.panes.length < MAX_PANES ? moveToPane(layout, id, layout.panes.length) : moveToPane(layout, id, (from + 1) % layout.panes.length);
}

/**
 * The tab `id` leaves for a new window (ADR-0019 rule 11): `moved` is the new window's tabs (that one, pinned if it
 * was), `source` this window without it. A window's only tab cannot leave: null then, or for an unknown id.
 */
export function detach(layout: Layout, id: string): { source: Layout; moved: TabsState } | null {
  const pane = paneOf(layout, id);
  if (pane < 0 || allTabs(layout).length < 2) return null;
  const tab = layout.panes[pane]!.tabs.find((t) => t.id === id)!;
  const moved = model.initialTabs([tab.target]);
  return { source: removeTab(layout, id), moved: tab.pinned ? model.setPinned(moved, moved.active, true) : moved };
}

// ---------------------------------------------------------------------------
// Storage (ADR-0030 rule 8)

interface StoredLayout {
  v: 2;
  active: number;
  ratio: number;
  panes: { active: number; tabs: unknown[] }[];
}

export function serializeLayout(layout: Layout): string {
  const stored: StoredLayout = { v: 2, active: layout.active, ratio: layout.ratio, panes: layout.panes.map(model.storedTabs) };
  return JSON.stringify(stored);
}

/** Gives the tabs of `state` the ids `t<start+1>`… so that two panes read back never share one. */
function renumber(state: TabsState, start: number): TabsState {
  const id = (i: number) => `t${start + i + 1}`;
  const at = model.activeIndex(state);
  const tabs = state.tabs.map((t, i) => ({ ...t, id: id(i) }));
  return { tabs, active: id(at), seq: start + tabs.length };
}

/**
 * A layout from stored text: `v: 2`, or a `v: 1` list as one pane. Null for anything unreadable (the app starts with
 * one new tab). Within it, what is unreadable is dropped: a tab (as in `v: 1`), a second Home or Settings, a pane left
 * with no tab; a ratio out of range is the default.
 */
export function parseLayout(raw: string | null | undefined, keep: (target: TabTarget) => boolean = () => true): Layout | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  if ((data as { v?: unknown }).v === 1) {
    const one = model.parseTabs(raw, keep);
    return one ? single(one) : null;
  }
  const stored = data as Partial<StoredLayout>;
  if (stored.v !== 2 || !Array.isArray(stored.panes)) return null;
  const seen = new Set<string>();
  /** Home and Settings once per window: the first pane that has it keeps it. */
  const once = (target: TabTarget): boolean => {
    if (target.kind !== "home" && target.kind !== "settings") return true;
    if (seen.has(target.kind)) return false;
    seen.add(target.kind);
    return true;
  };
  const panes: TabsState[] = [];
  const kept: number[] = [];
  stored.panes.slice(0, MAX_PANES).forEach((value, i) => {
    if (typeof value !== "object" || value === null || !Array.isArray((value as { tabs?: unknown }).tabs)) return;
    const pane = model.tabsFromStored((value as { tabs: unknown[] }).tabs, (value as { active?: unknown }).active, (t) => keep(t) && once(t));
    if (!pane) return;
    panes.push(renumber(pane, panes.reduce((n, p) => n + p.tabs.length, 0)));
    kept.push(i);
  });
  if (panes.length === 0) return null;
  const wanted = kept.indexOf(typeof stored.active === "number" ? stored.active : 0);
  const ratio = typeof stored.ratio === "number" && stored.ratio >= RATIO_MIN && stored.ratio <= RATIO_MAX ? stored.ratio : DEFAULT_RATIO;
  return { panes, active: wanted < 0 ? 0 : wanted, ratio };
}

/** A window with nothing open: one pane with one new tab. */
export const emptyLayout = (): Layout => single(model.initialTabs([BLANK]));
