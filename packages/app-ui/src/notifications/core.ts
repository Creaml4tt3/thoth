/**
 * Notifications (ADR-0018): typed events, the in-app list with unread state, and the rule for system
 * notifications. No React and no Tauri: the desktop app and the web client each feed it events and give it a
 * `SystemNotifier` (the notification plugin on the desktop, nothing on the web).
 *
 * What a notification may say is fixed here, not by the callers: an event keeps only the fields of its kind, and
 * those are titles, names, counts and fixed reasons. Never page text, a task, agent output or a server's or CLI's
 * error message (they can quote content).
 */
import type { Strings } from "../strings/en.ts";

export type NotificationStrings = Strings["notifications"];

export const NOTIFICATION_KINDS = ["agentReview", "agentFinished", "agentFailed", "agentLimit", "transferDone", "transferFailed", "importDone", "importFailed", "saveConflict", "update"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** What an entry opens. */
export type NotificationTarget =
  | { kind: "agentRun"; runId: string }
  | { kind: "page"; path: string }
  | { kind: "workspacePage"; server: string; workspace: string; page: string }
  | { kind: "folder"; path: string }
  /** The popup for a new desktop version (ADR-0022). */
  | { kind: "update" };

/** Why a run failed, in words Thoth chose (never the CLI's message). */
export type AgentFailure = "notSignedIn" | "billing" | "rateLimit" | "modelNotFound" | "error";

interface Pages {
  /** Titles of the first pages (at most `MAX_TITLES`). */
  pages: string[];
  /** How many more pages there were. */
  more?: number;
}

export type NotificationEvent =
  | ({ kind: "agentReview" | "agentFinished"; runId: string; agent: string } & Pages)
  | ({ kind: "agentFailed"; runId: string; agent: string; reason: AgentFailure } & Pages)
  | ({ kind: "agentLimit"; runId: string; agent: string; limit: "time" | "budget"; review: boolean } & Pages)
  /** `where`: the workspace's name, or null for the Private Space. */
  | ({ kind: "transferDone" | "transferFailed"; transferId: string; mode: "copy" | "move"; where: string | null; open: NotificationTarget } & Pages)
  | { kind: "importDone" | "importFailed"; jobId: string; folder: string; pages: number }
  | { kind: "saveConflict"; page: string; open: NotificationTarget }
  /** A new desktop version is out (ADR-0022). Only in the list: it is never a system notification. */
  | { kind: "update"; version: string };

export interface NotificationEntry {
  id: string;
  /** Repeats of the same thing share a key (and an entry). */
  key: string;
  event: NotificationEvent;
  /** When it last happened (ms). */
  at: number;
  read: boolean;
  /** How many times it happened. */
  repeats: number;
}

export interface NotificationState {
  /** Newest first, at most `MAX_NOTIFICATIONS`. */
  entries: NotificationEntry[];
  unread: number;
  /** The text a polite live region says for the newest announced entry; `seq` changes with each. */
  announcement: { text: string; seq: number } | null;
  /** The entry last added (or repeated after `REPEAT_MS`): what the mascot shows a message for. */
  latest: { id: string; seq: number } | null;
}

/** System notifications, all and per kind (the in-app list always has every event). */
export interface NotificationSettings {
  system: boolean;
  kinds: Record<NotificationKind, boolean>;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  system: true,
  kinds: Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, true])) as Record<NotificationKind, boolean>,
};

/** The longest list kept. */
export const MAX_NOTIFICATIONS = 50;
/** A repeat within this time joins its entry quietly. */
export const REPEAT_MS = 60_000;
/** The longest title or name kept, in characters. */
export const MAX_NAME = 80;
/** Page titles kept per event; the rest is a count. */
export const MAX_TITLES = 3;

export interface SystemNotification {
  title: string;
  body: string;
}

/** Shows a notification outside the window. Resolves whether it was shown; never rejects on purpose. */
export interface SystemNotifier {
  readonly kind: "system" | "none";
  show(notification: SystemNotification): Promise<boolean>;
}

/** The web client's (and any host without system notifications). */
export const NO_SYSTEM_NOTIFIER: SystemNotifier = { kind: "none", show: async () => false };

/** The part of `@tauri-apps/plugin-notification` Thoth uses (passed in, so this module never names Tauri). */
export interface NotificationPlugin {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<string>;
  sendNotification(options: { title: string; body: string }): void;
}

/**
 * A notifier over the notification plugin. The plugin is loaded, and the OS permission asked for, only when the
 * first notification would be shown (never at start). After a refusal it is not asked again in this window.
 */
