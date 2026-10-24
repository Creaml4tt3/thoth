/**
 * Open tabs come back on reload, per browser (ADR-0016 rule 5). The stored text holds ids only (server, workspace and
 * page ids): no page titles, and nothing about the sign-in, which ADR-0015 rule 1 keeps out of localStorage. Titles are
 * read from the workspace tree each time. Signing out clears the key.
 */
import { initialTabs, parseTabs, serializeTabs, type TabTarget, type TabsState } from "@thoth/app-ui/tabs/model.ts";
import type { WebEnv } from "./env.ts";
import { SERVER_ID } from "./servers.ts";

export const TABS_KEY = "thoth.web.tabs";

type Store = Pick<NonNullable<WebEnv["localStorage"]>, "getItem" | "setItem">;

/** The web client only has workspace pages and Settings; anything else (a desktop leftover) is dropped. */
const supported = (target: TabTarget): boolean => target.kind === "settings" || target.kind === "blank" || (target.kind === "workspace" && target.server === SERVER_ID);

export function loadTabs(storage: Store | null): TabsState {
  try {
    return parseTabs(storage?.getItem(TABS_KEY), supported) ?? initialTabs();
  } catch {
    return initialTabs();
  }
}

export function saveTabs(storage: Store | null, state: TabsState): void {
  try {
    storage?.setItem(TABS_KEY, serializeTabs(state));
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
