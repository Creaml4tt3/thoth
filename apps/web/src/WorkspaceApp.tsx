import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PAGE_TITLE_MAX, hasCapability, roleCan, type Capabilities } from "@thoth/workspace-protocol";
import { buildCommands, type Command, type CommandActions } from "@thoth/app-ui/keyboard/commands.ts";
import { useEditorActions } from "@thoth/app-ui/keyboard/editor-actions.ts";
import { ShortcutsDialog } from "@thoth/app-ui/keyboard/ShortcutsDialog.tsx";
import { requestMoveTo } from "@thoth/app-ui/order/move-to.ts";
import { requestShare } from "@thoth/app-ui/workspace/share-request.ts";
import { ShareButton } from "@thoth/app-ui/workspace/ShareButton.tsx";
import { requestMembers } from "@thoth/app-ui/workspace/members-request.ts";
import { requestWorkspaceAdmin } from "@thoth/app-ui/workspace/workspace-admin-request.ts";
import { ServerWorkspaceActions, ServerWorkspacesFooter } from "@thoth/app-ui/workspace/ServerWorkspaces.tsx";
import { requestReorder } from "@thoth/app-ui/order/reorder-request.ts";
import { RenameDialog } from "@thoth/app-ui/order/RenameDialog.tsx";
import { useTheme } from "@thoth/app-ui/ui/theme.ts";
import { TabBar, type TabItem } from "@thoth/app-ui/tabs/TabBar.tsx";
import { allTabs } from "@thoth/app-ui/tabs/layout.ts";
import { Panes, focusPaneTab } from "@thoth/app-ui/tabs/Panes.tsx";
import { remoteGone, remoteTitle } from "@thoth/app-ui/tabs/remote.ts";
import type { OpenOptions, Tab, TabTarget, TabsState } from "@thoth/app-ui/tabs/model.ts";
import { tabMoves, useTabs } from "@thoth/app-ui/tabs/useTabs.ts";
import { useShortcuts } from "@thoth/app-ui/keyboard/useShortcuts.ts";
import { currentPlatform } from "@thoth/app-ui/keyboard/shortcuts.ts";
import { PageHostContext, type PageHost } from "@thoth/app-ui/editor/host.ts";
import { pickImageWithInput } from "@thoth/app-ui/editor/media.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { createNotificationCenter, type NotificationTarget } from "@thoth/app-ui/notifications/core.ts";
import { NotificationBell } from "@thoth/app-ui/notifications/NotificationBell.tsx";
import { LegalLinks } from "./LegalLinks.tsx";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { IconButton } from "@thoth/app-ui/ui/IconButton.tsx";
import { SidebarResizer, useSidebarWidth } from "@thoth/app-ui/ui/SidebarResizer.tsx";
import { TooltipLayer, tipIfClipped } from "@thoth/app-ui/ui/Tooltip.tsx";
import { HintContext } from "@thoth/app-ui/keyboard/hints.ts";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";
import { Notice } from "@thoth/app-ui/ui/Notice.tsx";
import type { ServerDirectory, WorkspacePageRef } from "@thoth/app-ui/workspace/directory.ts";
import { describeLimits } from "@thoth/app-ui/workspace/limits.ts";
import { WorkspacePage } from "@thoth/app-ui/workspace/WorkspacePage.tsx";
import { WorkspaceSection } from "@thoth/app-ui/workspace/WorkspaceTree.tsx";
import { ThemeStoreContext, ThemeSwitch } from "./ThemeSwitch.tsx";
import { TreeList } from "@thoth/app-ui/order/TreeList.tsx";
import { LanguageSwitch } from "./LanguageSwitch.tsx";
import { SearchDialog } from "./SearchDialog.tsx";
import { track } from "./analytics.ts";
import type { WebEnv } from "./env.ts";
import { SERVER_ID } from "./servers.ts";
import { SettingsView } from "./SettingsView.tsx";
import { loadSidebarHidden, loadSidebarWidth, saveSidebarHidden, saveSidebarWidth } from "./sidebar-store.ts";
import { useSidebarHidden } from "@thoth/app-ui/ui/sidebar-hidden.ts";
import { clearTabs, loadTabs, saveTabs } from "./tabs-store.ts";
import { FavoritesContext, type FavoriteRef, type FavoritesApi } from "@thoth/app-ui/favorites/context.ts";
import { FavoriteButton } from "@thoth/app-ui/favorites/FavoriteButton.tsx";
import { FavoritesList } from "@thoth/app-ui/favorites/FavoritesList.tsx";
import { useWorkspaceFavorites, workspaceRefOf } from "@thoth/app-ui/favorites/useWorkspaceFavorites.ts";
import { createWorkspaceFavorites } from "@thoth/app-ui/favorites/workspace-favorites.ts";
import { HOME, isPinned } from "@thoth/app-ui/tabs/model.ts";
import { HomeView, type HomeRow } from "@thoth/app-ui/home/HomeView.tsx";
import { createRecentStore, RECENT_SHOWN } from "@thoth/app-ui/home/recent.ts";
import { useRecentPages } from "@thoth/app-ui/home/useRecent.ts";
import { workspaceRow } from "@thoth/app-ui/home/rows.ts";
import { tip } from "@thoth/app-ui/ui/Tooltip.tsx";
import { useShortcutHint } from "@thoth/app-ui/keyboard/hints.ts";
import type { MenuItem } from "@thoth/app-ui/order/ContextMenu.tsx";
import { onSpaceDrop, type SpaceDrag } from "@thoth/app-ui/order/space-drag.ts";
import { TransferDialog, type TransferTarget } from "@thoth/app-ui/transfer/TransferDialog.tsx";
import { createTransferService, serverAccess } from "@thoth/app-ui/transfer/service.ts";
import { betweenTarget, betweenTargetFor, hasOtherWritableWorkspace } from "@thoth/app-ui/transfer/targets.ts";
import { transferEvent } from "@thoth/app-ui/transfer/notify.ts";
import { BetweenWorkspaces, storageRecords } from "@thoth/transfer";
import { FeedbackDialog } from "@thoth/app-ui/feedback/FeedbackDialog.tsx";

