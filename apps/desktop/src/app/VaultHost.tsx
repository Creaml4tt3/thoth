import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Vault } from "@thoth/local-store";
import type { Platform, VaultConnection } from "@thoth/platform";
import { Intro } from "../features/onboarding/Intro.tsx";
import { createImportService } from "../features/import/service.ts";
import { createTransferService } from "../features/transfer/service.ts";
import { createAgentsService } from "../features/agents/service.ts";
import { createAssistantController } from "../features/mascot/controller.ts";
import { Shell } from "../features/shell/Shell.tsx";
import { requestFirstRunTour } from "../features/tour/store.ts";
import { SessionContext, type AppOptions, type Session } from "./context.ts";
import { createReconciler } from "./reconciler.ts";
import { ServerDirectory } from "@thoth/app-ui/workspace/directory.ts";
import { PageHostContext, type PageHost } from "@thoth/app-ui/editor/host.ts";
import { createLinkPreviewService } from "@thoth/app-ui/editor/link-previews.ts";
import { useTabs } from "@thoth/app-ui/tabs/useTabs.ts";
import { serializeLayout } from "@thoth/app-ui/tabs/layout.ts";
import { loadTabs, parseDesktopLayout, saveTabs } from "./tabs-store.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { createNotificationCenter, type NotificationTarget } from "@thoth/app-ui/notifications/core.ts";
import { createNotificationPrefsStore } from "../features/notifications/prefs.ts";
import { importEvent, transferEvent, watchAgentRuns } from "../features/notifications/sources.ts";
import { createUpdateService } from "../features/updates/service.ts";
import { waitingReviews } from "../features/mascot/hooks.ts";
import { createWindowPresence } from "../platform/notifier.ts";
import { MAIN_WINDOW } from "./windows.ts";
import { ConnectedAppsHost } from "../features/connected-apps/ConnectedAppsHost.tsx";
import { forgetWindow, rememberWindow, windowsOn } from "./windows-store.ts";
import { requestShowSidebar } from "@thoth/app-ui/ui/sidebar-hidden.ts";

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
    initial: () => (startTabs !== null ? parseDesktopLayout(startTabs) : null) ?? loadTabs(connection.root, windowId),
    flush: flushAll,
    save: (layout) => saveTabs(connection.root, layout, windowId),
  });
  const started = useRef(onStarted);
  useEffect(() => started.current?.(), []);

  // Windows (ADR-0019). A window the app opened is remembered on this Private Space until it is closed; one closed
  // elsewhere is forgotten here. The main window, alone on the Private Space, brings back the windows that were open.
  // Recovery is for what a crash left: with another window on this folder, its operations are in flight, not left
  // (ADR-0019). Once the other windows have closed, this one is alone and runs what it skipped, for what they left.
  const [alone, setAlone] = useState(connection.shared !== true);
  const aloneRef = useRef(alone);
  const windows = platform.windows;
  useEffect(() => {
    if (!windows) return;
    if (windowId !== MAIN_WINDOW) rememberWindow(windowId, connection.root);
    let live = true;
    let stop: (() => void) | undefined;
    // One check at a time, each after the one before: two windows closing together are both seen.
    let checks = Promise.resolve();
    const checkAlone = async () => {
      if (aloneRef.current || !live || !connection.isShared || (await connection.isShared())) return;
      // The journal first (an interrupted delete puts its page back), then agent runs and transfers (effects below).
      await vault.recover().catch(() => undefined);
      if (!live) return;
      bump();
      aloneRef.current = true;
      setAlone(true);
    };
    void windows
      .onClosed((id) => {
        forgetWindow(id);
        checks = checks.then(checkAlone).catch(() => undefined);
      })
      .then((remove) => {
        if (live) stop = remove;
        else remove();
      })
      .catch(() => undefined);
    if (windowId === MAIN_WINDOW && connection.shared !== true) {
      for (const id of windowsOn(connection.root)) {
        // An id already open (the main window came back to this Private Space) is refused by the shell: nothing to do.
        void windows.open({ id, root: connection.root, tabs: serializeLayout(loadTabs(connection.root, id)) }).catch(() => undefined);
      }
    }
    return () => {
      live = false;
      stop?.();
    };
  }, [windows, windowId, connection, vault, bump]);

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

  // The update notice (ADR-0022): the host asks; the popup is this window's, and the list under the bell gets an entry
  // for a version it has not told of (when the person has that on).
  const updates = useMemo(
    () =>
      platform.updates
        ? createUpdateService(platform.updates, platform.links, {
            delayMs: options.updateDelayMs,
            intervalMs: options.updateIntervalMs,
            onOffer: (offer) => {
              if (notificationPrefs.get().kinds.update) notifications.push({ kind: "update", version: offer.version });
            },
          })
        : null,
    [platform, options.updateDelayMs, options.updateIntervalMs, notificationPrefs, notifications],
  );
  useEffect(() => updates?.start(), [updates]);

  // Workspace servers: one directory per open window, polling only expanded workspaces.
  const servers = useMemo(() => new ServerDirectory(platform.servers, { pollMs: options.pollMs }), [platform, options.pollMs]);
  // Link previews (ADR-0020): the host fetches them; a platform without `links` shows plain links.
  const linkPreviews = useMemo(() => (platform.links ? createLinkPreviewService(platform.links) : undefined), [platform]);
  const pageHost = useMemo<PageHost>(
    () => ({
      client: "desktop",
      autosaveMs: options.autosaveMs,
      now: options.now,
      registerFlush,
      ...(linkPreviews ? { links: linkPreviews } : {}),
      // Images (ADR-0028): the host's picker; the page gets the name and the bytes, never the path.
      ...(platform.pickImage ? { pickImage: () => platform.pickImage!() } : {}),
    }),
    [options.autosaveMs, options.now, registerFlush, linkPreviews, platform],
  );
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
  const [serversReady, setServersReady] = useState(false);
  useEffect(() => {
    let live = true;
    void servers.start().then(() => {
      if (live) setServersReady(true);
    });
    return () => {
      live = false;
      setServersReady(false);
      servers.dispose();
    };
  }, [servers]);
  useEffect(() => {
    if (alone && serversReady) void transfers.recover();
  }, [transfers, alone, serversReady]);

  // Agent runs: only where the host can run CLIs. Working directories an earlier session left are deleted and its
  // unfinished runs marked interrupted (ADR-0007, cleanup on next start).
  const agents = useMemo(() => (platform.agents ? createAgentsService(vault, platform.agents, { onApplied: bump, servers, alone: () => aloneRef.current }) : null), [platform, vault, bump, servers]);
  useEffect(() => () => void agents?.dispose(), [agents]);
  // A window that is not alone does not recover (the runs may be another window's) but still lists them.
  useEffect(() => {
    if (alone) void agents?.recover();
    else void agents?.refresh();
  }, [agents, alone]);
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
    (folder: string, { openFirstPage = true, keepCurrent = false }: { openFirstPage?: boolean; keepCurrent?: boolean } = {}) => {
      // The folder is shown in the sidebar, so a hidden sidebar comes back first.
      requestShowSidebar();
      if (!openFirstPage) return setReveal((r) => ({ path: folder, nonce: (r?.nonce ?? 0) + 1 }));
      void flushAll().then(async (ok) => {
        if (!ok) return;
        setReveal((r) => ({ path: folder, nonce: (r?.nonce ?? 0) + 1 }));
        const prefix = folder === "" ? "" : `${folder}/`;
        const first = (await vault.listPages()).find((p) => p.path.startsWith(prefix));
        if (!first) return;
        const target = { kind: "page" as const, path: first.path };
        if (keepCurrent) tabs.openOrFocus(target);
        else tabs.open(target);
      });
    },
    [flushAll, vault, tabs],
  );

  /** A run from a notification: its session tab (review, result or answer), or its outcome in the bubble. */
  const openRun = useCallback(
    (runId: string) => {
      if (!agents || !assistant) return;
      const s = agents.getState();
      // One tab per conversation (ADR-0007, "Conversations"): a turn opens its conversation's tab.
      const session = { kind: "agent-run" as const, run: agents.conversationOf(runId) };
      if (s.record?.id === runId) {
        if (s.phase === "review" || s.phase === "applying" || (s.phase === "finished" && s.results !== null)) return tabs.open(session);
        if (s.phase !== "idle") return assistant.openBubble();
      }
      if ((s.phase === "idle" || s.phase === "finished") && waitingReviews(s).includes(runId)) {
        void agents.reopenReview(runId).then(() => (agents.getState().phase === "review" ? tabs.open(session) : assistant.openBubble()));
        return;
      }
      tabs.open(session);
    },
    [agents, assistant, tabs],
  );
  const openNotification = useCallback(
    (target: NotificationTarget) => {
      switch (target.kind) {
        // A page goes to its tab, or opens in a new one: the page on screen stays where it is.
        case "page":
          return tabs.openOrFocus({ kind: "page", path: target.path });
        case "workspacePage":
          return tabs.openOrFocus({ kind: "workspace", server: target.server, workspace: target.workspace, page: target.page });
        case "folder":
          return openFolder(target.path, { keepCurrent: true });
        case "agentRun":
          return openRun(target.runId);
        case "update":
          return updates?.show();
      }
    },
    [tabs, openFolder, openRun, updates],
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
      openAgentReview: () => {
        const run = agents?.getState().record?.id;
        if (run) tabs.open({ kind: "agent-run", run: agents!.conversationOf(run) });
      },
      openAgentRun: (run) => tabs.open({ kind: "agent-run", run: agents?.conversationOf(run) ?? run }),
      alone,
      openWorkspacePage: (ref, options) => tabs.open({ kind: "workspace", ...ref }, options),
      openFolder,
      notifications,
      notificationPrefs,
      openNotification,
      updates,
      reveal,
      registerFlush,
      flushAll,
      switchVault: () =>
        flushAll().then((ok) => {
          if (!ok) return false;
          // A window the app opened leaves this Private Space: it is not brought back on it.
          if (windowId !== MAIN_WINDOW) forgetWindow(windowId);
          switchVault();
          return true;
        }),
      watchError,
      windowId,
    }),
    [platform, connection, vault, options, importService, revision, reveal, registerFlush, flushAll, switchVault, watchError, bump, servers, transfers, agents, assistant, tabs, openFolder, notifications, notificationPrefs, openNotification, updates, windowId, alone],
  );

  return (
    <SessionContext.Provider value={session}>
      <PageHostContext.Provider value={pageHost}>
        {showIntro ? (
          <Intro
            onContinue={(welcome) => {
              if (welcome) {
                // The Welcome pages were just written (ADR-0032): open the first, then the tour, unless it was seen.
                bump();
                tabs.open({ kind: "page", path: welcome });
                requestFirstRunTour();
              }
              setShowIntro(false);
            }}
          />
        ) : (
          <Shell />
        )}
        {/* Connected apps (ADR-0021): this window answers apps' requests for its Private Space, and asks Allow or Deny. */}
        {platform.connectedApps && <ConnectedAppsHost connectedApps={platform.connectedApps} />}
      </PageHostContext.Provider>
    </SessionContext.Provider>
  );
}
