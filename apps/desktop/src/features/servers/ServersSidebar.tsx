import { useSyncExternalStore } from "react";
import type { WorkspacePageRef } from "@thoth/app-ui/workspace/directory.ts";
import { WorkspaceSection } from "@thoth/app-ui/workspace/WorkspaceTree.tsx";
import { useSession } from "../../app/context.ts";

interface Props {
  current: WorkspacePageRef | null;
}

/** One section per known server, under the Private Space: its workspaces when signed in, a Sign in link when not. */
export function ServersSidebar({ current }: Props) {
  const { servers, openSettings, openWorkspacePage } = useSession();
  const state = useSyncExternalStore(servers.subscribe, servers.getState);
  if (state.servers.length === 0) return null;
  return (
    <>
      {state.servers.map((entry) => (
        <section key={entry.info.id} className="server-section" aria-label={`Server ${entry.info.label}`}>
          <div className="sec">
            <span className="sec-name" title={entry.info.url}>
              {entry.info.label}
            </span>
            {entry.info.auth === "signed-out" ? (
              <button type="button" className="sec-link" onClick={() => openSettings("servers")}>
                Sign in
              </button>
            ) : null}
          </div>
          {entry.info.auth !== "signed-out" &&
            (entry.error ? (
              <p className="muted tree-empty">{entry.error}</p>
            ) : entry.workspaces === null ? (
              <p className="muted tree-empty">Loading…</p>
            ) : entry.workspaces.length === 0 ? (
              <p className="muted tree-empty">No workspaces yet.</p>
            ) : (
              <ul role="tree" aria-label={`Workspaces on ${entry.info.label}`}>
                {entry.workspaces.map((workspace) => (
                  <WorkspaceSection key={workspace.id} directory={servers} server={entry.info.id} serverLabel={entry.info.label} workspace={workspace} current={current} openPage={openWorkspacePage} />
                ))}
              </ul>
            ))}
        </section>
      ))}
    </>
  );
}