export function createPluginNotifier(load: () => Promise<NotificationPlugin>): SystemNotifier {
  let plugin: Promise<NotificationPlugin> | null = null;
  let asked = false;
  return {
    kind: "system",
    async show(notification) {
      try {
        plugin ??= load();
        const api = await plugin;
        let granted = await api.isPermissionGranted();
        if (!granted && !asked) {
          asked = true;
          granted = (await api.requestPermission()) === "granted";
        }
        if (!granted) return false;
        api.sendNotification({ title: notification.title, body: notification.body });
        return true;
      } catch {
        plugin = null;
        return false;
      }
    },
  };
}

// --- What an event may carry ---------------------------------------------------------------------------------

/** One line, no control characters, at most `MAX_NAME` characters. */
export function safeName(value: unknown): string {
  const text = String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...text];
  return chars.length <= MAX_NAME ? text : `${chars.slice(0, MAX_NAME - 1).join("").trimEnd()}…`;
}

const id = (value: unknown): string => String(value ?? "").slice(0, 200);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

function pages(e: Pages): Pages {
  const all = Array.isArray(e.pages) ? e.pages : [];
  const more = all.length - MAX_TITLES + count(e.more);
  return { pages: all.slice(0, MAX_TITLES).map(safeName), ...(more > 0 ? { more } : {}) };
}

function target(t: NotificationTarget): NotificationTarget {
  switch (t.kind) {
    case "agentRun":
      return { kind: "agentRun", runId: id(t.runId) };
    case "page":
      return { kind: "page", path: id(t.path) };
    case "folder":
      return { kind: "folder", path: id(t.path) };
    case "workspacePage":
      return { kind: "workspacePage", server: id(t.server), workspace: id(t.workspace), page: id(t.page) };
    case "update":
      return { kind: "update" };
  }
}

const FAILURES: readonly AgentFailure[] = ["notSignedIn", "billing", "rateLimit", "modelNotFound", "error"];

/** The event with only the fields of its kind, each cut to size. */
export function normalizeEvent(e: NotificationEvent): NotificationEvent {
  switch (e.kind) {
    case "agentReview":
    case "agentFinished":
      return { kind: e.kind, runId: id(e.runId), agent: safeName(e.agent), ...pages(e) };
    case "agentFailed":
      return { kind: e.kind, runId: id(e.runId), agent: safeName(e.agent), reason: FAILURES.includes(e.reason) ? e.reason : "error", ...pages(e) };
    case "agentLimit":
      return { kind: e.kind, runId: id(e.runId), agent: safeName(e.agent), limit: e.limit === "time" ? "time" : "budget", review: e.review === true, ...pages(e) };
    case "transferDone":
    case "transferFailed":
      return { kind: e.kind, transferId: id(e.transferId), mode: e.mode === "move" ? "move" : "copy", where: e.where === null ? null : safeName(e.where), open: target(e.open), ...pages(e) };
    case "importDone":
    case "importFailed":
      return { kind: e.kind, jobId: id(e.jobId), folder: safeName(e.folder), pages: count(e.pages) };
    case "saveConflict":
      return { kind: e.kind, page: safeName(e.page), open: target(e.open) };
    case "update":
      return { kind: e.kind, version: safeName(e.version) };
  }
}

/** What an entry opens. */
export function notificationTarget(e: NotificationEvent): NotificationTarget {
  switch (e.kind) {
    case "agentReview":
    case "agentFinished":
    case "agentFailed":
    case "agentLimit":
      return { kind: "agentRun", runId: e.runId };
    case "importDone":
    case "importFailed":
      return { kind: "folder", path: e.folder };
    case "update":
      return { kind: "update" };
    default:
      return e.open;
  }
}

/** Repeats of the same thing: the same kind about the same run, transfer, import or page. */
function keyOf(e: NotificationEvent): string {
  if (e.kind === "update") return `update\n${e.version}`;
  const t = notificationTarget(e);
  const about = t.kind === "workspacePage" ? `${t.server}\n${t.workspace}\n${t.page}` : t.kind === "agentRun" ? t.runId : t.kind === "update" ? "" : t.path;
  const subject = "transferId" in e ? e.transferId : "jobId" in e ? e.jobId : about;
  return `${e.kind}\n${subject}`;
}

