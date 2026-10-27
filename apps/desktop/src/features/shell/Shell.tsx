import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { basename, stripExtension, type PageSummary } from "@thoth/domain";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { PageView } from "../editor/PageView.tsx";
import { SettingsView } from "../settings/SettingsView.tsx";
import { NewPageDialog } from "./NewPageDialog.tsx";
import { SearchPalette } from "./SearchPalette.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { SidebarResizer, useSidebarWidth } from "@thoth/app-ui/ui/SidebarResizer.tsx";
import { TooltipLayer } from "@thoth/app-ui/ui/Tooltip.tsx";
import { SpaceDragBadge } from "@thoth/app-ui/order/SpaceDragBadge.tsx";
import { onSpaceDrop } from "@thoth/app-ui/order/space-drag.ts";
import { transferTargetFor } from "./space-drop.ts";
import { HintContext } from "@thoth/app-ui/keyboard/hints.ts";
import { WorkspacePageView } from "../servers/WorkspacePageView.tsx";
import { TransferDialog, type TransferTarget } from "../transfer/TransferDialog.tsx";
import { AgentSessionView } from "../agents/AgentSessionView.tsx";
import { taskTitle } from "../agents/parts.tsx";
import { MascotLayer } from "../mascot/Mascot.tsx";
import { UpdateNotice } from "../updates/UpdateNotice.tsx";
import type { Tab, TabTarget, TabsState } from "@thoth/app-ui/tabs/model.ts";
import { TabBar, type TabItem } from "@thoth/app-ui/tabs/TabBar.tsx";
import { tabMoves } from "@thoth/app-ui/tabs/useTabs.ts";
import { serializeTabs } from "@thoth/app-ui/tabs/model.ts";
import { allTabs, emptyLayout } from "@thoth/app-ui/tabs/layout.ts";
import { Panes, focusPaneTab } from "@thoth/app-ui/tabs/Panes.tsx";
import { MAIN_WINDOW, newWindowId } from "../../app/windows.ts";
import { rememberWindow } from "../../app/windows-store.ts";
import { saveTabs } from "../../app/tabs-store.ts";
import { remoteGone, remoteTitle } from "@thoth/app-ui/tabs/remote.ts";
import { useShortcuts } from "@thoth/app-ui/keyboard/useShortcuts.ts";
import { currentPlatform } from "@thoth/app-ui/keyboard/shortcuts.ts";
import { buildCommands, type Command, type CommandActions } from "@thoth/app-ui/keyboard/commands.ts";
import { hasOtherWritableWorkspace } from "@thoth/app-ui/transfer/targets.ts";
import { useEditorActions } from "@thoth/app-ui/keyboard/editor-actions.ts";
import { ShortcutsDialog } from "@thoth/app-ui/keyboard/ShortcutsDialog.tsx";
import { requestMoveTo } from "@thoth/app-ui/order/move-to.ts";
import { requestShare } from "@thoth/app-ui/workspace/share-request.ts";
import { requestMembers } from "@thoth/app-ui/workspace/members-request.ts";
import { requestWorkspaceAdmin } from "@thoth/app-ui/workspace/workspace-admin-request.ts";
import { requestNewFolder } from "@thoth/app-ui/order/new-folder-request.ts";
import { requestReorder } from "@thoth/app-ui/order/reorder-request.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { useTheme } from "@thoth/app-ui/ui/theme.ts";
import { roleCan } from "@thoth/workspace-protocol";
import { desktopTheme } from "../settings/theme.ts";
import { loadSidebarLayout, loadSidebarWidth, saveSidebarHidden, saveSidebarWidth } from "../../app/sidebar-store.ts";
import { useSidebarHidden } from "@thoth/app-ui/ui/sidebar-hidden.ts";
import { RenamePage, type RenameTarget } from "./RenamePage.tsx";
import { FavoritesContext, type FavoriteRef } from "@thoth/app-ui/favorites/context.ts";
import { isPinned } from "@thoth/app-ui/tabs/model.ts";
import { workspaceRefOf } from "@thoth/app-ui/favorites/useWorkspaceFavorites.ts";
import type { MenuItem } from "@thoth/app-ui/order/ContextMenu.tsx";
import { useFavoritesController } from "../favorites/useFavoritesController.ts";
import { HOME } from "@thoth/app-ui/tabs/model.ts";
import { HomeView, type HomeRow } from "@thoth/app-ui/home/HomeView.tsx";
import { useRecentPages } from "@thoth/app-ui/home/useRecent.ts";
import { RECENT_SHOWN } from "@thoth/app-ui/home/recent.ts";
import { folderOf, workspaceRow } from "@thoth/app-ui/home/rows.ts";