/** The system, in one word, for "Include the app version and system" (ADR-0033); nothing when it is not plain. */
function browserOs(userAgent: string = globalThis.navigator?.userAgent ?? ""): { os?: string } {
  const os = /iPhone|iPad/.test(userAgent) ? "iOS" : /Android/.test(userAgent) ? "Android" : /Mac OS X|Macintosh/.test(userAgent) ? "macOS" : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : undefined;
  return os ? { os } : {};
}

/** The recent pages of an account in this browser (ADR-0029): this prefix and the account's id. */
export const RECENT_KEY_PREFIX = "thoth.web.recent.";

interface Props {
  env: WebEnv;
  directory: ServerDirectory;
  capabilities: Capabilities;
  account: { id: string; displayName: string } | null;
  signOut(): Promise<void>;
  signInAgain(): void;
}

/** Signed in: workspaces and their page trees on the left, the open page on the right. */
export function WorkspaceApp({ env, directory, capabilities, account, signOut, signInAgain }: Props) {
  const t = useStrings();
  const state = useSyncExternalStore(directory.subscribe, directory.getState);
  const entry = state.servers.find((s) => s.info.id === SERVER_ID);
  const workspaces = entry?.workspaces ?? null;
  type Dialog = { kind: "search" } | { kind: "shortcuts" } | { kind: "feedback" } | { kind: "rename"; page: string; workspace: string; title: string } | { kind: "transfer"; target: TransferTarget } | null;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const signedOut = entry?.info.auth === "signed-out";
  const canSearch = hasCapability(capabilities, "search");
  const canFeedback = hasCapability(capabilities, "feedback");
  const openFeedback = () => setDialog({ kind: "feedback" });
  const limits = capabilities.limits ? describeLimits(capabilities.limits as Record<string, number>, t.limits) : [];
  const target = env.analyticsTarget;

  // Leaving a page writes its pending edits first; a conflict or an error keeps the user on it.
  const flushers = useRef(new Set<() => Promise<boolean>>());
  const registerFlush = useCallback((flush: () => Promise<boolean>) => {
    flushers.current.add(flush);
    return () => void flushers.current.delete(flush);
  }, []);
  const flushAll = useCallback(async () => (await Promise.all([...flushers.current].map((f) => f().catch(() => false)))).every(Boolean), []);
  // Images (ADR-0028): the browser's own file picker.
  const pageHost = useMemo<PageHost>(() => ({ client: "web", autosaveMs: env.autosaveMs, now: () => new Date(env.now()), registerFlush, pickImage: () => pickImageWithInput() }), [env, registerFlush]);

  // Tabs: restored per browser (ids only, no titles), saved on every change. Leaving the page on screen writes its edits first.
  const tabs = useTabs({ initial: () => loadTabs(env.localStorage), flush: flushAll, save: (layout) => saveTabs(env.localStorage, layout) });
  const everyTab = allTabs(tabs.layout);
  const split = tabs.layout.panes.length > 1;
  /** Alt/Option+Shift+\ (ADR-0030): the other pane, with focus on its current tab. */
  const focusOtherPane = () => {
    if (!split) return;
    const next = (tabs.layout.active + 1) % tabs.layout.panes.length;
    tabs.focusOther();
    focusPaneTab(next);
  };
  const shown = tabs.active.target;
  const current: WorkspacePageRef | null = shown.kind === "workspace" ? { server: shown.server, workspace: shown.workspace, page: shown.page } : null;
  const openPage = useCallback((ref: WorkspacePageRef, options?: OpenOptions) => tabs.open({ kind: "workspace", ...ref }, options), [tabs]);
  const openSettings = useCallback(() => tabs.open({ kind: "settings" }), [tabs]);

  // Favorites (ADR-0027): workspace pages, kept in this browser per server, account and workspace, never sent.
  const favoriteStore = useMemo(() => createWorkspaceFavorites(() => env.localStorage ?? null), [env]);
  const accountId = account?.id;
  const accountOf = useCallback(() => accountId, [accountId]);
  const favorites = useWorkspaceFavorites(directory, favoriteStore, current, accountOf);
  const [favoriteSaid, setFavoriteSaid] = useState("");
  const favoritesApi = useMemo<FavoritesApi>(
    () => ({
      has: (ref) => ref.kind === "workspace" && favorites.has(ref),
      can: (ref) => ref.kind === "workspace" && favorites.can(ref),
      toggle: (ref) => {
        if (ref.kind !== "workspace" || !favorites.can(ref)) return;
        const title = remoteTitle(directory.getState(), ref) || t.tabs.untitled;
        setFavoriteSaid(favorites.toggle(ref) ? t.favorites.added(title) : t.favorites.removed(title));
      },
    }),
    [favorites, directory, t],
  );
  const currentFavorite: FavoriteRef | null = current ? { kind: "workspace", ...current } : null;
  const toggleFavorite = () => {
    if (currentFavorite && favoritesApi.can(currentFavorite)) favoritesApi.toggle(currentFavorite);
  };
  /** Said in the tab bar (Alt+W on a pinned tab); a new `seq` says it again. */
  const [tabNotice, setTabNotice] = useState<{ text: string; seq: number } | null>(null);
  const closeTab = () => {
    // A pinned tab stays (ADR-0027): nothing closes, and the bar says how to close it.
    if (isPinned(tabs.state, tabs.active.id)) return setTabNotice((n) => ({ text: t.tabs.pinnedNoClose, seq: (n?.seq ?? 0) + 1 }));
    tabs.close();
  };
  const togglePin = () => {
    if (tabs.active.target.kind !== "blank") tabs.setPinned(!tabs.active.pinned);
  };

  // Home (ADR-0029): one tab, and what a new tab shows. Its recent pages are kept in this browser per account, by id;
  // with no account known they last for the visit.
  const goHome = () => tabs.open(HOME);
  const recentStore = useMemo(() => createRecentStore(() => (accountId ? (env.localStorage ?? null) : null), `${RECENT_KEY_PREFIX}${accountId ?? ""}`), [env, accountId]);
  const recent = useRecentPages(recentStore, tabs.active);
  useEffect(() => recentStore.prune((ref) => ref.kind === "workspace" && remoteGone(state, ref)), [recentStore, state]);
  const shownRecent = recent.slice(0, RECENT_SHOWN);
  const homeWords = { untitled: t.tabs.untitled, pending: t.tabs.loading };
  const homeRecent: HomeRow[] = shownRecent.flatMap(({ ref }) => {
    if (ref.kind !== "workspace") return [];
    const page = { server: ref.server, workspace: ref.workspace, page: ref.page };
    return [{ id: `${ref.workspace}\n${ref.page}`, ...workspaceRow(state, page, homeWords), open: (o: { newTab: boolean }) => openPage(page, o.newTab ? { newTab: true } : undefined) }];
  });
  const homeFavorites: HomeRow[] = favorites.items.flatMap((item) => {
    const ref = workspaceRefOf(item.key);
    if (!ref) return [];
    const { folder } = workspaceRow(state, ref, homeWords);
    return [{ id: item.key, title: item.title, space: item.hint ?? "", ...(folder ? { folder } : {}), ...(item.unavailable ? { unavailable: true } : {}), open: (o: { newTab: boolean }) => openPage(ref, o.newTab ? { newTab: true } : undefined) }];
  });
  const homeKeys = useShortcutHint("home.open");

  // Notifications (ADR-0018): the list under the bell only, in memory for this tab. Its one event is a save conflict;
  // nothing is shown outside the browser tab (there is no system notifier on the web).
  const strings = useRef(t);
  strings.current = t;
  const notifications = useMemo(() => createNotificationCenter({ strings: () => strings.current.notifications, now: () => env.now() }), [env]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  // Copy and move between workspaces (ADR-0006, amendment of 2026-10-27). There is no Private Space here, so the
  // records of unfinished transfers are kept in this browser's storage (no page text, no credential), for this visit
  // when there is none.
  const transfers = useMemo(() => {
    const memory = new Map<string, string>();
    const storage = env.localStorage ?? { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) };
    return createTransferService((onProgress) => new BetweenWorkspaces({ records: storageRecords(storage), server: serverAccess(directory), now: () => new Date(env.now()), onProgress }), {
      onSettled: (record, interrupted) => {
        const event = transferEvent(record, interrupted);
        if (event) notifications.push(event);
      },
    });
  }, [env, directory, notifications]);
  useEffect(() => {
    if (workspaces !== null) void transfers.recover();
  }, [transfers, workspaces !== null]);
  // Unsaved edits are written first, so the transfer copies what is on screen.
  const transfer = (next: TransferTarget) => void flushAll().then((ok) => ok && setDialog({ kind: "transfer", target: next }));
  const transferRef = useRef(transfer);
  transferRef.current = transfer;
  useEffect(
    () =>
      onSpaceDrop((drop) => {
        const next = betweenTargetFor(drop);
        if (next) transferRef.current(next);
      }),
    [],
  );
  const toWorkspace = (drag: SpaceDrag, mode: "copy" | "move") => {
    const next = betweenTarget(drag, mode);
    if (next) transfer(next);
  };

  // A page goes to its tab, or opens in a new one: the page on screen stays where it is.
  const openNotification = useCallback((to: NotificationTarget) => {
    if (to.kind === "workspacePage") tabs.openOrFocus({ kind: "workspace", server: to.server, workspace: to.workspace, page: to.page });
  }, [tabs]);

  // The only workspace (a new account has exactly one) opens by itself.
  const only = workspaces?.length === 1 ? workspaces[0]!.id : null;
  useEffect(() => {
    if (only) directory.expand(SERVER_ID, only);
  }, [directory, only]);

  useEffect(() => track({ name: "screen_view", params: { screen: current ? "/app/page" : "/app" } }, target), [current === null, target]);

  // The keyboard (ADR-0016 rule 7). Where a browser keeps a key, the web client uses another (see the shortcut table).
  const platform = useMemo(() => currentPlatform(), []);
  const hints = useMemo(() => ({ client: "web" as const, platform }), [platform]);
  // The sidebar's width: dragged by its edge, remembered in this browser (the width and nothing else).
  const shell = useRef<HTMLDivElement>(null);
  const sidebar = useSidebarWidth({ initial: () => loadSidebarWidth(env.localStorage), save: (width) => saveSidebarWidth(env.localStorage, width) });
  const side = useSidebarHidden({ initial: () => loadSidebarHidden(env.localStorage), save: (hidden) => saveSidebarHidden(env.localStorage, hidden) });
  const themeStore = useContext(ThemeStoreContext)!;
  const { theme, setTheme, cycle } = useTheme(themeStore);
  const editor = useEditorActions();
  const toggleSearch = () => setDialog((d) => (d?.kind === "search" ? null : { kind: "search" }));
  const toggleShortcuts = () => setDialog((d) => (d?.kind === "shortcuts" ? null : { kind: "shortcuts" }));

  /** A command runs once the palette has closed and given focus back. */
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

  const label = (tab: TabTarget): string => {
    switch (tab.kind) {
      case "workspace":
        return remoteTitle(state, tab) ?? t.tabs.untitled;
      case "settings":
        return t.tabs.settings;
      case "home":
        return t.home.title;
      default:
        return t.tabs.blank;
    }
  };
  /** Where "New page" and "New folder" go: the workspace of the open page, else the first one the user can write to. */
  const home = workspaces?.find((w) => roleCan(w.role, "write") && (current === null || w.id === current.workspace));
  const attempt = (job: () => Promise<void>) => void job().catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
  const newPage = () => {
    if (!home) return;
    attempt(async () => {
      const page = await directory.createPage(SERVER_ID, home.id, t.workspace.newPageTitle);
      directory.expand(SERVER_ID, home.id);
      track({ name: "page_create" }, target);
      openPage({ server: SERVER_ID, workspace: home.id, page: page.id });
    });
  };
  const newFolder = () => {
    if (!home) return;
    attempt(async () => {
      const folder = await directory.createFolder(SERVER_ID, home.id, t.tree.newFolderTitle);
      directory.expand(SERVER_ID, home.id);
      track({ name: "page_create" }, target);
      // Named at once, like a new folder in a file manager.
      setDialog({ kind: "rename", page: folder.id, workspace: home.id, title: folder.revision.title });
    });
  };
  const here = current && workspaces?.find((w) => w.id === current.workspace);
  const canWriteHere = here ? roleCan(here.role, "write") : false;
  const makeActions = (): CommandActions => ({
    ...(home ? { newPage, newFolder: { workspace: workspaces!.length > 1 ? home.name : "", run: newFolder } } : {}),
    ...(current && canWriteHere
      ? {
          rename: () => setDialog({ kind: "rename", page: current.page, workspace: current.workspace, title: remoteTitle(state, current) ?? "" }),
          moveTo: () => requestMoveTo({ kind: "workspace", ...current }),
          reorder: (delta: -1 | 1) => requestReorder({ kind: "workspace", ...current }, delta),
          ...(hasCapability(capabilities, "public-share") ? { sharePage: () => requestShare(current) } : {}),
        }
      : {}),
    ...(current && here && hasOtherWritableWorkspace(state, current)
      ? {
          copyToWorkspace: () => transfer({ direction: "between_workspaces", server: current.server, workspace: current.workspace, pageId: current.page, title: remoteTitle(state, current) ?? "", mode: "copy" }),
          ...(canWriteHere ? { moveToWorkspace: () => transfer({ direction: "between_workspaces", server: current.server, workspace: current.workspace, pageId: current.page, title: remoteTitle(state, current) ?? "", mode: "move" }) } : {}),
        }
      : {}),
    ...(current && here && hasCapability(capabilities, "members") ? { members: { workspace: here.name, run: () => requestMembers({ server: current.server, workspace: current.workspace }) } } : {}),
    // ADR-0025: several workspaces per account.
    ...(hasCapability(capabilities, "workspace-management") && workspaces !== null
      ? { newWorkspace: () => requestWorkspaceAdmin({ kind: "new", server: SERVER_ID }), deletedWorkspaces: () => requestWorkspaceAdmin({ kind: "deleted", server: SERVER_ID }) }
      : {}),
    ...(current && here?.role === "owner" && hasCapability(capabilities, "workspace-management")
      ? {
          renameWorkspace: { workspace: here.name, run: () => requestWorkspaceAdmin({ kind: "rename", server: current.server, workspace: current.workspace }) },
          deleteWorkspace: { workspace: here.name, run: () => requestWorkspaceAdmin({ kind: "delete", server: current.server, workspace: current.workspace }) },
        }
      : {}),
    ...(currentFavorite && favoritesApi.can(currentFavorite) ? { favorite: { on: favoritesApi.has(currentFavorite), run: toggleFavorite } } : {}),
    theme: { current: theme, set: setTheme },
    openSettings,
    tabs: {
      newTab: tabs.newTab,
      closeTab,
      next: () => tabs.step(1),
      previous: () => tabs.step(-1),
      list: everyTab.map((tab) => ({ id: tab.id, label: label(tab.target) })),
      active: tabs.active.id,
      goTo: tabs.activate,
      ...tabMoves(tabs.state.tabs.findIndex((tab) => tab.id === tabs.active.id), tabs.state.tabs.length, tabs.moveBy),
      ...(tabs.active.target.kind !== "blank" ? { pin: { pinned: tabs.active.pinned === true, run: togglePin } } : {}),
      ...(tabs.state.tabs.some((tab) => tab.id !== tabs.active.id && !tab.pinned) ? { closeOthers: () => tabs.closeOthers() } : {}),
      ...(split ? { moveToOtherPane: () => tabs.split(), focusOtherPane } : { split: () => tabs.split() }),
    },
    ...(editor ? { toggleMode: editor.toggleMode } : {}),
    showShortcuts: () => setDialog({ kind: "shortcuts" }),
    ...(canFeedback ? { sendFeedback: openFeedback } : {}),
    openNotifications: () => setNotificationsOpen(true),
    goHome,
    sidebar: { hidden: side.hidden, toggle: side.toggle },
    ...(editor?.canFormat() ? { format: (command) => void editor.format(command) } : {}),
  });

  useShortcuts("web", {
    "palette.open": toggleSearch,
    "shortcuts.open": toggleShortcuts,
    "theme.cycle": cycle,
    "settings.open": openSettings,
    ...(home ? { "page.new": newPage, "folder.new": newFolder } : {}),
    "tab.new": tabs.newTab,
    "tab.close": closeTab,
    "tab.pin": togglePin,
    "tab.split": () => tabs.split(),
    "pane.focusOther": focusOtherPane,
    "page.favorite": toggleFavorite,
    "tab.next": () => tabs.step(1),
    "tab.previous": () => tabs.step(-1),
    "tab.jump": (digit) => digit !== undefined && tabs.jump(digit),
    "home.open": goHome,
    "sidebar.toggle": side.toggle,
  });

  // Background tabs whose page is gone close; the current tab says "not found" itself.
  const { prune } = tabs;
  useEffect(() => {
    prune((tab) => tab.kind === "workspace" && remoteGone(state, tab));
  }, [state, prune]);

  // The titles of background tabs and recent pages come from their workspace trees, so those trees load.
  const wanted = [...new Set([...everyTab.flatMap((tab) => (tab.target.kind === "workspace" ? [tab.target.workspace] : [])), ...shownRecent.flatMap(({ ref }) => (ref.kind === "workspace" ? [ref.workspace] : []))])].join("\u0000");
  useEffect(() => {
    if (signedOut || !workspaces) return;
    for (const id of wanted ? wanted.split("\u0000") : []) if (workspaces.some((w) => w.id === id)) directory.expand(SERVER_ID, id);
  }, [directory, wanted, workspaces, signedOut]);

  const itemsOf = (state: TabsState): TabItem[] => state.tabs.map((tab) => ({ id: tab.id, label: label(tab.target), ...(tab.target.kind === "home" ? { icon: "home" as const } : {}), ...(tab.pinned ? { pinned: true } : {}) }));
  const tabMenuExtras = (id: string): MenuItem[] => {
    const tab = everyTab.find((x) => x.id === id);
    if (tab?.target.kind !== "workspace") return [];
    const ref: FavoriteRef = { kind: "workspace", server: tab.target.server, workspace: tab.target.workspace, page: tab.target.page };
    return favoritesApi.can(ref) ? [{ id: "favorite", label: favoritesApi.has(ref) ? t.favorites.remove : t.favorites.add, onSelect: () => favoritesApi.toggle(ref) }] : [];
  };

  /** What a tab shows. Keyed by the tab, so the same page in two panes is two editors (sharing one session, ADR-0030). */
  const paneContent = ({ id, target: shown }: Tab) => {
    const current: WorkspacePageRef | null = shown.kind === "workspace" ? { server: shown.server, workspace: shown.workspace, page: shown.page } : null;
    return shown.kind === "settings" ? (
      <SettingsView account={account} signOut={() => void doSignOut()} signingOut={signingOut} showShortcuts={() => setDialog({ kind: "shortcuts" })} {...(canFeedback ? { sendFeedback: openFeedback } : {})} />
      ) : current ? (
        <WorkspacePage
          key={`${id}\n${current.workspace}\n${current.page}`}
          directory={directory}
          target={current}
          modeSpace={env.server}
          openPage={openPage}
          goneNotice={<Notice title={t.workspace.missingTitle} detail={t.workspace.missingDetail} />}
          actions={
            <span className="page-actions">
              <FavoriteButton target={{ kind: "workspace", ...current }} />
              <ShareButton directory={directory} target={current} />
              {hasOtherWritableWorkspace(state, current) && (
                <IconButton icon="to-workspace" label={t.transfer.toOther} onClick={() => transfer({ direction: "between_workspaces", server: current.server, workspace: current.workspace, pageId: current.page, title: remoteTitle(state, current) ?? "", mode: "copy" })} />
              )}
            </span>
          }
          signedOutNotice={<Notice title={t.web.signInAgain} detail={t.web.sessionEnded} />}
          onOpened={() => track({ name: "page_open" }, target)}
          onSaved={() => track({ name: "page_save" }, target)}
          onConflict={(event) => {
            track(event.kind === "shown" ? { name: "conflict_shown" } : { name: "conflict_resolved", params: { choice: event.choice } }, target);
            // The page's title and where it is, nothing of its text (ADR-0018).
            if (event.kind === "shown") notifications.push({ kind: "saveConflict", page: remoteTitle(state, current) ?? t.tabs.untitled, open: { kind: "workspacePage", ...current } });
          }}
        />
      ) : (
      <HomeView recent={homeRecent} favorites={homeFavorites} />
    );
  };

  const doSignOut = async () => {
    if (!(await flushAll())) return;
    setSigningOut(true);
    try {
      clearTabs(env.localStorage); // a signed-out browser keeps no list of what was open
      await signOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <HintContext value={hints}>
    <FavoritesContext value={favoritesApi}>
    <PageHostContext.Provider value={pageHost}>
      <div className="shell web-shell" ref={shell} style={sidebar.style} data-sidebar-hidden={side.hidden ? "" : undefined} data-sidebar-moving={side.moving ? "" : undefined}>
        <aside ref={side.sidebarRef} className="sidebar" aria-label={t.web.sidebar} inert={side.hidden} aria-hidden={side.hidden || undefined}>
          <div className="ws">
            <button type="button" className="ws-home" aria-label={t.home.brand} aria-keyshortcuts={homeKeys?.aria} {...tip(t.home.title, homeKeys?.keys)} onClick={goHome}>
              <Mark size={18} />
              <span className="ws-name">Thoth</span>
            </button>
            <IconButton ref={side.hideRef} icon="sidebar" label={t.sidebar.hide} shortcut="sidebar.toggle" onClick={() => side.setHidden(true)} />
          </div>
          {canSearch && (
            <button type="button" className="search-trigger" onClick={() => setDialog({ kind: "search" })} aria-label={t.web.search} aria-keyshortcuts="Control+K Meta+K">
              <span>{t.web.search}</span>
              <kbd aria-hidden="true">⌘K</kbd>
            </button>
          )}
          <nav aria-label={t.web.pages} className="tree-wrap">
            {favorites.items.length > 0 && (
              // The Favorites first, and only when there is one (ADR-0027).
              <section aria-label={t.favorites.section} className="web-favorites">
                <div className="sec">
                  <span className="sec-name">{t.favorites.section}</span>
                </div>
                <FavoritesList
                  items={favorites.items}
                  onOpen={(key, options) => {
                    const ref = workspaceRefOf(key);
                    if (ref) openPage(ref, options.newTab ? { newTab: true } : undefined);
                  }}
                  onMove={(key, to) => {
                    const ref = workspaceRefOf(key);
                    if (ref) favorites.move(ref, to);
                  }}
                  onRemove={(key) => {
                    const ref = workspaceRefOf(key);
                    if (ref) favoritesApi.toggle({ kind: "workspace", ...ref });
                  }}
                  scroller={() => shell.current?.querySelector<HTMLElement>(".tree-wrap") ?? null}
                />
              </section>
            )}
            <div className="sec">
              <span className="sec-name">{t.web.workspaces}</span>
              {entry && (
                <span className="sec-actions">
                  <ServerWorkspaceActions directory={directory} server={SERVER_ID} serverLabel={entry.info.label} />
                </span>
              )}
            </div>
            {entry?.error ? (
              <p className="muted tree-empty">{entry.error}</p>
            ) : workspaces === null ? (
              <p className="muted tree-empty">{t.web.loading}</p>
            ) : workspaces.length === 0 ? (
              <p className="muted tree-empty">{t.web.noWorkspaces}</p>
            ) : (
              <TreeList label={t.web.workspaces}>
                {workspaces.map((workspace) => (
                  <WorkspaceSection
                    key={workspace.id}
                    directory={directory}
                    server={SERVER_ID}
                    serverLabel={entry!.info.label}
                    workspace={workspace}
                    current={current}
                    openPage={openPage}
                    flush={flushAll}
                    spaceDrops
                    onToWorkspace={toWorkspace}
                    onPageCreated={() => track({ name: "page_create" }, target)}
                  />
                ))}
              </TreeList>
            )}
            {workspaces !== null && <ServerWorkspacesFooter directory={directory} server={SERVER_ID} />}
          </nav>
          <div className="web-account">
            <p className="server-caution">{t.web.caution}</p>
            {limits.length > 0 && (
              <details className="server-limits">
                <summary className="muted">{t.web.limitsTitle}</summary>
                <ul>
                  {limits.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            )}
            {account && <p className="muted web-who" {...tipIfClipped(t.web.signedInAs(account.displayName))}>{t.web.signedInAs(account.displayName)}</p>}
            <div className="side-actions">
              <LanguageSwitch />
              <ThemeSwitch />
              <NotificationBell center={notifications} open={notificationsOpen} onOpenChange={setNotificationsOpen} onOpenTarget={openNotification} />
              <IconButton icon="sign-out" label={signingOut ? t.web.signingOut : t.web.signOut} disabled={signingOut} onClick={() => void doSignOut()} />
            </div>
            <LegalLinks />
          </div>
        </aside>
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
              />
            )}
            notices={
              <>
                {signedOut && (
                  <p role="alert" className="alert alert-warning banner">
                    {t.web.sessionEnded}{" "}
                    <Button variant="quiet" small onClick={signInAgain}>
                      {t.web.signInAgain}
                    </Button>
                  </p>
                )}
                {problem && (
                  <p role="alert" className="alert alert-danger banner">
                    {problem}{" "}
                    <Button variant="quiet" small onClick={() => setProblem(null)}>
                      {t.keyboard.close}
                    </Button>
                  </p>
                )}
              </>
            }
            content={(tab) => paneContent(tab)}
          />
        </main>
        {!side.hidden && <SidebarResizer sidebar={sidebar} shell={shell} />}
        <TooltipLayer />
        <div className="sr-only" aria-live="polite" aria-atomic="true" data-favorites-note="">
          {favoriteSaid}
        </div>
        {dialog?.kind === "search" && (
          <SearchDialog
            directory={directory}
            workspaces={workspaces ?? []}
            canSearch={canSearch}
            commands={buildCommands(makeActions(), t, "web", platform)}
            onRun={runCommand}
            onOpen={openPage}
            onClose={() => setDialog(null)}
            onSearched={() => track({ name: "search" }, target)}
          />
        )}
        {dialog?.kind === "transfer" && <TransferDialog target={dialog.target} onClose={() => setDialog(null)} servers={directory} transfers={transfers} openWorkspacePage={(ref) => openPage(ref)} />}
        {dialog?.kind === "shortcuts" && <ShortcutsDialog client="web" platform={platform} onClose={() => setDialog(null)} />}
        {dialog?.kind === "feedback" && (
          <FeedbackDialog
            target={() => Promise.resolve({ label: entry?.info.label ?? new URL(env.server).host, send: (input) => directory.client(SERVER_ID).sendFeedback(input) })}
            context={{ client: "web", ...browserOs(), language: t.lang }}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === "rename" && (
          <RenameDialog
            name={dialog.title}
            maxLength={PAGE_TITLE_MAX}
            onClose={() => setDialog(null)}
            onRename={async (next) => {
              try {
                await directory.renamePage(SERVER_ID, dialog.workspace, dialog.page, next);
                return null;
              } catch (error) {
                return t.tree.renameFailed(error instanceof Error ? error.message : String(error));
              }
            }}
          />
        )}
      </div>
    </PageHostContext.Provider>
    </FavoritesContext>
    </HintContext>
  );
}
