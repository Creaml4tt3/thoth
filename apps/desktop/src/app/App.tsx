import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Vault } from "@thoth/local-store";
import type { Platform, VaultConnection } from "@thoth/platform";
import { STRINGS, StringsContext } from "@thoth/app-ui/strings/index.ts";
import { DESKTOP_STRINGS, DesktopStringsContext, LangPreferenceContext, langPreference, resolveLang, setLangPreference, systemLanguages, type LangPreference } from "../strings/index.ts";
import { Onboarding } from "../features/onboarding/Onboarding.tsx";
import { openImportSource } from "../features/import/open-source.ts";
import { STARTER_SERVER } from "@thoth/app-ui/workspace/starter.ts";
import { VaultHost } from "./VaultHost.tsx";
import type { AppOptions } from "./context.ts";
import "./app.css";

export const DEFAULT_OPTIONS: AppOptions = {
  autosaveMs: 1000,
  reconcileDebounceMs: 300,
  openImportSource,
  now: () => new Date(),
  pollMs: 5000,
  starterServer: STARTER_SERVER,
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

export function App({ platform, options }: { platform: Platform; options?: Partial<AppOptions> }) {
  return (
    <LanguageRoot>
      <AppBody platform={platform} options={options} />
    </LanguageRoot>
  );
}

function AppBody({ platform, options }: { platform: Platform; options?: Partial<AppOptions> | undefined }) {
  const [host, setHost] = useState<Host | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<Host | null>(null);
  const merged: AppOptions = { ...DEFAULT_OPTIONS, ...options };

  const openRoot = useCallback(
    async (root: string) => {
      setBusy(true);
      setError(null);
      let connection: VaultConnection | undefined;
      try {
        connection = await platform.openVault(root);
        const { vault } = await Vault.open({ fs: connection.fs, sql: connection.sql });
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

  const switchVault = useCallback(() => {
    const current = hostRef.current;
    hostRef.current = null;
    setHost(null);
    if (current) void closeHost(current);
  }, []);

  useEffect(
    () => () => {
      const current = hostRef.current;
      hostRef.current = null;
      if (current) void closeHost(current);
    },
    [],
  );

  if (!host) return <Onboarding platform={platform} busy={busy} error={error} onOpen={openRoot} />;
  return <VaultHost key={host.connection.root} platform={platform} connection={host.connection} vault={host.vault} options={merged} intro={host.empty} switchVault={switchVault} />;
}
