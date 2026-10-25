import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PAGE_TITLE_MAX, hasCapability, roleCan, type Capabilities } from "@thoth/workspace-protocol";
import { buildCommands, type Command, type CommandActions } from "@thoth/app-ui/keyboard/commands.ts";
import { useEditorActions } from "@thoth/app-ui/keyboard/editor-actions.ts";
import { ShortcutsDialog } from "@thoth/app-ui/keyboard/ShortcutsDialog.tsx";
import { requestMoveTo } from "@thoth/app-ui/order/move-to.ts";
import { requestReorder } from "@thoth/app-ui/order/reorder-request.ts";
import { RenameDialog } from "@thoth/app-ui/order/RenameDialog.tsx";
import { useTheme } from "@thoth/app-ui/ui/theme.ts";
import { TabBar, TabPanel, type TabItem } from "@thoth/app-ui/tabs/TabBar.tsx";
import { remoteGone, remoteTitle } from "@thoth/app-ui/tabs/remote.ts";
import type { OpenOptions, TabTarget } from "@thoth/app-ui/tabs/model.ts";
import { useTabs } from "@thoth/app-ui/tabs/useTabs.ts";
import { useShortcuts } from "@thoth/app-ui/keyboard/useShortcuts.ts";
import { currentPlatform } from "@thoth/app-ui/keyboard/shortcuts.ts";
import { PageHostContext, type PageHost } from "@thoth/app-ui/editor/host.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
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
import { loadSidebarWidth, saveSidebarWidth } from "./sidebar-store.ts";
import { clearTabs, loadTabs, saveTabs } from "./tabs-store.ts";

interface Props {
  env: WebEnv;
  directory: ServerDirectory;
  capabilities: Capabilities;
  account: { displayName: string } | null;
  signOut(): Promise<void>;
  signInAgain(): void;
}

