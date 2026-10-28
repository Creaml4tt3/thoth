import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Vault } from "@thoth/local-store";
import type { Platform, VaultConnection } from "@thoth/platform";
import { STRINGS, StringsContext } from "@thoth/app-ui/strings/index.ts";
import { DESKTOP_STRINGS, DesktopStringsContext, LangPreferenceContext, langPreference, resolveLang, setLangPreference, systemLanguages, type LangPreference } from "../strings/index.ts";
import { Onboarding } from "../features/onboarding/Onboarding.tsx";
import { openImportSource } from "../features/import/open-source.ts";
import { STARTER_SERVER } from "@thoth/app-ui/workspace/starter.ts";
import { NO_SYSTEM_NOTIFIER } from "@thoth/app-ui/notifications/core.ts";
import { VaultHost } from "./VaultHost.tsx";
import type { AppOptions } from "./context.ts";
import { MAIN_WINDOW, type Launch } from "./windows.ts";
import "./app.css";

export const DEFAULT_OPTIONS: AppOptions = {
  autosaveMs: 1000,
  reconcileDebounceMs: 300,
  openImportSource,
  now: () => new Date(),
  pollMs: 5000,
  starterServer: STARTER_SERVER,
  notifier: NO_SYSTEM_NOTIFIER,
  messageMs: 6000,
  // The update notice (ADR-0022): right after the app opens (2 s, once the window has settled), then every 24 h while
  // it stays open.
  updateDelayMs: 2_000,
  updateIntervalMs: 24 * 60 * 60 * 1000,
};

interface Host {
  connection: VaultConnection;
  vault: Vault;
  /** True when the vault had no pages when it was opened: offer onboarding's import step. */
  empty: boolean;
}

async function closeHost(host: Host): Promise<void> {
  await host.vault.close().catch(() => undefined);
  await host.connection.close().catch(() => undefined);
}

/** The UI language: the system's unless one was chosen in Settings, for both the shared and the desktop text. */
function LanguageRoot({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LangPreference>(langPreference);
  const lang = resolveLang(preference, systemLanguages());
  const setPreference = useCallback((next: LangPreference) => {
    setLangPreference(next);
    setPreferenceState(next);
  }, []);
  const choice = useMemo(() => ({ preference, setPreference }), [preference, setPreference]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return (
    <LangPreferenceContext.Provider value={choice}>
      <StringsContext.Provider value={STRINGS[lang]}>
        <DesktopStringsContext.Provider value={DESKTOP_STRINGS[lang]}>{children}</DesktopStringsContext.Provider>
      </StringsContext.Provider>
    </LangPreferenceContext.Provider>
  );
}

const MAIN_LAUNCH: Launch = { id: MAIN_WINDOW, root: null, tabs: null };

/** `launch`: which window this is and what it opens at once (ADR-0019); the main window by default. */
export function App({ platform, options, launch = MAIN_LAUNCH }: { platform: Platform; options?: Partial<AppOptions>; launch?: Launch }) {
  return (
    <LanguageRoot>
      <AppBody platform={platform} options={options} launch={launch} />
    </LanguageRoot>
  );
}

function AppBody({ platform, options, launch }: { platform: Platform; options?: Partial<AppOptions> | undefined; launch: Launch }) {
  const [host, setHost] = useState<Host | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The Private Space this window just left (ADR-0029, amendment of 2026-10-28): the picker lists it first. */
  const [left, setLeft] = useState<string | null>(null);
  const hostRef = useRef<Host | null>(null);
  const merged: AppOptions = { ...DEFAULT_OPTIONS, ...options };

  const openRoot = useCallback(
    async (root: string) => {
      setBusy(true);
      setError(null);
      let connection: VaultConnection | undefined;
      try {
        connection = await platform.openVault(root);
        // Another window has this folder open (ADR-0019): it ran recovery, and what is in `.thoth/tmp` is its work in flight.
        const { vault } = await Vault.open({ fs: connection.fs, sql: connection.sql, recover: connection.shared !== true });
        const empty = (await vault.listPages()).length === 0;
        const next = { connection, vault, empty };
        hostRef.current = next;
        setHost(next);
      } catch (e) {
        await connection?.close().catch(() => undefined);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [platform],
  );

  // A window the app opened on a Private Space shows it at once, with the tabs it was given (only the first time).
  const [launchTabs, setLaunchTabs] = useState(launch.tabs);
  const launched = useRef(false);
  useEffect(() => {
    if (launched.current || launch.root === null) return;
    launched.current = true;
    void openRoot(launch.root);
  }, [launch.root, openRoot]);

  // After "Restart now" into an update (ADR-0034), the main window opens again the Private Space that was open.
  const reopened = useRef(false);
  useEffect(() => {
    if (reopened.current || launch.id !== MAIN_WINDOW || launch.root !== null || !platform.updates) return;
    reopened.current = true;
    void platform.updates
      .takeReopen()
      .then((root) => (root ? openRoot(root) : undefined))
      .catch(() => undefined);
  }, [launch, platform, openRoot]);

  // The window's close button, or Quit (ADR-0019): write the open page's edits, then close, even the last window. The
  // shell closes a window that does not answer within a few seconds.
  const flushOnClose = useRef<() => Promise<boolean>>(async () => true);
  const windows = platform.windows;
  useEffect(() => {
    if (!windows) return;
    let live = true;
    let stop: (() => void) | undefined;
    void windows
      .onCloseRequested(() => {
        void flushOnClose
          .current()
          .catch(() => false)
          .then(() => windows.closeThis({ evenIfLast: true }))
          .catch(() => undefined);
      })
      .then((remove) => {
        if (live) stop = remove;
        else remove();
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stop?.();
    };
  }, [windows]);

  const switchVault = useCallback(() => {
    const current = hostRef.current;
    hostRef.current = null;
    setHost(null);
    if (current) {
      setLeft(current.connection.root);
      void closeHost(current);
    }
  }, []);

  useEffect(
    () => () => {
      const current = hostRef.current;
      hostRef.current = null;
      if (current) void closeHost(current);
    },
    [],
  );

  if (!host) return <Onboarding platform={platform} busy={busy} error={error} left={left} onOpen={openRoot} />;
  return (
    <VaultHost
      key={host.connection.root}
      platform={platform}
      connection={host.connection}
      vault={host.vault}
      options={merged}
      intro={host.empty && launch.root === null}
      switchVault={switchVault}
      windowId={launch.id}
      startTabs={host.connection.root === launch.root ? launchTabs : null}
      onStarted={() => setLaunchTabs(null)}
      flushOnClose={flushOnClose}
    />
  );
}
