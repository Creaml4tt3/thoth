/**
 * The sidebar width the person chose by dragging its edge, per browser. One localStorage key holds one whole number of
 * pixels: nothing about the account, the workspaces or the pages. The default width is stored as nothing.
 */
import { parseSidebarWidth } from "@thoth/app-ui/ui/SidebarResizer.tsx";
import type { WebEnv } from "./env.ts";

export const SIDEBAR_KEY = "thoth.web.sidebar";

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
