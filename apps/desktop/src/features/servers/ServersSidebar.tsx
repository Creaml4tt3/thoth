import { useSyncExternalStore } from "react";
import type { WorkspacePageRef } from "@thoth/app-ui/workspace/directory.ts";
import { WorkspaceSection } from "@thoth/app-ui/workspace/WorkspaceTree.tsx";
import { TreeList } from "@thoth/app-ui/order/TreeList.tsx";
import { ServerWorkspaceActions, ServerWorkspacesFooter } from "@thoth/app-ui/workspace/ServerWorkspaces.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { serverSection } from "../shell/sections.ts";
import type { SidebarSection } from "../shell/SidebarSections.tsx";

/**
 * One sidebar section per known server (`server:<id>`, placed by `SidebarSections`): its workspaces when signed in, a
 * Sign in link when not. With `workspace-management` (ADR-0025) its header has "New workspace on …", and under the
 * workspaces the count near the limit and "Recently deleted".
 */
export function useServerSections(current: WorkspacePageRef | null): SidebarSection[] {
  const { servers, openSettings, openWorkspacePage, flushAll } = useSession();
  const t = useDesktopStrings().servers;
  const state = useSyncExternalStore(servers.subscribe, servers.getState);
  return state.servers.map((entry) => ({
    id: serverSection(entry.info.id),
    name: entry.info.label,
    label: t.serverSection(entry.info.label),
    title: entry.info.url,
    actions:
      entry.info.auth === "signed-out" ? (
        <button type="button" className="sec-link" onClick={() => openSettings("servers")}>
          {t.signIn}
        </button>
      ) : (
        <ServerWorkspaceActions directory={servers} server={entry.info.id} serverLabel={entry.info.label} />
      ),
    children:
      entry.info.auth === "signed-out" ? null : entry.error ? (
        <p className="muted tree-empty">{entry.error}</p>
      ) : entry.workspaces === null ? (
        <p className="muted tree-empty">{t.loading}</p>
      ) : (
        <>
          {entry.workspaces.length === 0 ? (
            <p className="muted tree-empty">{t.noWorkspaces}</p>
          ) : (
            <TreeList label={t.workspacesOn(entry.info.label)}>
              {entry.workspaces.map((workspace) => (
                <WorkspaceSection key={workspace.id} directory={servers} server={entry.info.id} serverLabel={entry.info.label} workspace={workspace} current={current} openPage={openWorkspacePage} flush={flushAll} spaceDrops />
              ))}
            </TreeList>
          )}
          <ServerWorkspacesFooter directory={servers} server={entry.info.id} />
        </>
      ),
  }));
}