const noSubscribe = () => () => undefined;

type Dialog = { kind: "search" } | { kind: "new" } | { kind: "shortcuts" } | { kind: "rename"; target: RenameTarget } | { kind: "transfer"; target: TransferTarget } | null;

/** What startup recovery did, said once (ADR-0006 §7: an interrupted transfer is never silent). */
function RecoveryNotice() {
  const { transfers } = useSession();
  const t = useDesktopStrings().transfer;
  const { recovery } = useSyncExternalStore(transfers.subscribe, transfers.getState);
  const [hidden, setHidden] = useState(false);
  if (!recovery || hidden) return null;
  const lines = [
    recovery.completed.length > 0 ? t.recoveredCompleted(recovery.completed.length) : null,
    recovery.rolledBack.length > 0 ? t.recoveredRolledBack(recovery.rolledBack.length) : null,
    recovery.waiting.length > 0 ? t.recoveredWaiting(recovery.waiting.length) : null,
  ].filter((l): l is string => l !== null);
  if (lines.length === 0) return null;
  return (
    <div role="status" className="alert alert-warning banner">
      <b>{t.recoveredTitle}.</b> {lines.join(" ")}{" "}
      <Button variant="quiet" small onClick={() => setHidden(true)}>
        {t.dismiss}
      </Button>
    </div>
  );
}

