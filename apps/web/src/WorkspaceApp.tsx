import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { hasCapability, type Capabilities } from "@thoth/workspace-protocol";
import { TabBar, TabPanel, type TabItem } from "@thoth/app-ui/tabs/TabBar.tsx";
import { remoteGone, remoteTitle } from "@thoth/app-ui/tabs/remote.ts";
import type { OpenOptions, TabTarget } from "@thoth/app-ui/tabs/model.ts";
import { useTabs } from "@thoth/app-ui/tabs/useTabs.ts";
import { useShortcuts } from "@thoth/app-ui/keyboard/useShortcuts.ts";
import { currentPlatform, shortcutText } from "@thoth/app-ui/keyboard/shortcuts.ts";
import { PageHostContext, type PageHost } from "@thoth/app-ui/editor/host.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { LegalLinks } from "./LegalLinks.tsx";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";
import { Notice } from "@thoth/app-ui/ui/Notice.tsx";
import type { ServerDirectory, WorkspacePageRef } from "@thoth/app-ui/workspace/directory.ts";
import { describeLimits } from "@thoth/app-ui/workspace/limits.ts";
import { WorkspacePage } from "@thoth/app-ui/workspace/WorkspacePage.tsx";
import { WorkspaceSection } from "@thoth/app-ui/workspace/WorkspaceTree.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { TreeList } from "@thoth/app-ui/order/TreeList.tsx";
import { LanguageSwitch } from "./LanguageSwitch.tsx";
import { SearchDialog } from "./SearchDialog.tsx";
import { track } from "./analytics.ts";
import type { WebEnv } from "./env.ts";
import { SERVER_ID } from "./servers.ts";
import { SettingsView } from "./SettingsView.tsx";
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
  const [searching, setSearching] = useState(false);
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
  const pageHost = useMemo<PageHost>(() => ({ autosaveMs: env.autosaveMs, now: () => new Date(env.now()), registerFlush }), [env, registerFlush]);

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

  // The keyboard (ADR-0016 rule 7). Where a browser keeps a key, the web client uses another (see the shortcuts table).
  const platform = useMemo(() => currentPlatform(), []);
  useShortcuts("web", {
    ...(canSearch ? { "palette.open": () => setSearching((s) => !s) } : {}),
    "settings.open": openSettings,
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
    <PageHostContext.Provider value={pageHost}>
      <div className="shell web-shell">
        <aside className="sidebar" aria-label={t.web.sidebar}>
          <div className="ws">
            <Mark size={18} />
            <span className="ws-name">Thoth</span>
          </div>
          {canSearch && (
            <button type="button" className="search-trigger" onClick={() => setSearching(true)} aria-label={t.web.search} aria-keyshortcuts="Control+K Meta+K">
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
            {account && <p className="muted web-who">{t.web.signedInAs(account.displayName)}</p>}
            <div className="side-actions">
              <LanguageSwitch />
              <ThemeSwitch />
              <Button variant="quiet" small disabled={signingOut} onClick={() => void doSignOut()}>
                {signingOut ? t.web.signingOut : t.web.signOut}
              </Button>
            </div>
            <LegalLinks />
          </div>
        </aside>
        <main className="main">
          <TabBar tabs={items} active={tabs.active.id} onActivate={tabs.activate} onClose={tabs.close} onNew={tabs.newTab} newShortcut={shortcutText("tab.new", "web", platform)} />
          {signedOut && (
            <p role="alert" className="alert alert-warning banner">
              {t.web.sessionEnded}{" "}
              <Button variant="quiet" small onClick={signInAgain}>
                {t.web.signInAgain}
              </Button>
            </p>
          )}
          <TabPanel id={tabs.active.id}>
            {shown.kind === "settings" ? (
              <SettingsView account={account} signOut={() => void doSignOut()} signingOut={signingOut} />
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
        {searching && workspaces && <SearchDialog directory={directory} workspaces={workspaces} onOpen={openPage} onClose={() => setSearching(false)} onSearched={() => track({ name: "search" }, target)} />}
      </div>
    </PageHostContext.Provider>
  );
}
