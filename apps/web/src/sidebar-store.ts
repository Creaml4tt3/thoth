/**
 * The sidebar width the person chose by dragging its edge, per browser. One localStorage key holds one whole number of
 * pixels: nothing about the account, the workspaces or the pages. The default width is stored as nothing. Whether the
 * whole sidebar is hidden is a second key, "1" while it is hidden and nothing otherwise.
 */
import { parseSidebarWidth } from "@thoth/app-ui/ui/SidebarResizer.tsx";
import type { WebEnv } from "./env.ts";

export const SIDEBAR_KEY = "thoth.web.sidebar";
export const SIDEBAR_HIDDEN_KEY = "thoth.web.sidebar.hidden";

type Store = Pick<NonNullable<WebEnv["localStorage"]>, "getItem" | "setItem"> & { removeItem?(key: string): void };

export function loadSidebarWidth(storage: Store | null): number | null {
  try {
    return parseSidebarWidth(storage?.getItem(SIDEBAR_KEY));
  } catch {
    return null;
  }
}

export function saveSidebarWidth(storage: Store | null, width: number | null): void {
  try {
    if (width === null) {
      if (storage?.removeItem) storage.removeItem(SIDEBAR_KEY);
      else storage?.setItem(SIDEBAR_KEY, "");
    } else storage?.setItem(SIDEBAR_KEY, String(width));
  } catch {
    // private mode or a full quota: the width lasts for this visit
  }
}

export function loadSidebarHidden(storage: Store | null): boolean {
  try {
    return storage?.getItem(SIDEBAR_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSidebarHidden(storage: Store | null, hidden: boolean): void {
  try {
    if (hidden) storage?.setItem(SIDEBAR_HIDDEN_KEY, "1");
    else if (storage?.removeItem) storage.removeItem(SIDEBAR_HIDDEN_KEY);
    else storage?.setItem(SIDEBAR_HIDDEN_KEY, "");
  } catch {
    // private mode or a full quota: it lasts for this visit
  }
}