/** The title and the line under it, for the list, the mascot and the system notification. */
export function describeNotification(e: NotificationEvent, t: NotificationStrings): SystemNotification {
  const list = (p: Pages) => t.pages(p.pages[0] ?? "", p.pages.length - 1 + (p.more ?? 0));
  const about = (agent: string, p: Pages) => (p.pages.length > 0 ? `${agent} · ${list(p)}` : agent);
  switch (e.kind) {
    case "agentReview":
      return { title: t.agentReview, body: about(e.agent, e) };
    case "agentFinished":
      return { title: t.agentFinished, body: about(e.agent, e) };
    case "agentFailed":
      return { title: t.agentFailed(t.failures[e.reason](e.agent)), body: about(e.agent, e) };
    case "agentLimit":
      return { title: e.limit === "time" ? t.agentLimitTime : t.agentLimitBudget, body: e.review ? `${about(e.agent, e)} · ${t.agentLimitReview}` : about(e.agent, e) };
    case "transferDone":
      return { title: t.transferDone(e.mode, e.where ?? t.privateSpace), body: list(e) };
    case "transferFailed":
      return { title: t.transferFailed(e.mode, e.where ?? t.privateSpace), body: list(e) };
    case "importDone":
      return { title: t.importDone, body: t.importBody(e.pages, e.folder) };
    case "importFailed":
      return { title: t.importFailed, body: t.importBody(e.pages, e.folder) };
    case "saveConflict":
      return { title: t.saveConflict(e.page), body: t.saveConflictBody };
    case "update":
      return { title: t.update(e.version), body: t.updateBody };
  }
}

// --- The list ------------------------------------------------------------------------------------------------

export interface NotificationCenterOptions {
  /** The current language's text (it can change while the window is open). */
  strings(): NotificationStrings;
  notifier?: SystemNotifier;
  settings?(): NotificationSettings;
  /** True while the window is not focused or is hidden. */
  background?(): boolean;
  /** Events another part of the app says aloud itself (the mascot says agent runs), so they are not said twice. */
  announcedElsewhere?(e: NotificationEvent): boolean;
  now?(): number;
}

export interface NotificationCenter {
  subscribe(listener: () => void): () => void;
  getState(): NotificationState;
  /** Adds an event (or joins it to its earlier entry) and shows a system notification when the rules allow. */
  push(event: NotificationEvent): NotificationEntry;
  markRead(id: string): void;
  markAllRead(): void;
  clear(): void;
}

/**
 * The list of one window, in memory only: nothing is written to disk or to the vault, and it is empty in a new
 * window (ADR-0018 rule 6).
 */
export function createNotificationCenter(options: NotificationCenterOptions): NotificationCenter {
  const notifier = options.notifier ?? NO_SYSTEM_NOTIFIER;
  const now = options.now ?? Date.now;
  let state: NotificationState = { entries: [], unread: 0, announcement: null, latest: null };
  let seq = 0;
  let announced = 0;
  const listeners = new Set<() => void>();
  const set = (entries: NotificationEntry[], announcement = state.announcement, latest = state.latest) => {
    state = { entries, unread: entries.filter((e) => !e.read).length, announcement, latest };
    for (const listener of [...listeners]) listener();
  };

  const system = (event: NotificationEvent, text: SystemNotification) => {
    // A new version is told in the app only (ADR-0022): the list and its popup, never the system's notification centre.
    if (event.kind === "update") return;
    const settings = options.settings?.() ?? DEFAULT_NOTIFICATION_SETTINGS;
    if (!settings.system || settings.kinds[event.kind] === false) return;
    if (!(options.background?.() ?? false)) return;
    void notifier.show(text).catch(() => false);
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => state,
    push(raw) {
      const event = normalizeEvent(raw);
      const key = keyOf(event);
      const at = now();
      const earlier = state.entries.find((e) => e.key === key);
      if (earlier && at - earlier.at <= REPEAT_MS) {
        const joined = { ...earlier, event, at, repeats: earlier.repeats + 1 };
        set(state.entries.map((e) => (e === earlier ? joined : e)));
        return joined;
      }
      const entry: NotificationEntry = { id: earlier?.id ?? `n${++seq}`, key, event, at, read: false, repeats: (earlier?.repeats ?? 0) + 1 };
      const text = describeNotification(event, options.strings());
      const say = options.announcedElsewhere?.(event) ? state.announcement : { text: `${text.title}. ${text.body}`, seq: ++announced };
      set([entry, ...state.entries.filter((e) => e !== earlier)].slice(0, MAX_NOTIFICATIONS), say, { id: entry.id, seq: (state.latest?.seq ?? 0) + 1 });
      system(event, text);
      return entry;
    },
    markRead(id) {
      if (state.entries.some((e) => e.id === id && !e.read)) set(state.entries.map((e) => (e.id === id ? { ...e, read: true } : e)));
    },
    markAllRead() {
      set(state.entries.map((e) => (e.read ? e : { ...e, read: true })));
    },
    clear() {
      set([]);
    },
  };
}
