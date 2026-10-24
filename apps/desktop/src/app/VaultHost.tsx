import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Vault } from "@thoth/local-store";
import type { Platform, VaultConnection } from "@thoth/platform";
import { Intro } from "../features/onboarding/Intro.tsx";
import { createImportService } from "../features/import/service.ts";
import { createTransferService } from "../features/transfer/service.ts";
import { Shell } from "../features/shell/Shell.tsx";
import { SessionContext, type AppOptions, type Session } from "./context.ts";
import { createReconciler } from "./reconciler.ts";
import { ServerDirectory } from "@thoth/app-ui/workspace/directory.ts";
import { PageHostContext, type PageHost } from "@thoth/app-ui/editor/host.ts";
import { useTabs } from "@thoth/app-ui/tabs/useTabs.ts";
import { loadTabs, saveTabs } from "./tabs-store.ts";

interface Props {
  platform: Platform;
  connection: VaultConnection;
  vault: Vault;
  options: AppOptions;
  intro: boolean;
  switchVault(): void;
}

/** Owns the live Session of one open Private Space: revision counter, watcher, import service. */
export function VaultHost({ platform, connection, vault, options, intro, switchVault }: Props) {
  const [revision, setRevision] = useState(0);
  const [reveal, setReveal] = useState<Session["reveal"]>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [showIntro, setShowIntro] = useState(intro);

  const flushers = useRef(new Set<() => Promise<boolean>>());
  const registerFlush = useCallback((flush: () => Promise<boolean>) => {
    flushers.current.add(flush);
    return () => void flushers.current.delete(flush);
  }, []);
  /** A failed flush (for example the vault closed underneath it) counts as "not saved": stay where you are. */
  const flushAll = useCallback(async () => (await Promise.all([...flushers.current].map((f) => f().catch(() => false)))).every(Boolean), []);

  const bump = useCallback(() => setRevision((r) => r + 1), []);

  // Tabs: restored per Private Space, saved on every change. Leaving the page on screen writes its edits first.
  const tabs = useTabs({ initial: () => loadTabs(connection.root), flush: flushAll, save: (state) => saveTabs(connection.root, state) });

  useEffect(() => {
    let cancelled = false;
    let stop: (() => Promise<void>) | undefined;
    const reconciler = createReconciler(vault, {
      debounceMs: options.reconcileDebounceMs,
      onReconciled: bump,
      onError: (error) => setWatchError(error instanceof Error ? error.message : String(error)),
    });
    connection
      .watch((event) => reconciler.trigger({ rescan: event.rescan }))
      .then((stopper) => {
        if (cancelled) void stopper().catch(() => undefined);
        else stop = stopper;
      })
      .catch((error: unknown) => setWatchError(error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
      reconciler.dispose();
      if (stop) void stop().catch(() => undefined);
    };
  }, [connection, vault, options.reconcileDebounceMs, bump]);

  // Workspace servers: one directory per open window, polling only expanded workspaces.
  const servers = useMemo(() => new ServerDirectory(platform.servers, { pollMs: options.pollMs }), [platform, options.pollMs]);
  const pageHost = useMemo<PageHost>(() => ({ autosaveMs: options.autosaveMs, now: options.now, registerFlush }), [options.autosaveMs, options.now, registerFlush]);
  // Transfers: recovery of operations a crash interrupted runs once the server list is known (ADR-0006 §7).
  const transfers = useMemo(() => createTransferService(vault, servers, { now: options.now, onChanged: bump }), [vault, servers, options.now, bump]);
  useEffect(() => {
    let live = true;
    void servers.start().then(() => {
      if (live) void transfers.recover();
    });
    return () => {
      live = false;
      servers.dispose();
    };
  }, [servers, transfers]);

  const importService = useMemo(
    () => createImportService(vault, (kind, location) => options.openImportSource(platform, kind, location)),
    [vault, platform, options],
  );

  const session = useMemo<Session>(
    () => ({
      platform,
      connection,
      vault,
      options,
      importService,
      revision,
      refresh: async () => {
        await vault.reconcile();
        bump();
      },
      openPage: (path, options) => tabs.open({ kind: "page", path }, options),
      openSettings: (section) => tabs.open(section ? { kind: "settings", section } : { kind: "settings" }),
      tabs,
      servers,
      transfers,
      openWorkspacePage: (ref, options) => tabs.open({ kind: "workspace", ...ref }, options),
      openFolder: (folder) =>
        void flushAll().then(async (ok) => {
          if (!ok) return;
          setReveal((r) => ({ path: folder, nonce: (r?.nonce ?? 0) + 1 }));
          const prefix = folder === "" ? "" : `${folder}/`;
          const first = (await vault.listPages()).find((p) => p.path.startsWith(prefix));
          if (first) tabs.open({ kind: "page", path: first.path });
        }),
      reveal,
      registerFlush,
      flushAll,
      switchVault: () => void flushAll().then((ok) => ok && switchVault()),
      watchError,
    }),
    [platform, connection, vault, options, importService, revision, reveal, registerFlush, flushAll, switchVault, watchError, bump, servers, transfers, tabs],
  );

  return (
    <SessionContext.Provider value={session}>
      <PageHostContext.Provider value={pageHost}>
        {showIntro ? <Intro onContinue={() => setShowIntro(false)} /> : <Shell />}
      </PageHostContext.Provider>
    </SessionContext.Provider>
  );
}
