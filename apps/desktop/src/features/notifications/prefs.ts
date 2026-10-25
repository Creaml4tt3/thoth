/**
 * Settings → Notifications (ADR-0018): system notifications on or off, and per kind. The user's, not the Private
 * Space's: kept with the other desktop preferences in the webview's storage, never in the vault.
 */
import { DEFAULT_NOTIFICATION_SETTINGS, NOTIFICATION_KINDS, type NotificationKind, type NotificationSettings } from "@thoth/app-ui/notifications/core.ts";

export const NOTIFICATION_PREFS_KEY = "thoth.desktop.notifications";

/** Settings from stored text; anything missing or not a boolean is on (the default). */
export function parseNotificationPrefs(raw: string | null | undefined): NotificationSettings {
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  const o = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const stored = typeof o["kinds"] === "object" && o["kinds"] !== null ? (o["kinds"] as Record<string, unknown>) : {};
  const kinds = Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, typeof stored[k] === "boolean" ? stored[k] : DEFAULT_NOTIFICATION_SETTINGS.kinds[k]])) as Record<NotificationKind, boolean>;
  return { system: typeof o["system"] === "boolean" ? o["system"] : DEFAULT_NOTIFICATION_SETTINGS.system, kinds };
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadNotificationPrefs(): NotificationSettings {
  try {
    return parseNotificationPrefs(storage()?.getItem(NOTIFICATION_PREFS_KEY));
  } catch {
    return parseNotificationPrefs(null);
  }
}

export function saveNotificationPrefs(prefs: NotificationSettings): void {
  try {
    storage()?.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // quota or privacy mode: the settings last for the session
  }
}

export interface NotificationPrefsStore {
  subscribe(listener: () => void): () => void;
  get(): NotificationSettings;
  setSystem(on: boolean): void;
  setKind(kind: NotificationKind, on: boolean): void;
}

/** One store per window, so the settings section and the notification center read the same values. */
export function createNotificationPrefsStore(initial: NotificationSettings = loadNotificationPrefs(), save: (prefs: NotificationSettings) => void = saveNotificationPrefs): NotificationPrefsStore {
  let prefs = initial;
  const listeners = new Set<() => void>();
  const update = (next: NotificationSettings) => {
    prefs = next;
    save(next);
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => prefs,
    setSystem: (on) => update({ ...prefs, system: on }),
    setKind: (kind, on) => update({ ...prefs, kinds: { ...prefs.kinds, [kind]: on } }),
  };
}
