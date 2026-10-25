/**
 * The sidebar width the person chose by dragging its edge, per Private Space. Like the open tabs, the language and the
 * theme it is an app preference kept in the webview's localStorage; the key names the vault's folder. Only a width is
 * stored, and nothing at all when it is the default.
 */
import { parseSidebarWidth } from "@thoth/app-ui/ui/SidebarResizer.tsx";

export const SIDEBAR_KEY_PREFIX = "thoth.desktop.sidebar.";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage can be disabled; the width then lasts for the session
  }
}

export const sidebarKey = (root: string): string => `${SIDEBAR_KEY_PREFIX}${root}`;

/** The saved width of a Private Space's sidebar, or null for the default. */
export function loadSidebarWidth(root: string): number | null {
  try {
    return parseSidebarWidth(storage()?.getItem(sidebarKey(root)));
  } catch {
    return null;
  }
}

export function saveSidebarWidth(root: string, width: number | null): void {
  try {
    if (width === null) storage()?.removeItem(sidebarKey(root));
    else storage()?.setItem(sidebarKey(root), String(width));
  } catch {
    // quota or privacy mode: the width lasts for the session
  }
}
