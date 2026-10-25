/**
 * Which client and platform the shortcut hints are written for. The desktop shell and the web client each provide it
 * once at their root; a component deep in the shared UI (an icon button in the tab bar, the Close button of a dialog)
 * asks `useShortcutHint(id)` for the keys of that command on this client and platform, from the table in `shortcuts.ts`.
 */
import { createContext, useContext, useMemo } from "react";
import { currentPlatform, shortcutHint, type Client, type Platform, type ShortcutId } from "./shortcuts.ts";

export interface HintContextValue {
  client: Client;
  platform: Platform;
}

export const HintContext = createContext<HintContextValue | null>(null);

/** The keys of a command as a tooltip shows them, and as `aria-keyshortcuts` states them; null when the command has none here. */
export function useShortcutHint(id: ShortcutId): { keys: string; aria: string } | null {
  const ctx = useContext(HintContext);
  const client = ctx?.client ?? "desktop";
  const platform = ctx?.platform ?? currentPlatform();
  return useMemo(() => shortcutHint(id, client, platform), [id, client, platform]);
}
