import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Vault } from "@thoth/local-store";
import type { Platform, VaultConnection } from "@thoth/platform";
import { Intro } from "../features/onboarding/Intro.tsx";
import { createImportService } from "../features/import/service.ts";
import { createTransferService } from "../features/transfer/service.ts";
import { createAgentsService } from "../features/agents/service.ts";
import { createAssistantController } from "../features/mascot/controller.ts";
import { Shell } from "../features/shell/Shell.tsx";
import { SessionContext, type AppOptions, type Session } from "./context.ts";
import { createReconciler } from "./reconciler.ts";
import { ServerDirectory } from "@thoth/app-ui/workspace/directory.ts";
import { PageHostContext, type PageHost } from "@thoth/app-ui/editor/host.ts";
import { useTabs } from "@thoth/app-ui/tabs/useTabs.ts";
import { parseTabs, serializeTabs } from "@thoth/app-ui/tabs/model.ts";
import { loadTabs, saveTabs } from "./tabs-store.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { createNotificationCenter, type NotificationTarget } from "@thoth/app-ui/notifications/core.ts";
import { createNotificationPrefsStore } from "../features/notifications/prefs.ts";
import { importEvent, transferEvent, watchAgentRuns } from "../features/notifications/sources.ts";
import { waitingReviews } from "../features/mascot/hooks.ts";
import { createWindowPresence } from "../platform/notifier.ts";
import { MAIN_WINDOW } from "./windows.ts";
import { forgetWindow, rememberWindow, windowsOn } from "./windows-store.ts";

interface Props {
  platform: Platform;
  connection: VaultConnection;
  vault: Vault;
  options: AppOptions;
  intro: boolean;
  switchVault(): void;
  /** Which window this is (ADR-0019): "main", or the id of a window the app opened. */
  windowId?: string;
  /** The tabs this window was opened with (stored form), instead of its saved ones; once. */
  startTabs?: string | null;
  onStarted?(): void;
  /** Set to this window's `flushAll` while it is shown: the app calls it before the window closes (its close button). */
  flushOnClose?: { current: () => Promise<boolean> };
}