/** The Paper shell: sidebar on the left; tabs, and the page or settings of the current tab, on the right. */
export function Shell() {
  const { platform: host, vault, connection, revision, watchError, options, openPage, openSettings, openWorkspacePage, flushAll, tabs, servers, assistant, agents, windowId, recent: recentStore } = useSession();
  const t = useDesktopStrings().shell;
  const sessionTitle = useDesktopStrings().agents.session.tab;
  // Session tabs are named by their run's task.
  const runs = useSyncExternalStore(agents?.subscribe ?? noSubscribe, () => agents?.getState() ?? null);
  const strings = useStrings();
  const tt = strings.tabs;
  const [problem, setProblem] = useState<string | null>(null);
  const dismissText = useDesktopStrings().transfer.dismiss;
  const editor = useEditorActions();
  const { theme: themeNow, setTheme, cycle } = useTheme(desktopTheme);
  const [pages, setPages] = useState<PageSummary[] | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const directory = useSyncExternalStore(servers.subscribe, servers.getState);
  const target = tabs.active.target;
  const path = target.kind === "page" ? target.path : null;
  const remote = target.kind === "workspace" ? { server: target.server, workspace: target.workspace, page: target.page } : null;
  /** What a tab shows, as a favorite (ADR-0027): a page of the Private Space or of a workspace; nothing else is starred. */
  const favoriteOf = (tab: TabTarget): FavoriteRef | null =>
    tab.kind === "page" ? { kind: "private", path: tab.path } : tab.kind === "workspace" ? { kind: "workspace", server: tab.server, workspace: tab.workspace, page: tab.page } : null;
  const favoriteHere = favoriteOf(target);

  useEffect(() => {
    let live = true;
    vault
      .listPages()
      .then((list) => live && setPages(list))
      .catch(() => undefined); // the vault may have closed while this was in flight
    return () => {
      live = false;
    };
  }, [vault, revision]);

  const favorites = useFavoritesController({ pages, current: favoriteHere });
  // Home (ADR-0029): one tab; a new tab shows the same view.
  const goHome = () => tabs.open(HOME);
  const recent = useRecentPages(recentStore, tabs.active);
  /** Said in the tab bar (Cmd/Ctrl+W on a pinned tab); a new `seq` says it again. */
  const [tabNotice, setTabNotice] = useState<{ text: string; seq: number } | null>(null);
  const everyTab = allTabs(tabs.layout);
  const togglePin = (id: string = tabs.active.id) => {
    const tab = everyTab.find((x) => x.id === id);
    if (!tab || tab.target.kind === "blank") return;
    tabs.setPinned(!tab.pinned, id);
  };
  const toggleFavorite = () => {
    if (favoriteHere && favorites.api.can(favoriteHere)) favorites.api.toggle(favoriteHere);
  };

  const toggleSearch = () => setDialog((d) => (d?.kind === "search" ? null : { kind: "search" }));
  const toggleShortcuts = () => setDialog((d) => (d?.kind === "shortcuts" ? null : { kind: "shortcuts" }));
  const platform = useMemo(() => currentPlatform(), []);
  const hints = useMemo(() => ({ client: "desktop" as const, platform }), [platform]);
  // The sidebar's width: dragged by its edge, remembered per Private Space.
  const shell = useRef<HTMLDivElement>(null);
  const sidebar = useSidebarWidth({ initial: () => loadSidebarWidth(connection.root), save: (width) => saveSidebarWidth(connection.root, width) });
  // The whole sidebar hidden or shown, remembered per Private Space too.
  const side = useSidebarHidden({ initial: () => loadSidebarLayout(connection.root).hidden, save: (hidden) => saveSidebarHidden(connection.root, hidden) });

  const label = (tab: TabTarget): TabItem["label"] => {
    switch (tab.kind) {
      case "page":
        return pages?.find((p) => p.path === tab.path)?.title ?? stripExtension(basename(tab.path));
      case "workspace":
        return remoteTitle(directory, tab) ?? tt.untitled;
      case "settings":
        return tt.settings;
      case "home":
        return strings.home.title;
      case "agent-run": {
        // A tab is a conversation: named by its first question.
        const record = runs ? agents?.conversation(tab.run)[0] : undefined;
        return record ? taskTitle(record.task.prompt) || sessionTitle : sessionTitle;
      }
      case "blank":
        return tt.blank;
    }
  };
  // The workspace page in the current tab, if any: what the workspace commands act on.
  const here = target.kind === "workspace" ? target : null;
  const hereWorkspace = here ? directory.servers.find((s) => s.info.id === here.server)?.workspaces?.find((w) => w.id === here.workspace) : undefined;
  const canWriteHere = hereWorkspace !== undefined && roleCan(hereWorkspace.role, "write");
  // ADR-0025: New workspace goes to the open page's server, else to the first signed-in server that offers it.
  const workspaceServer = [here?.server, ...directory.servers.map((s) => s.info.id)].find((id) => id !== undefined && servers.canManageWorkspaces(id) && servers.server(id)?.workspaces != null);

  /** A command runs once the palette (or whatever dialog it came from) has closed and given focus back. */
  const afterClose = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (dialog !== null || !afterClose.current) return;
    const run = afterClose.current;
    afterClose.current = null;
    run();
  }, [dialog]);
  const runCommand = (command: Command) => {
    afterClose.current = command.run;
    setDialog(null);
  };

  const attempt = (job: () => Promise<void>) => void job().catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));

  // More windows on this Private Space (ADR-0019, the desktop shell only).
  const windows = host.windows;
  const moveToWindow = (id: string, at: { x: number; y: number } | null) => {
    if (!windows) return;
    void tabs.detach(id, async (moved) => {
      const next = newWindowId();
      try {
        await windows.open({ id: next, root: connection.root, tabs: serializeTabs(moved), ...(at ? { at } : {}) });
      } catch (error) {
        setProblem(t.windowFailed(error instanceof Error ? error.message : String(error)));
        return false;
      }
      rememberWindow(next, connection.root);
      return true;
    });
  };
  /** Cmd/Ctrl+W: the current tab, and after the last one the window itself when another window stays open. */
  const closeTab = () => {
    // A pinned tab stays (ADR-0027): nothing closes, and the bar says how to close it. Less surprising than moving on
    // to another tab, which would look as if the pinned one had closed.
    if (isPinned(tabs.state, tabs.active.id)) return setTabNotice((n) => ({ text: tt.pinnedNoClose, seq: (n?.seq ?? 0) + 1 }));
    // The last tab of one of two panes closes that pane (ADR-0030); the window's last tab, the window.
    if (!windows || everyTab.length > 1) return tabs.close();
    void flushAll().then(async (ok) => {
      if (!ok) return;
      // The main window always comes back on restart: closed this way, it comes back empty.
      if (windowId === MAIN_WINDOW) saveTabs(connection.root, emptyLayout());
      if (!(await windows.closeThis().catch(() => false))) tabs.close();
    });
  };
  const split = tabs.layout.panes.length > 1;
  /** Alt/Option+Shift+\ or F6 (ADR-0030): the other pane, with focus on its current tab. */
  const focusOtherPane = () => {
    if (!split) return;
    const next = (tabs.layout.active + 1) % tabs.layout.panes.length;
    tabs.focusOther();
    focusPaneTab(next);
  };
  const makeActions = (): CommandActions => ({
    newPage: () => setDialog({ kind: "new" }),
    // The Private Space, like New page; with a workspace page open, "New folder in <workspace>" is offered as well.
    newFolder: { run: () => requestNewFolder() },
    ...(here && canWriteHere && hereWorkspace
      ? {
          newWorkspacePage: {
            workspace: hereWorkspace.name,
            run: () =>
              attempt(async () => {
                const page = await servers.createPage(here.server, here.workspace, strings.workspace.newPageTitle);
                servers.expand(here.server, here.workspace);
                openWorkspacePage({ server: here.server, workspace: here.workspace, page: page.id });
              }),
          },
          newWorkspaceFolder: {
            workspace: hereWorkspace.name,
            run: () =>
              attempt(async () => {
                const folder = await servers.createFolder(here.server, here.workspace, strings.tree.newFolderTitle);
                servers.expand(here.server, here.workspace);
                // Named at once, like a new folder in a file manager.
                setDialog({ kind: "rename", target: { kind: "workspace", server: here.server, workspace: here.workspace, page: folder.id, title: folder.revision.title } });
              }),
          },
        }
      : {}),
    ...(path ? { rename: () => setDialog({ kind: "rename", target: { kind: "private", path } }), moveTo: () => requestMoveTo({ kind: "private", path }), reorder: (delta: -1 | 1) => requestReorder({ kind: "private", path }, delta) } : {}),
    ...(here && canWriteHere
      ? {
          rename: () => setDialog({ kind: "rename", target: { kind: "workspace", server: here.server, workspace: here.workspace, page: here.page, title: remoteTitle(directory, here) ?? "" } }),
          moveTo: () => requestMoveTo({ kind: "workspace", server: here.server, workspace: here.workspace, page: here.page }),
          reorder: (delta: -1 | 1) => requestReorder({ kind: "workspace", server: here.server, workspace: here.workspace, page: here.page }, delta),
          ...(servers.canShare(here.server) ? { sharePage: () => requestShare({ server: here.server, workspace: here.workspace, page: here.page }) } : {}),
        }
      : {}),
    // ADR-0006, amendment of 2026-10-27: the open workspace page (and its sub-pages) to another workspace.
    ...(here && hereWorkspace && hasOtherWritableWorkspace(directory, here)
      ? {
          copyToWorkspace: () => transfer({ direction: "between_workspaces", server: here.server, workspace: here.workspace, pageId: here.page, title: remoteTitle(directory, here) ?? "", mode: "copy" }),
          ...(canWriteHere ? { moveToWorkspace: () => transfer({ direction: "between_workspaces", server: here.server, workspace: here.workspace, pageId: here.page, title: remoteTitle(directory, here) ?? "", mode: "move" }) } : {}),
        }
      : {}),
    ...(here && hereWorkspace && servers.canManageMembers(here.server) ? { members: { workspace: hereWorkspace.name, run: () => requestMembers({ server: here.server, workspace: here.workspace }) } } : {}),
    ...(workspaceServer
      ? { newWorkspace: () => requestWorkspaceAdmin({ kind: "new", server: workspaceServer }), deletedWorkspaces: () => requestWorkspaceAdmin({ kind: "deleted", server: workspaceServer }) }
      : {}),
    ...(here && hereWorkspace?.role === "owner" && servers.canManageWorkspaces(here.server)
      ? {
          renameWorkspace: { workspace: hereWorkspace.name, run: () => requestWorkspaceAdmin({ kind: "rename", server: here.server, workspace: here.workspace }) },
          deleteWorkspace: { workspace: hereWorkspace.name, run: () => requestWorkspaceAdmin({ kind: "delete", server: here.server, workspace: here.workspace }) },
        }
      : {}),
    ...(favoriteHere && favorites.api.can(favoriteHere) ? { favorite: { on: favorites.api.has(favoriteHere), run: toggleFavorite } } : {}),
    theme: { current: themeNow, set: setTheme },
    openSettings: () => openSettings(),
    importPages: () => openSettings("import"),
    ...(assistant
      ? { askAssistant: () => assistant.ask(), toggleAssistantSize: () => assistant.toggleSize(), openAssistantSettings: () => openSettings("agents") }
      : {}),
    tabs: {
      newTab: tabs.newTab,
      closeTab,
      next: () => tabs.step(1),
      previous: () => tabs.step(-1),
      list: everyTab.map((tab) => ({ id: tab.id, label: label(tab.target) })),
      active: tabs.active.id,
      goTo: tabs.activate,
      ...tabMoves(tabs.state.tabs.findIndex((tab) => tab.id === tabs.active.id), tabs.state.tabs.length, tabs.moveBy),
      ...(windows && everyTab.length > 1 ? { moveToWindow: () => moveToWindow(tabs.active.id, null) } : {}),
      ...(split ? { moveToOtherPane: () => tabs.split(), focusOtherPane } : { split: () => tabs.split() }),
      ...(tabs.active.target.kind !== "blank" ? { pin: { pinned: tabs.active.pinned === true, run: () => togglePin() } } : {}),
      ...(tabs.state.tabs.some((tab) => tab.id !== tabs.active.id && !tab.pinned) ? { closeOthers: () => tabs.closeOthers() } : {}),
    },
    ...(editor ? { toggleMode: editor.toggleMode } : {}),
    showShortcuts: () => setDialog({ kind: "shortcuts" }),
    openNotifications: () => setNotificationsOpen(true),
    goHome,
    sidebar: { hidden: side.hidden, toggle: side.toggle },
    ...(editor?.canFormat() ? { format: (command) => void editor.format(command) } : {}),
  });

  useShortcuts("desktop", {
    "home.open": goHome,
    "sidebar.toggle": side.toggle,
    "palette.open": toggleSearch,
    "shortcuts.open": toggleShortcuts,
    "theme.cycle": cycle,
    "settings.open": () => openSettings(),
    "page.new": () => setDialog({ kind: "new" }),
    "folder.new": () => requestNewFolder(),
    "tab.new": () => tabs.newTab(),
    "tab.close": closeTab,
    "tab.next": () => tabs.step(1),
    "tab.previous": () => tabs.step(-1),
    "tab.jump": (digit) => digit !== undefined && tabs.jump(digit),
    "tab.pin": () => togglePin(),
    "tab.split": () => tabs.split(),
    "pane.focusOther": focusOtherPane,
    "page.favorite": toggleFavorite,
    ...(assistant ? { "assistant.ask": () => assistant.ask(), "assistant.size": () => assistant.toggleSize() } : {}),
  });

  // Home when nothing is open at start (ADR-0029), or the first page where the options say so. Once: closing every
  // tab leaves a new tab, which shows Home too.
  const startedEmpty = useRef(tabs.layout.panes.length === 1 && tabs.state.tabs.length === 1 && tabs.active.target.kind === "blank");
  const startOnHome = options.startOnHome;
  useEffect(() => {
    if (!startedEmpty.current || (!startOnHome && (!pages || pages.length === 0))) return;
    startedEmpty.current = false;
    if (startOnHome) tabs.open(HOME);
    else openPage(pages![0]!.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, openPage, startOnHome]);

  // Background tabs whose page is gone (moved out, deleted, renamed) close; the current tab says "not found" itself.
  // Recent pages that are gone drop out by the same rules.
  const { prune } = tabs;
  useEffect(() => {
    if (!pages) return;
    const known = new Set(pages.map((p) => p.path));
    prune((tab) => (tab.kind === "page" ? !known.has(tab.path) : tab.kind === "workspace" ? remoteGone(directory, tab) : false));
  }, [pages, directory, prune]);
  // Each kind on its own list's change: a page list from before a rename must not drop the entry the rename just moved.
  // The current tab's page stays, as its tab does: a rename's new list can arrive before the rename remaps it.
  const shownPath = useRef<string | null>(null);
  shownPath.current = path;
  useEffect(() => {
    if (!pages) return;
    const known = new Set(pages.map((p) => p.path));
    recentStore.prune((ref) => ref.kind === "private" && ref.path !== shownPath.current && !known.has(ref.path));
  }, [pages, recentStore]);
  useEffect(() => recentStore.prune((ref) => ref.kind === "workspace" && remoteGone(directory, ref)), [directory, recentStore]);

  const shownRecent = recent.slice(0, RECENT_SHOWN);
  const pending = strings.tabs.loading;
  const homeRecent: HomeRow[] = shownRecent.map(({ ref }) => {
    const how = (o: { newTab: boolean }) => (o.newTab ? { newTab: true } : undefined);
    if (ref.kind === "private") {
      const folder = folderOf(ref.path);
      return { id: `p:${ref.path}`, title: pages?.find((p) => p.path === ref.path)?.title ?? stripExtension(basename(ref.path)), space: t.local, local: true, ...(folder ? { folder } : {}), open: (o) => openPage(ref.path, how(o)) };
    }
    const target = { server: ref.server, workspace: ref.workspace, page: ref.page };
    return { id: `w:${ref.server}\n${ref.workspace}\n${ref.page}`, ...workspaceRow(directory, target, { untitled: tt.untitled, pending }), open: (o) => openWorkspacePage(target, how(o)) };
  });
  const homeFavorites: HomeRow[] = favorites.items.map((item) => {
    const ref = workspaceRefOf(item.key);
    const folder = ref ? workspaceRow(directory, ref, { untitled: tt.untitled, pending }).folder : item.detail ? folderOf(item.detail) : undefined;
    return { id: item.key, title: item.title, space: item.hint ?? "", ...(ref ? {} : { local: true }), ...(folder ? { folder } : {}), ...(item.unavailable ? { unavailable: true } : {}), open: (o) => favorites.open(item.key, o) };
  });

  // Titles of background workspace tabs and recent workspace pages come from their trees, so those trees load.
  const wanted = [
    ...everyTab.flatMap((tab) => (tab.target.kind === "workspace" ? [`${tab.target.server}\n${tab.target.workspace}`] : [])),
    ...shownRecent.flatMap(({ ref }) => (ref.kind === "workspace" ? [`${ref.server}\n${ref.workspace}`] : [])),
  ];
  const wantedKey = [...new Set(wanted)].join("\u0000");
  useEffect(() => {
    for (const key of wantedKey ? wantedKey.split("\u0000") : []) {
      const [server, workspace] = key.split("\n") as [string, string];
      const entry = directory.servers.find((s) => s.info.id === server);
      if (entry && entry.info.auth !== "signed-out" && entry.workspaces) servers.expand(server, workspace);
    }
    // `directory` changes with every poll; only the set of workspaces and the servers' state matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, servers, directory.servers]);

  const itemsOf = (state: TabsState): TabItem[] => state.tabs.map((tab) => ({ id: tab.id, label: label(tab.target), ...(tab.target.kind === "page" ? { title: tab.target.path } : {}), ...(tab.target.kind === "home" ? { icon: "home" as const } : {}), ...(tab.pinned ? { pinned: true } : {}) }));
  /** The tab's menu also stars its page (ADR-0027). */
  const tabMenuExtras = (id: string): MenuItem[] => {
    const tab = everyTab.find((x) => x.id === id);
    const ref = tab ? favoriteOf(tab.target) : null;
    if (!ref || !favorites.api.can(ref)) return [];
    return [{ id: "favorite", label: favorites.api.has(ref) ? strings.favorites.remove : strings.favorites.add, onSelect: () => favorites.api.toggle(ref) }];
  };

  /** What a tab shows. Keyed by the tab, so the same page in two panes is two editors (sharing one session, ADR-0030). */
  const paneContent = ({ id, target: shown }: Tab) =>
    shown.kind === "settings" ? (
      <SettingsView section={shown.section ?? "top"} request={shown} />
    ) : shown.kind === "agent-run" ? (
      <AgentSessionView key={`${id}\n${shown.run}`} run={shown.run} />
    ) : shown.kind === "workspace" ? (
      <WorkspacePageView key={`${id}\n${shown.server}\n${shown.workspace}\n${shown.page}`} target={shown} onTransfer={transfer} />
    ) : shown.kind === "page" ? (
      <PageView key={`${id}\n${shown.path}`} path={shown.path} />
    ) : (
      <HomeView recent={homeRecent} favorites={homeFavorites} />
    );

  // Unsaved edits are written first, so the transfer sends (and hashes) what is on screen.
  const transfer = (target: TransferTarget) => void flushAll().then((ok) => ok && setDialog({ kind: "transfer", target }));
  // A drop across spaces opens the same dialog, prefilled (ADR-0006, amendment of 2026-10-26).
  const transferRef = useRef(transfer);
  transferRef.current = transfer;
  useEffect(
    () =>
      onSpaceDrop((drop) => {
        const next = transferTargetFor(drop);
        if (next) transferRef.current(next);
      }),
    [],
  );

  return (
    <HintContext value={hints}>
    <FavoritesContext value={favorites.api}>
    <div className="shell" ref={shell} style={sidebar.style} data-sidebar-hidden={side.hidden ? "" : undefined} data-sidebar-moving={side.moving ? "" : undefined}>
      <Sidebar hidden={side} favorites={favorites} pages={pages ?? []} current={path} currentRemote={remote} currentRun={target.kind === "agent-run" ? target.run : null} onSearch={() => setDialog({ kind: "search" })} onNewPage={() => setDialog({ kind: "new" })} onNewFolder={() => requestNewFolder()} onTransfer={transfer} notificationsOpen={notificationsOpen} onNotificationsOpen={setNotificationsOpen} onHome={goHome} />
      <main className="main">
        <Panes
          tabs={tabs}
          bar={(pane) => (
            <TabBar
              tabs={itemsOf(pane.state)}
              active={pane.state.active}
              label={pane.label}
              windowTabs={pane.windowTabs}
              paneDrop={pane.paneDrop}
              onActivate={tabs.activate}
              onClose={tabs.close}
              onNew={() => {
                tabs.focusPane(pane.index);
                tabs.newTab();
              }}
              onMove={tabs.move}
              onPin={(id, pinned) => tabs.setPinned(pinned, id)}
              onCloseOthers={(id) => tabs.closeOthers(id)}
              menuExtras={(id) => [...pane.menuItems(id), ...tabMenuExtras(id)]}
              notice={pane.index === tabs.layout.active ? tabNotice : null}
              {...(pane.index === 0 ? { onHome: goHome } : {})}
              {...(pane.index === 0 && side.hidden ? { onShowSidebar: () => side.setHidden(false), showSidebarRef: side.showRef } : {})}
              {...(windows ? { onDetach: moveToWindow } : {})}
            />
          )}
          notices={
            <>
              {watchError && (
                <p role="alert" className="alert alert-warning banner">
                  {t.watchError(watchError)}
                </p>
              )}
              {favorites.error && (
                <p role="alert" className="alert alert-danger banner">
                  {favorites.error}{" "}
                  <Button variant="quiet" small onClick={favorites.dismissError}>
                    {dismissText}
                  </Button>
                </p>
              )}
              {problem && (
                <p role="alert" className="alert alert-danger banner">
                  {problem}{" "}
                  <Button variant="quiet" small onClick={() => setProblem(null)}>
                    {dismissText}
                  </Button>
                </p>
              )}
              <RecoveryNotice />
            </>
          }
          content={(tab) => paneContent(tab)}
        />
      </main>
      {!side.hidden && <SidebarResizer sidebar={sidebar} shell={shell} />}
      <MascotLayer />
      <UpdateNotice />
      <TooltipLayer />
      <SpaceDragBadge />
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-favorites-note="">
        {favorites.said}
      </div>
      {dialog?.kind === "search" && <SearchPalette commands={buildCommands(makeActions(), strings, "desktop", platform)} onRun={runCommand} onClose={() => setDialog(null)} />}
      {dialog?.kind === "new" && <NewPageDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "shortcuts" && <ShortcutsDialog client="desktop" platform={platform} onClose={() => setDialog(null)} />}
      {dialog?.kind === "rename" && <RenamePage target={dialog.target} onClose={() => setDialog(null)} />}
      {dialog?.kind === "transfer" && <TransferDialog target={dialog.target} onClose={() => setDialog(null)} />}
    </div>
    </FavoritesContext>
    </HintContext>
  );
}
