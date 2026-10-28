/**
 * The update notice of one window (ADR-0022). It asks the host whether a newer desktop version is out right after the
 * window opens (2 seconds) and then every 24 hours while it is open, and keeps the answer the popup shows. The host
 * does the asking (the webview has no network): it asks once per start of the app, then at most once in 24 hours
 * across its windows, and never when the person turned the notice off. This only schedules, remembers "Later" for the
 * session, and passes "Skip this version" to the host, which keeps it.
 *
 * In-app updates (ADR-0034): where the host can update this copy and the person left it on, Update asks the host to
 * download, check and install the new version. The host keeps one update for the whole app and sends its progress to
 * every window; this mirrors it. "Restart now" writes this window's edits first (`flush`) and does not restart if a save
 * fails; while an assistant run is going the host answers `busy` and the person chooses.
 */
import type { InstallState, Updates, Links, UpdateCheck } from "@thoth/platform";

/** The newer version the popup tells of. */
export interface UpdateOffer {
  version: string;
  /** `yyyy-mm-dd`, when the host has one. */
  date?: string;
  downloadUrl: string;
  notesUrl?: string;
  /** Update installs it in the app (ADR-0034); false: Download opens the downloads page. */
  inApp: boolean;
}

/** Why "Restart now" did not restart: a save failed, or assistant runs are going (the person may restart anyway). */
export type RestartProblem = { kind: "save" } | { kind: "busy"; runs: number };

/** What the last check found, for Settings. `idle`: none yet in this window. */
export type CheckStatus = "idle" | "checking" | "current" | "available" | "failed" | "off";

export interface UpdateServiceState {
  /** The popup shows while this is set. */
  offer: UpdateOffer | null;
  /** The version last found in this window, shown or not (Later closes the popup, not this). */
  latest: UpdateOffer | null;
  status: CheckStatus;
  /** The app's update, as the host has it (the same in every window). */
  install: InstallState;
  /** Set when "Restart now" stopped; cleared by the next try. */
  problem: RestartProblem | null;
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
  /** Update: the host downloads, checks and installs the new version (ADR-0034). */
  update(): Promise<void>;
  /** Cancel the download. */
  cancel(): Promise<void>;
  /** "Restart now": writes this window's edits, then asks the host to restart into the update. */
  restart(options?: { evenIfRunning?: boolean }): Promise<void>;
}

export interface UpdateServiceOptions {
  /** Time to the first check after `start`. */
  delayMs: number;
  /** Time between checks after that. */
  intervalMs: number;
  /** Called when the popup is shown for a version it was not already showing (it adds the notification entry). */
  onOffer?(offer: UpdateOffer): void;
  /** Writes this window's edits before a restart; false (or a throw) means a save failed. */
  flush?(): Promise<boolean>;
  /** The Private Space this window has open, opened again by the new version. */
  root?: string;
}

/** What a "Check now" that found nothing new says. `waiting` cannot happen for it (it skips the wait). */
function statusOf(answer: Exclude<UpdateCheck, { state: "available" }>): CheckStatus {
  return answer.state === "current" || answer.state === "waiting" ? "current" : answer.state === "failed" ? "failed" : "off";
}

export function createUpdateService(updates: Updates, links: Links | undefined, options: UpdateServiceOptions): UpdateService {
  let state: UpdateServiceState = { offer: null, latest: null, status: "idle", install: { phase: "idle" }, problem: null };
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

  /** The host's update changed. A finished or failed one brings the popup back (it may have been closed with Later). */
  const follow = (install: InstallState) => {
    const ended = (install.phase === "ready" || install.phase === "failed") && install.phase !== state.install.phase;
    set({ install, ...(ended && state.latest ? { offer: state.latest } : {}) });
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
          const { version, date, downloadUrl, notesUrl, skipped, inApp } = answer.update;
          if (manual || !skipped) offer({ version, downloadUrl, inApp: inApp === true, ...(date ? { date } : {}), ...(notesUrl ? { notesUrl } : {}) });
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
      let live = true;
      let stopEvents: (() => void) | undefined;
      // The host's update, at once (another window may have started it) and then as it changes.
      void updates
        .onProgress((install) => live && follow(install))
        .then((remove) => (live ? (stopEvents = remove) : remove()))
        .catch(() => undefined);
      void updates
        .status()
        .then((install) => live && state.install.phase === "idle" && follow(install))
        .catch(() => undefined);
      let interval: ReturnType<typeof setInterval> | undefined;
      const first = setTimeout(() => {
        void run(false);
        interval = setInterval(() => void run(false), options.intervalMs);
      }, options.delayMs);
      return () => {
        live = false;
        stopEvents?.();
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
      const url = (state.offer ?? state.latest)?.downloadUrl;
      if (!url) return;
      set({ offer: null });
      await links?.open(url);
    },
    async notes() {
      const url = state.offer?.notesUrl;
      if (url) await links?.open(url);
    },
    async update() {
      set({ problem: null });
      follow(await updates.install().catch((): InstallState => ({ phase: "failed", reason: "failed" })));
    },
    async cancel() {
      follow(await updates.cancel().catch(() => state.install));
    },
    async restart(restartOptions) {
      set({ problem: null });
      const saved = await (options.flush ?? (async () => true))().catch(() => false);
      if (!saved) return set({ problem: { kind: "save" } });
      const answer = await updates.restart({ ...restartOptions, ...(options.root ? { reopen: options.root } : {}) }).catch(() => null);
      if (answer === null) return follow({ phase: "failed", reason: "failed" });
      if (answer.state === "busy") return set({ problem: { kind: "busy", runs: answer.runs } });
      follow({ phase: "restarting" });
    },
  };
}
