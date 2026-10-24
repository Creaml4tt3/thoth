import { useSyncExternalStore } from "react";
import type { WorkspacePageRef } from "@thoth/app-ui/workspace/directory.ts";
import { WorkspaceSection } from "@thoth/app-ui/workspace/WorkspaceTree.tsx";
import { TreeList } from "@thoth/app-ui/order/TreeList.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";

interface Props {
  current: WorkspacePageRef | null;
}

/** One section per known server, under the Private Space: its workspaces when signed in, a Sign in link when not. */
export function ServersSidebar({ current }: Props) {
  const { servers, openSettings, openWorkspacePage, flushAll } = useSession();
  const t = useDesktopStrings().servers;
  const state = useSyncExternalStore(servers.subscribe, servers.getState);
  if (state.servers.length === 0) return null;
  return (
    <>
      {state.servers.map((entry) => (
        <section key={entry.info.id} className="server-section" aria-label={t.serverSection(entry.info.label)}>
          <div className="sec">
            <span className="sec-name" title={entry.info.url}>
              {entry.info.label}
            </span>
            {entry.info.auth === "signed-out" ? (
              <button type="button" className="sec-link" onClick={() => openSettings("servers")}>
                {t.signIn}
              </button>
            ) : null}
          </div>
          {entry.info.auth !== "signed-out" &&
            (entry.error ? (
              <p className="muted tree-empty">{entry.error}</p>
            ) : entry.workspaces === null ? (
              <p className="muted tree-empty">{t.loading}</p>
            ) : entry.workspaces.length === 0 ? (
              <p className="muted tree-empty">{t.noWorkspaces}</p>
            ) : (
              <TreeList label={t.workspacesOn(entry.info.label)}>
                {entry.workspaces.map((workspace) => (
                  <WorkspaceSection key={workspace.id} directory={servers} server={entry.info.id} serverLabel={entry.info.label} workspace={workspace} current={current} openPage={openWorkspacePage} flush={flushAll} />
                ))}
              </TreeList>
            ))}
        </section>
      ))}
    </>
  );
}
