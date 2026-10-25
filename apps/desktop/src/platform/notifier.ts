/**
 * The system notifier for this runtime (ADR-0018): Tauri's notification plugin in the desktop app, nothing
 * elsewhere. The plugin is imported, and the OS permission asked for, only when the first notification would be
 * shown. An injected plugin (`window.__THOTH_NOTIFICATION_PLUGIN__`, the e2e bridge's spy) comes first, like an
 * injected platform.
 */
import { NO_SYSTEM_NOTIFIER, createPluginNotifier, type SystemNotifier } from "@thoth/app-ui/notifications/core.ts";

export function selectNotifier(win: Window = window): SystemNotifier {
  const injected = win.__THOTH_NOTIFICATION_PLUGIN__;
  if (injected) return createPluginNotifier(async () => injected);
  if (win.__TAURI_INTERNALS__ !== undefined) return createPluginNotifier(() => import("@tauri-apps/plugin-notification"));
  return NO_SYSTEM_NOTIFIER;
}

/**
 * Whether the window is in the background (not focused, or hidden), from the window's own events: a system
 * notification is shown only then.
 */
export function createWindowPresence(win: Window = window): { background(): boolean; dispose(): void } {
  const doc = win.document;
  // The window may open behind another app: ask the document, not only the events that follow.
  let focused = doc.visibilityState !== "hidden" && doc.hasFocus();
  const onFocus = () => void (focused = true);
  const onBlur = () => void (focused = false);
  win.addEventListener("focus", onFocus);
  win.addEventListener("blur", onBlur);
  return {
    background: () => doc.visibilityState === "hidden" || !focused,
    dispose() {
      win.removeEventListener("focus", onFocus);
      win.removeEventListener("blur", onBlur);
    },
  };
}
