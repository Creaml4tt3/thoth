import { useEffect, useRef } from "react";
import { currentPlatform, shortcutFor, type Client, type Platform, type ShortcutId } from "./shortcuts.ts";

/** What a global shortcut does. `digit` is set for `tab.jump` (1–9). */
export type ShortcutHandlers = Partial<Record<ShortcutId, (digit?: number) => void>>;

/** These two work over an open dialog (they close or open the palette and the list). The others wait until it is closed. */
const OVER_DIALOGS: ReadonlySet<ShortcutId> = new Set<ShortcutId>(["palette.open", "shortcuts.open"]);

/**
 * The window's global shortcuts, from the table (`shortcuts.ts`). A shortcut the app has no handler for is left to
 * the browser, so a view can offer a subset. A key that a focused editor or tree already handled (`defaultPrevented`)
 * is not taken twice. While a modal dialog is open only the palette and the shortcuts list react, so a tab cannot
 * change behind a dialog.
 */
export function useShortcuts(client: Client, handlers: ShortcutHandlers, platform: Platform = currentPlatform()): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const hit = shortcutFor(event, client, platform);
      if (!hit) return;
      const handler = latest.current[hit.id];
      if (!handler) return;
      if (!OVER_DIALOGS.has(hit.id) && document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      handler(hit.digit);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [client, platform]);
}