/** Owns the live Session of one open Private Space: revision counter, watcher, import service. */
export function VaultHost({ platform, connection, vault, options, intro, switchVault, windowId = MAIN_WINDOW, startTabs = null, onStarted, flushOnClose }: Props) {
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
  useEffect(() => {
    if (!flushOnClose) return;
    flushOnClose.current = flushAll;
    return () => {
      if (flushOnClose.current === flushAll) flushOnClose.current = async () => true;
    };
  }, [flushOnClose, flushAll]);

  // Tabs: restored per Private Space and window, saved on every change. Leaving the page on screen writes its edits first.
  const tabs = useTabs({
    initial: () => (startTabs !== null ? parseTabs(startTabs) : null) ?? loadTabs(connection.root, windowId),
    flush: flushAll,
    save: (state) => saveTabs(connection.root, state, windowId),
  });
  const started = useRef(onStarted);
  useEffect(() => started.current?.(), []);

  // Windows (ADR-0019). A window the app opened is remembered on this Private Space until it is closed; one closed
  // elsewhere is forgotten here. The main window, alone on the Private Space, brings back the windows that were open.
  const windows = platform.windows;
  useEffect(() => {
    if (!windows) return;
    if (windowId !== MAIN_WINDOW) rememberWindow(windowId, connection.root);
    let live = true;
    let stop: (() => void) | undefined;
    void windows
      .onClosed((id) => forgetWindow(id))
      .then((remove) => {
        if (live) stop = remove;
        else remove();
      })
      .catch(() => undefined);
    if (windowId === MAIN_WINDOW && connection.shared !== true) {
      for (const id of windowsOn(connection.root)) {
        // An id already open (the main window came back to this Private Space) is refused by the shell: nothing to do.
        void windows.open({ id, root: connection.root, tabs: serializeTabs(loadTabs(connection.root, id)) }).catch(() => undefined);
      }
    }
    return () => {
      live = false;
      stop?.();
    };
  }, [windows, windowId, connection]);

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

  // Notifications (ADR-0018): one list per window, in memory; system notifications only in the background, as the
  // user's settings allow. Agent runs are said aloud by the mascot when it is shown, so the list does not repeat them.
  const strings = useStrings();
  const stringsRef = useRef(strings);
  stringsRef.current = strings;
  const notificationPrefs = useMemo(() => createNotificationPrefsStore(), []);
  const presence = useMemo(() => createWindowPresence(), []);
  useEffect(() => () => presence.dispose(), [presence]);
  const mascotShown = useRef<() => boolean>(() => false);
  const notifications = useMemo(
    () =>
      createNotificationCenter({
        strings: () => stringsRef.current.notifications,
        notifier: options.notifier,
        settings: notificationPrefs.get,
        background: presence.background,
        announcedElsewhere: (event) => event.kind.startsWith("agent") && mascotShown.current(),
        now: () => options.now().getTime(),
      }),
    [options.notifier, options.now, notificationPrefs, presence],
  );

  // Workspace servers: one directory per open window, polling only expanded workspaces.
  const servers = useMemo(() => new ServerDirectory(platform.servers, { pollMs: options.pollMs }), [platform, options.pollMs]);
  const pageHost = useMemo<PageHost>(() => ({ client: "desktop", autosaveMs: options.autosaveMs, now: options.now, registerFlush }), [options.autosaveMs, options.now, registerFlush]);
  // Transfers: recovery of operations a crash interrupted runs once the server list is known (ADR-0006 §7).
  const transfers = useMemo(
    () =>
      createTransferService(vault, servers, {
        now: options.now,
        onChanged: bump,
        onSettled: (record, interrupted) => {
          const event = transferEvent(record, interrupted);
          if (event) notifications.push(event);
        },
      }),
    [vault, servers, options.now, bump, notifications],
  );
  // Recovery is for what a crash left: with another window on this folder, its operations are in flight, not left (ADR-0019).
  const recovers = connection.shared !== true;
  useEffect(() => {
    let live = true;
    void servers.start().then(() => {
      if (live && recovers) void transfers.recover();
    });
    return () => {
      live = false;
      servers.dispose();
    };
  }, [servers, transfers, recovers]);

  // Agent runs: only where the host can run CLIs. Working directories an earlier session left are deleted and its
  // unfinished runs marked interrupted (ADR-0007, cleanup on next start).
  const agents = useMemo(() => (platform.agents ? createAgentsService(vault, platform.agents, { onApplied: bump, servers }) : null), [platform, vault, bump, servers]);
  useEffect(() => {
    if (recovers) void agents?.recover();
    return () => void agents?.dispose();
  }, [agents, recovers]);
  // The mascot: its preferences are the user's (not this Private Space's), read once per window.
  const assistant = useMemo(() => (agents ? createAssistantController() : null), [agents]);
  mascotShown.current = () => assistant?.prefs.get().show ?? false;
  useEffect(() => (agents ? watchAgentRuns(agents, notifications) : undefined), [agents, notifications]);

  const importService = useMemo(
    () =>
      createImportService(
        vault,
        (kind, location) => options.openImportSource(platform, kind, location),
        {
          shared: () => connection.isShared?.() ?? Promise.resolve(false),
          onFinished: ({ jobId, destinationRoot, report }) => {
            const event = importEvent(jobId, destinationRoot, report);
            if (event) notifications.push(event);
          },
        },
      ),
    [vault, platform, options, notifications, connection],
  );

  const openFolder = useCallback(
    (folder: string) =>
      void flushAll().then(async (ok) => {
        if (!ok) return;
        setReveal((r) => ({ path: folder, nonce: (r?.nonce ?? 0) + 1 }));
        const prefix = folder === "" ? "" : `${folder}/`;
        const first = (await vault.listPages()).find((p) => p.path.startsWith(prefix));
        if (first) tabs.open({ kind: "page", path: first.path });
      }),
    [flushAll, vault, tabs],
  );

  /** A run from a notification: its review or result tab, its outcome in the bubble, or the history. */
  const openRun = useCallback(
    (runId: string) => {
      if (!agents || !assistant) return;
      const s = agents.getState();
      if (s.record?.id === runId) {
        if (s.phase === "review" || s.phase === "applying" || (s.phase === "finished" && s.results !== null)) return tabs.open({ kind: "agents" });
        if (s.phase !== "idle") return assistant.openBubble();
      }
      if ((s.phase === "idle" || s.phase === "finished") && waitingReviews(s).includes(runId)) {
        void agents.reopenReview(runId).then(() => (agents.getState().phase === "review" ? tabs.open({ kind: "agents" }) : assistant.openBubble()));
        return;
      }
      tabs.open({ kind: "settings", section: "agents" });
    },
    [agents, assistant, tabs],
  );
  const openNotification = useCallback(
    (target: NotificationTarget) => {
      switch (target.kind) {
        case "page":
          return tabs.open({ kind: "page", path: target.path });
        case "workspacePage":
          return tabs.open({ kind: "workspace", server: target.server, workspace: target.workspace, page: target.page });
        case "folder":
          return openFolder(target.path);
        case "agentRun":
          return openRun(target.runId);
      }
    },
    [tabs, openFolder, openRun],
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
      agents,
      assistant,
      askAssistant: (selection) => {
        if (!agents || !assistant) return;
        const phase = agents.getState().phase;
        if (selection && selection.length > 0 && (phase === "idle" || phase === "finished")) agents.setDraft({ selection: [...selection].sort(), wholeSpace: false });
        assistant.openBubble();
      },
      openAgentReview: () => tabs.open({ kind: "agents" }),
      openWorkspacePage: (ref, options) => tabs.open({ kind: "workspace", ...ref }, options),
      openFolder,
      notifications,
      notificationPrefs,
      openNotification,
      reveal,
      registerFlush,
      flushAll,
      switchVault: () =>
        void flushAll().then((ok) => {
          if (!ok) return;
          // A window the app opened leaves this Private Space: it is not brought back on it.
          if (windowId !== MAIN_WINDOW) forgetWindow(windowId);
          switchVault();
        }),
      watchError,
      windowId,
    }),
    [platform, connection, vault, options, importService, revision, reveal, registerFlush, flushAll, switchVault, watchError, bump, servers, transfers, agents, assistant, tabs, openFolder, notifications, notificationPrefs, openNotification, windowId],
  );

  return (
    <SessionContext.Provider value={session}>
      <PageHostContext.Provider value={pageHost}>
        {showIntro ? <Intro onContinue={() => setShowIntro(false)} /> : <Shell />}
      </PageHostContext.Provider>
    </SessionContext.Provider>
  );
}