/** Signed in: workspaces and their page trees on the left, the open page on the right. */
export function WorkspaceApp({ env, directory, capabilities, account, signOut, signInAgain }: Props) {
  const t = useStrings();
  const state = useSyncExternalStore(directory.subscribe, directory.getState);
  const entry = state.servers.find((s) => s.info.id === SERVER_ID);
  const workspaces = entry?.workspaces ?? null;
  type Dialog = { kind: "search" } | { kind: "shortcuts" } | { kind: "rename"; page: string; workspace: string; title: string } | null;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const signedOut = entry?.info.auth === "signed-out";
  const canSearch = hasCapability(capabilities, "search");
  const limits = capabilities.limits ? describeLimits(capabilities.limits as Record<string, number>, t.limits) : [];
  const target = env.analyticsTarget;

  // Leaving a page writes its pending edits first; a conflict or an error keeps the user on it.
  const flushers = useRef(new Set<() => Promise<boolean>>());
  const registerFlush = useCallback((flush: () => Promise<boolean>) => {
    flushers.current.add(flush);
    return () => void flushers.current.delete(flush);
  }, []);
  const flushAll = useCallback(async () => (await Promise.all([...flushers.current].map((f) => f().catch(() => false)))).every(Boolean), []);
  const pageHost = useMemo<PageHost>(() => ({ client: "web", autosaveMs: env.autosaveMs, now: () => new Date(env.now()), registerFlush }), [env, registerFlush]);

  // Tabs: restored per browser (ids only, no titles), saved on every change. Leaving the page on screen writes its edits first.
  const tabs = useTabs({ initial: () => loadTabs(env.localStorage), flush: flushAll, save: (state) => saveTabs(env.localStorage, state) });
  const shown = tabs.active.target;
  const current: WorkspacePageRef | null = shown.kind === "workspace" ? { server: shown.server, workspace: shown.workspace, page: shown.page } : null;
  const openPage = useCallback((ref: WorkspacePageRef, options?: OpenOptions) => tabs.open({ kind: "workspace", ...ref }, options), [tabs]);
  const openSettings = useCallback(() => tabs.open({ kind: "settings" }), [tabs]);

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
        }
      : {}),
    theme: { current: theme, set: setTheme },
    openSettings,
    tabs: {
      newTab: tabs.newTab,
      closeTab: () => tabs.close(),
      next: () => tabs.step(1),
      previous: () => tabs.step(-1),
      list: tabs.state.tabs.map((tab) => ({ id: tab.id, label: label(tab.target) })),
      active: tabs.active.id,
      goTo: tabs.activate,
    },
    ...(editor ? { toggleMode: editor.toggleMode } : {}),
    showShortcuts: () => setDialog({ kind: "shortcuts" }),
    ...(editor?.canFormat() ? { format: (command) => void editor.format(command) } : {}),
  });

  useShortcuts("web", {
    "palette.open": toggleSearch,
    "shortcuts.open": toggleShortcuts,
    "theme.cycle": cycle,
    "settings.open": openSettings,
    ...(home ? { "page.new": newPage, "folder.new": newFolder } : {}),
    "tab.new": tabs.newTab,
    "tab.close": () => tabs.close(),
    "tab.next": () => tabs.step(1),
    "tab.previous": () => tabs.step(-1),
    "tab.jump": (digit) => digit !== undefined && tabs.jump(digit),
  });

  // Background tabs whose page is gone close; the current tab says "not found" itself.
  const { prune } = tabs;
  useEffect(() => {
    prune((tab) => tab.kind === "workspace" && remoteGone(state, tab));
  }, [state, prune]);

  // The titles of background tabs come from their workspace trees, so those trees load.
  const wanted = [...new Set(tabs.state.tabs.flatMap((tab) => (tab.target.kind === "workspace" ? [tab.target.workspace] : [])))].join("\u0000");
  useEffect(() => {
    if (signedOut || !workspaces) return;
    for (const id of wanted ? wanted.split("\u0000") : []) if (workspaces.some((w) => w.id === id)) directory.expand(SERVER_ID, id);
  }, [directory, wanted, workspaces, signedOut]);

  const items: TabItem[] = tabs.state.tabs.map((tab) => ({ id: tab.id, label: label(tab.target) }));

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
    <PageHostContext.Provider value={pageHost}>
      <div className="shell web-shell" ref={shell} style={sidebar.style}>
        <aside className="sidebar" aria-label={t.web.sidebar}>
          <div className="ws">
            <Mark size={18} />
            <span className="ws-name">Thoth</span>
          </div>
          {canSearch && (
            <button type="button" className="search-trigger" onClick={() => setDialog({ kind: "search" })} aria-label={t.web.search} aria-keyshortcuts="Control+K Meta+K">
              <span>{t.web.search}</span>
              <kbd aria-hidden="true">⌘K</kbd>
            </button>
          )}
          <nav aria-label={t.web.pages} className="tree-wrap">
            <div className="sec">
              <span className="sec-name">{t.web.workspaces}</span>
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
                    onPageCreated={() => track({ name: "page_create" }, target)}
                  />
                ))}
              </TreeList>
            )}
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
              <IconButton icon="sign-out" label={signingOut ? t.web.signingOut : t.web.signOut} disabled={signingOut} onClick={() => void doSignOut()} />
            </div>
            <LegalLinks />
          </div>
        </aside>
        <main className="main">
          <TabBar tabs={items} active={tabs.active.id} onActivate={tabs.activate} onClose={tabs.close} onNew={tabs.newTab} />
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
          <TabPanel id={tabs.active.id}>
            {shown.kind === "settings" ? (
              <SettingsView account={account} signOut={() => void doSignOut()} signingOut={signingOut} showShortcuts={() => setDialog({ kind: "shortcuts" })} />
            ) : current ? (
              <WorkspacePage
                key={`${tabs.active.id}\n${current.workspace}\n${current.page}`}
                directory={directory}
                target={current}
                modeSpace={env.server}
                openPage={openPage}
                goneNotice={<Notice title={t.workspace.missingTitle} detail={t.workspace.missingDetail} />}
                signedOutNotice={<Notice title={t.web.signInAgain} detail={t.web.sessionEnded} />}
                onOpened={() => track({ name: "page_open" }, target)}
                onSaved={() => track({ name: "page_save" }, target)}
                onConflict={(event) => track(event.kind === "shown" ? { name: "conflict_shown" } : { name: "conflict_resolved", params: { choice: event.choice } }, target)}
              />
            ) : (
              <div className="empty">
                <Mark size={40} />
                <h1>{t.web.nothingOpen}</h1>
                <p className="muted">{t.web.nothingOpenHint}</p>
              </div>
            )}
          </TabPanel>
        </main>
        <SidebarResizer sidebar={sidebar} shell={shell} />
        <TooltipLayer />
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
        {dialog?.kind === "shortcuts" && <ShortcutsDialog client="web" platform={platform} onClose={() => setDialog(null)} />}
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
    </HintContext>
  );
}
