/**
 * Open tabs come back on reload, per browser (ADR-0016 rule 5). The stored text holds ids only (server, workspace and
 * page ids): no page titles, and nothing about the sign-in, which ADR-0015 rule 1 keeps out of localStorage. Titles are
 * read from the workspace tree each time. Signing out clears the key.
 */
import type { TabTarget } from "@thoth/app-ui/tabs/model.ts";
import { emptyLayout, parseLayout, serializeLayout, type Layout } from "@thoth/app-ui/tabs/layout.ts";
import type { WebEnv } from "./env.ts";
import { SERVER_ID } from "./servers.ts";

export const TABS_KEY = "thoth.web.tabs";

type Store = Pick<NonNullable<WebEnv["localStorage"]>, "getItem" | "setItem">;

/** The web client only has workspace pages and Settings; anything else (a desktop leftover) is dropped. */
const supported = (target: TabTarget): boolean => target.kind === "settings" || target.kind === "blank" || target.kind === "home" || (target.kind === "workspace" && target.server === SERVER_ID);

export function loadTabs(storage: Store | null): Layout {
  try {
    return parseLayout(storage?.getItem(TABS_KEY), supported) ?? emptyLayout();
  } catch {
    return emptyLayout();
  }
}

export function saveTabs(storage: Store | null, layout: Layout): void {
  try {
    storage?.setItem(TABS_KEY, serializeLayout(layout));
  } catch {
    // private mode or a full quota: the tabs last for this visit
  }
}

/** Forgets the tabs (sign-out): an empty value reads as no tabs. */
export function clearTabs(storage: Store | null): void {
  try {
    storage?.setItem(TABS_KEY, "");
  } catch {
    // nothing to forget
  }
}
