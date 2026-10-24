/**
 * Open tabs come back on restart, per Private Space (ADR-0016 rule 5). Like the language, the theme and the default
 * editor mode, they are an app preference kept in the webview's localStorage; the key names the vault's folder, so
 * each Private Space has its own tabs. Tabs whose page is gone are dropped by the shell once it knows the pages.
 */
import { initialTabs, parseTabs, serializeTabs, type TabsState } from "@thoth/app-ui/tabs/model.ts";

export const TABS_KEY_PREFIX = "thoth.desktop.tabs.";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage can be disabled; the tabs then last for the session
  }
}

export const tabsKey = (root: string): string => `${TABS_KEY_PREFIX}${root}`;

/** The saved tabs of a Private Space, or one empty tab. */
export function loadTabs(root: string): TabsState {
  try {
    return parseTabs(storage()?.getItem(tabsKey(root))) ?? initialTabs();
  } catch {
    return initialTabs();
  }
}

export function saveTabs(root: string, state: TabsState): void {
  try {
    storage()?.setItem(tabsKey(root), serializeTabs(state));
  } catch {
    // quota or privacy mode: the tabs last for the session
  }
}
