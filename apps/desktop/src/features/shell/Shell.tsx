import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { basename, stripExtension, type PageSummary } from "@thoth/domain";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { PageView } from "../editor/PageView.tsx";
import { SettingsView } from "../settings/SettingsView.tsx";
import { NewPageDialog } from "./NewPageDialog.tsx";
import { SearchPalette } from "./SearchPalette.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { WorkspacePageView } from "../servers/WorkspacePageView.tsx";
import { TransferDialog, type TransferTarget } from "../transfer/TransferDialog.tsx";
import type { TabTarget } from "@thoth/app-ui/tabs/model.ts";
import { TabBar, TabPanel, type TabItem } from "@thoth/app-ui/tabs/TabBar.tsx";
import { remoteGone, remoteTitle } from "@thoth/app-ui/tabs/remote.ts";
import { useShortcuts } from "@thoth/app-ui/keyboard/useShortcuts.ts";
import { currentPlatform, shortcutText } from "@thoth/app-ui/keyboard/shortcuts.ts";
import { buildCommands, type Command, type CommandActions } from "@thoth/app-ui/keyboard/commands.ts";
import { useEditorActions } from "@thoth/app-ui/keyboard/editor-actions.ts";
import { ShortcutsDialog } from "@thoth/app-ui/keyboard/ShortcutsDialog.tsx";
import { requestMoveTo } from "@thoth/app-ui/order/move-to.ts";
import { requestNewFolder } from "@thoth/app-ui/order/new-folder-request.ts";
import { requestReorder } from "@thoth/app-ui/order/reorder-request.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { useTheme } from "@thoth/app-ui/ui/theme.ts";
import { roleCan } from "@thoth/workspace-protocol";
import { desktopTheme } from "../settings/theme.ts";
import { RenamePage, type RenameTarget } from "./RenamePage.tsx";

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
  const { vault, revision, watchError, openPage, openSettings, openWorkspacePage, flushAll, tabs, servers } = useSession();
  const t = useDesktopStrings().shell;
  const strings = useStrings();
  const tt = strings.tabs;
  const [problem, setProblem] = useState<string | null>(null);
  const dismissText = useDesktopStrings().transfer.dismiss;
  const editor = useEditorActions();
  const { theme: themeNow, setTheme, cycle } = useTheme(desktopTheme);
  const [pages, setPages] = useState<PageSummary[] | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const directory = useSyncExternalStore(servers.subscribe, servers.getState);
  const target = tabs.active.target;
  const path = target.kind === "page" ? target.path : null;
  const remote = target.kind === "workspace" ? { server: target.server, workspace: target.workspace, page: target.page } : null;

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

  const toggleSearch = () => setDialog((d) => (d?.kind === "search" ? null : { kind: "search" }));
  const toggleShortcuts = () => setDialog((d) => (d?.kind === "shortcuts" ? null : { kind: "shortcuts" }));
  const platform = useMemo(() => currentPlatform(), []);

  const label = (tab: TabTarget): TabItem["label"] => {
    switch (tab.kind) {
      case "page":
        return pages?.find((p) => p.path === tab.path)?.title ?? stripExtension(basename(tab.path));
      case "workspace":
        return remoteTitle(directory, tab) ?? tt.untitled;
      case "settings":
        return tt.settings;
      case "blank":
        return tt.blank;
    }
  };
  // The workspace page in the current tab, if any: what the workspace commands act on.
  const here = target.kind === "workspace" ? target : null;
  const hereWorkspace = here ? directory.servers.find((s) => s.info.id === here.server)?.workspaces?.find((w) => w.id === here.workspace) : undefined;
  const canWriteHere = hereWorkspace !== undefined && roleCan(hereWorkspace.role, "write");

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
        }
      : {}),
    theme: { current: themeNow, set: setTheme },
    openSettings: () => openSettings(),
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

  useShortcuts("desktop", {
    "palette.open": toggleSearch,
    "shortcuts.open": toggleShortcuts,
    "theme.cycle": cycle,
    "settings.open": () => openSettings(),
    "page.new": () => setDialog({ kind: "new" }),
    "folder.new": () => requestNewFolder(),
    "tab.new": () => tabs.newTab(),
    "tab.close": () => tabs.close(),
    "tab.next": () => tabs.step(1),
    "tab.previous": () => tabs.step(-1),
    "tab.jump": (digit) => digit !== undefined && tabs.jump(digit),
  });

  // Open the first page when nothing is open at start, so the shell is never blank. Once: closing every tab leaves it empty.
  const startedEmpty = useRef(tabs.state.tabs.length === 1 && tabs.active.target.kind === "blank");
  useEffect(() => {
    if (!startedEmpty.current || !pages || pages.length === 0) return;
    startedEmpty.current = false;
    openPage(pages[0]!.path);
  }, [pages, openPage]);

  // Background tabs whose page is gone (moved out, deleted, renamed) close; the current tab says "not found" itself.
  const { prune } = tabs;
  useEffect(() => {
    if (!pages) return;
    const known = new Set(pages.map((p) => p.path));
    prune((tab) => (tab.kind === "page" ? !known.has(tab.path) : tab.kind === "workspace" ? remoteGone(directory, tab) : false));
  }, [pages, directory, prune]);

  // Titles of background workspace tabs come from their trees, so those trees load.
  const wanted = tabs.state.tabs.flatMap((tab) => (tab.target.kind === "workspace" ? [`${tab.target.server}\n${tab.target.workspace}`] : []));
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

  const items: TabItem[] = tabs.state.tabs.map((tab) => ({ id: tab.id, label: label(tab.target), ...(tab.target.kind === "page" ? { title: tab.target.path } : {}) }));

  // Unsaved edits are written first, so the transfer sends (and hashes) what is on screen.
  const transfer = (target: TransferTarget) => void flushAll().then((ok) => ok && setDialog({ kind: "transfer", target }));

  return (
    <div className="shell">
      <Sidebar pages={pages ?? []} current={path} currentRemote={remote} onSearch={() => setDialog({ kind: "search" })} onNewPage={() => setDialog({ kind: "new" })} onNewFolder={() => requestNewFolder()} onTransfer={transfer} />
      <main className="main">
        <TabBar tabs={items} active={tabs.active.id} onActivate={tabs.activate} onClose={tabs.close} onNew={tabs.newTab} newShortcut={shortcutText("tab.new", "desktop", platform)} />
        {watchError && (
          <p role="alert" className="alert alert-warning banner">
            {t.watchError(watchError)}
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
        <TabPanel id={tabs.active.id}>
          {target.kind === "settings" ? (
            <SettingsView section={target.section ?? "top"} />
          ) : target.kind === "workspace" ? (
            <WorkspacePageView key={`${tabs.active.id}\n${target.server}\n${target.workspace}\n${target.page}`} target={target} onTransfer={transfer} />
          ) : target.kind === "page" ? (
            <PageView key={`${tabs.active.id}\n${target.path}`} path={target.path} />
          ) : (
            <div className="empty">
              <Mark size={40} />
              <h1>{t.nothingOpen}</h1>
              <p className="muted">{t.nothingOpenHint}</p>
            </div>
          )}
        </TabPanel>
      </main>
      {dialog?.kind === "search" && <SearchPalette commands={buildCommands(makeActions(), strings, "desktop", platform)} onRun={runCommand} onClose={() => setDialog(null)} />}
      {dialog?.kind === "new" && <NewPageDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "shortcuts" && <ShortcutsDialog client="desktop" platform={platform} onClose={() => setDialog(null)} />}
      {dialog?.kind === "rename" && <RenamePage target={dialog.target} onClose={() => setDialog(null)} />}
      {dialog?.kind === "transfer" && <TransferDialog target={dialog.target} onClose={() => setDialog(null)} />}
    </div>
  );
}
