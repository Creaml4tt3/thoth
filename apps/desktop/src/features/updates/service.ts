/**
 * The update notice of one window (ADR-0022). It asks the host whether a newer desktop version is out right after the
 * window opens (2 seconds) and then every 24 hours while it is open, and keeps the answer the popup shows. The host
 * does the asking (the webview has no network): it asks once per start of the app, then at most once in 24 hours
 * across its windows, and never when the person turned the notice off. This only schedules, remembers "Later" for the
 * session, and passes "Skip this version" to the host, which keeps it.
 */
import type { Updates, Links, UpdateCheck } from "@thoth/platform";

/** The newer version the popup tells of. */
export interface UpdateOffer {
  version: string;
  /** `yyyy-mm-dd`, when the host has one. */
  date?: string;
  downloadUrl: string;
  notesUrl?: string;
}

/** What the last check found, for Settings. `idle`: none yet in this window. */
export type CheckStatus = "idle" | "checking" | "current" | "available" | "failed" | "off";

export interface UpdateServiceState {
  /** The popup shows while this is set. */
  offer: UpdateOffer | null;
  /** The version last found in this window, shown or not (Later closes the popup, not this). */
  latest: UpdateOffer | null;
  status: CheckStatus;
}

export interface UpdateService {
  subscribe(listener: () => void): () => void;
  getState(): UpdateServiceState;
  /** Starts the schedule: the first check after the delay, then one per interval. Returns the function that stops it. */
  start(): () => void;
  /** "Check now": asks at once, whatever the wait, and shows a newer version even if the person skipped it. */
  checkNow(): Promise<void>;
  /** "Later": closes the popup. It comes back at the next check. */
  later(): void;
  /** "Skip this version": the host remembers it until a newer one appears. */
  skip(): Promise<void>;
  /** Shows the popup again for the version last found (the notification list's entry). */
  show(): void;
  /** Opens the downloads page in the browser, through the host, and closes the popup. */
  download(): Promise<void>;
  /** Opens the release notes in the browser, through the host. The popup stays. */
  notes(): Promise<void>;
}

export interface UpdateServiceOptions {
  /** Time to the first check after `start`. */
  delayMs: number;
  /** Time between checks after that. */
  intervalMs: number;
  /** Called when the popup is shown for a version it was not already showing (it adds the notification entry). */
  onOffer?(offer: UpdateOffer): void;
}

/** What a "Check now" that found nothing new says. `waiting` cannot happen for it (it skips the wait). */
function statusOf(answer: Exclude<UpdateCheck, { state: "available" }>): CheckStatus {
  return answer.state === "current" || answer.state === "waiting" ? "current" : answer.state === "failed" ? "failed" : "off";
}

export function createUpdateService(updates: Updates, links: Links | undefined, options: UpdateServiceOptions): UpdateService {
  let state: UpdateServiceState = { offer: null, latest: null, status: "idle" };
  let running: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Partial<UpdateServiceState>) => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  };

  const offer = (found: UpdateOffer) => {
    const same = state.offer?.version === found.version;
    set({ offer: found, latest: found, status: "available" });
    if (!same) options.onOffer?.(found);
  };

  /** One check. `manual`: the person asked, so the wait is skipped and a skipped version is shown anyway. */
  const run = (manual: boolean): Promise<void> => {
    // A check is on its way: "Check now" waits for it, then asks for itself (the wait is skipped).
    if (running) return manual ? running.then(() => run(true)) : running;
    if (manual) set({ status: "checking" });
    running = (async () => {
      try {
        const answer = await updates.check(manual ? { force: true } : undefined);
        if (answer.state === "available") {
          const { version, date, downloadUrl, notesUrl, skipped } = answer.update;
          if (manual || !skipped) offer({ version, downloadUrl, ...(date ? { date } : {}), ...(notesUrl ? { notesUrl } : {}) });
        } else if (manual) {
          set({ status: statusOf(answer) });
        }
      } catch {
        // The host could not be asked. A check by itself says nothing; "Check now" says it did not work.
        if (manual) set({ status: "failed" });
      } finally {
        running = null;
      }
    })();
    return running;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => state,
    start() {
      let interval: ReturnType<typeof setInterval> | undefined;
      const first = setTimeout(() => {
        void run(false);
        interval = setInterval(() => void run(false), options.intervalMs);
      }, options.delayMs);
      return () => {
        clearTimeout(first);
        if (interval !== undefined) clearInterval(interval);
      };
    },
    checkNow: () => run(true),
    later: () => set({ offer: null }),
    async skip() {
      const version = state.offer?.version ?? state.latest?.version;
      set({ offer: null });
      if (version) await updates.skip(version).catch(() => undefined);
    },
    show() {
      if (state.latest) set({ offer: state.latest });
    },
    async download() {
      const url = state.offer?.downloadUrl;
      if (!url) return;
      set({ offer: null });
      await links?.open(url);
    },
    async notes() {
      const url = state.offer?.notesUrl;
      if (url) await links?.open(url);
    },
  };
}
