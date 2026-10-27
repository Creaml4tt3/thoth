/**
 * Open tabs come back on restart, per Private Space (ADR-0016 rule 5) and per window (ADR-0019). Like the language, the
 * theme and the default editor mode, they are an app preference kept in the webview's localStorage; the key names the
 * vault's folder, so each Private Space has its own tabs, and a window the app opened adds its id (the main window keeps
 * the key it always had). Tabs whose page is gone are dropped by the shell once it knows the pages.
 */
import { emptyLayout, parseLayout, serializeLayout, type Layout } from "@thoth/app-ui/tabs/layout.ts";
import type { TabTarget } from "@thoth/app-ui/tabs/model.ts";
import { MAIN_WINDOW } from "./windows.ts";

export const TABS_KEY_PREFIX = "thoth.desktop.tabs.";

/** The desktop has no Home tab (ADR-0029, amendment of 2026-10-28): one saved before is dropped. */
export const desktopTab = (target: TabTarget): boolean => target.kind !== "home";

/** Stored tabs (a saved layout, or the ones a new window is opened with) as the desktop shows them. */
export const parseDesktopLayout = (raw: string | null | undefined): Layout | null => parseLayout(raw, desktopTab);

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage can be disabled; the tabs then last for the session
  }
}

export const tabsKey = (root: string, window: string = MAIN_WINDOW): string => `${TABS_KEY_PREFIX}${root}${window === MAIN_WINDOW ? "" : `#${window}`}`;

/** The saved tabs (panes, ADR-0030) of a Private Space in this window, or one empty tab. */
export function loadTabs(root: string, window: string = MAIN_WINDOW): Layout {
  try {
    return parseDesktopLayout(storage()?.getItem(tabsKey(root, window))) ?? emptyLayout();
  } catch {
    return emptyLayout();
  }
}

export function saveTabs(root: string, layout: Layout, window: string = MAIN_WINDOW): void {
  try {
    storage()?.setItem(tabsKey(root, window), serializeLayout(layout));
  } catch {
    // quota or privacy mode: the tabs last for the session
  }
}

export function clearTabs(root: string, window: string = MAIN_WINDOW): void {
  try {
    storage()?.removeItem(tabsKey(root, window));
  } catch {
    // nothing to clear
  }
}
