import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSession } from "../../app/context.ts";
import { Button } from "../../ui/Button.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { ServerCard } from "./ServersSettings.tsx";
import { PageFrame } from "../editor/PageView.tsx";
import { workspaceKey, type WorkspacePageRef } from "./directory.ts";
import { workspacePageStore } from "./workspace-store.ts";

/**
 * A page of a workspace on a server, in the same Blocks/Plain editor as a
 * Private Space page. Wikilinks and backlinks are not resolved across a
 * workspace yet (they come from the local index), so links show unresolved and
 * there is no backlinks panel.
 */
export function WorkspacePageView({ target }: { target: WorkspacePageRef }) {
  const { servers, openWorkspacePage, openSettings } = useSession();
  const directory = useSyncExternalStore(servers.subscribe, servers.getState);
  const entry = directory.servers.find((s) => s.info.id === target.server);
  const workspace = entry?.workspaces?.find((w) => w.id === target.workspace);
  const key = workspaceKey(target.server, target.workspace);
  const tree = directory.trees[key];
  const node = tree?.nodes.find((n) => n.id === target.page);
  const signedOut = entry?.info.auth === "signed-out";
  /** Signing in over the open page, so unsaved edits stay where they are. */
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => {
    if (!signedOut) setSigningIn(false);
  }, [signedOut]);

  // Poll this workspace's change feed while its page is open, even if the sidebar collapsed it.
  useEffect(() => {
    if (!signedOut) servers.expand(target.server, target.workspace);
  }, [servers, target.server, target.workspace, signedOut]);

  // Kept once known: a sign-out mid-edit must not unmount the editor and lose what is on screen.
  const known = useRef<{ role: NonNullable<typeof workspace>["role"]; name: string } | null>(null);
  if (workspace) known.current = { role: workspace.role, name: workspace.name };
  const role = known.current?.role;
  const store = useMemo(
    () => (role ? workspacePageStore({ client: servers.client(target.server), workspace: target.workspace, page: target.page, role, onSaved: (page) => servers.notePageSaved(target.server, page) }) : null),
    [servers, target.server, target.workspace, target.page, role],
  );
  const onWritten = useCallback(() => undefined, []);
  const openCopy = useCallback((page: string) => openWorkspacePage({ ...target, page }), [openWorkspacePage, target]);

  if (!entry) {
    return <Notice title="This server was removed" detail="Add it again in Settings to open its pages." />;
  }
  if (signedOut && !store) {
    return (
      <Notice title={`Signed out of ${entry.info.label}`} detail="Sign in again to open this page.">
        <Button variant="primary" small onClick={() => openSettings("servers")}>
          Sign in
        </Button>
      </Notice>
    );
  }
  if (!store || !known.current) {
    return entry.error ? <Notice title="Could not load this workspace" detail={entry.error} /> : <Notice title="Loading…" detail="" />;
  }
  const name = known.current.name;

  const title = node?.title ?? "Page";
  return (
    <>
    <PageFrame
      key={`${key}\n${target.page}`}
      label={title}
      store={store}
      modeKey={{ space: `${entry.info.url}\n${target.workspace}`, page: target.page }}
      crumbs={{ badge: <span className="badge badge-workspace">Workspace · {name}</span>, parts: [title] }}
      checkTick={tree?.ticks[target.page] ?? 0}
      onWritten={onWritten}
      loadLinks={null}
      linkTick={0}
      openLink={() => undefined}
      openCopy={openCopy}
      readOnlyNote={`You are a viewer in ${name}, so this page is read-only.`}
      missing={{ title: "This page is gone", detail: "It was deleted on the server, or you no longer have access to it." }}
      errorAction={
        signedOut ? (
          <Button variant="quiet" small onClick={() => setSigningIn(true)}>
            Sign in
          </Button>
        ) : undefined
      }
    />
    {signingIn && signedOut && (
      <Modal title={`Sign in to ${entry.info.label}`} onClose={() => setSigningIn(false)}>
        <p className="muted">Your edits stay on this page. After signing in, choose Retry to save them.</p>
        <ServerCard info={entry.info} error={null} directory={servers} signInOnly />
      </Modal>
    )}
    </>
  );
}

function Notice({ title, detail, children }: { title: string; detail: string; children?: React.ReactNode }) {
  return (
    <div className="page-scroll">
      <div className="page-col">
        <div className="missing">
          <h1 className="page-title">{title}</h1>
          {detail && <p className="muted">{detail}</p>}
          {children && <div className="set-actions">{children}</div>}
        </div>
      </div>
    </div>
  );
}
