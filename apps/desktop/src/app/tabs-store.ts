/**
 * Open tabs come back on restart, per Private Space (ADR-0016 rule 5) and per window (ADR-0019). Like the language, the
 * theme and the default editor mode, they are an app preference kept in the webview's localStorage; the key names the
 * vault's folder, so each Private Space has its own tabs, and a window the app opened adds its id (the main window keeps
 * the key it always had). Tabs whose page is gone are dropped by the shell once it knows the pages.
 */
import { initialTabs, parseTabs, serializeTabs, type TabsState } from "@thoth/app-ui/tabs/model.ts";
import { MAIN_WINDOW } from "./windows.ts";

export const TABS_KEY_PREFIX = "thoth.desktop.tabs.";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage can be disabled; the tabs then last for the session
  }
}

export const tabsKey = (root: string, window: string = MAIN_WINDOW): string => `${TABS_KEY_PREFIX}${root}${window === MAIN_WINDOW ? "" : `#${window}`}`;

/** The saved tabs of a Private Space in this window, or one empty tab. */
export function loadTabs(root: string, window: string = MAIN_WINDOW): TabsState {
  try {
    return parseTabs(storage()?.getItem(tabsKey(root, window))) ?? initialTabs();
  } catch {
    return initialTabs();
  }
}

export function saveTabs(root: string, state: TabsState, window: string = MAIN_WINDOW): void {
  try {
    storage()?.setItem(tabsKey(root, window), serializeTabs(state));
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
