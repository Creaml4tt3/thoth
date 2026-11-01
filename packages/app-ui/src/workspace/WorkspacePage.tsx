import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { Role } from "@thoth/workspace-protocol";
import { PageFrame, type PageFrameProps } from "../editor/PageFrame.tsx";
import { useStrings } from "../strings/index.ts";
import { Notice } from "../ui/Notice.tsx";
import { presenceKey, workspaceKey, type ServerDirectory, type WorkspacePageRef } from "./directory.ts";
import { workspacePageStore } from "./workspace-store.ts";
import { workspacePageMedia } from "./workspace-media.ts";

export interface WorkspacePageProps {
  directory: ServerDirectory;
  target: WorkspacePageRef;
  /** Remembers the editor mode per server: usually the server's address. */
  modeSpace: string;
  openPage(ref: WorkspacePageRef): void;
  /** Shown instead of the page when the server is signed out before the page ever loaded. */
  signedOutNotice: ReactNode;
  /** Shown under a save error while signed out (for example a Sign in button). */
  signedOutAction?: ReactNode;
  /** Shown when the server is not known at all (removed). */
  goneNotice: ReactNode;
  onConflict?: PageFrameProps["onConflict"];
  onSaved?: PageFrameProps["onSaved"];
  /** Once per page, when it loads. */
  onOpened?(): void;
  /** Extra controls in the breadcrumb bar. */
  actions?: ReactNode;
}

/**
 * A page of a workspace on a server, in the same Blocks/Plain editor as a
 * Private Space page. Wikilinks and backlinks are not resolved across a
 * workspace yet (they come from the local index), so links show unresolved and
 * there is no backlinks panel.
 */
export function WorkspacePage({ directory, target, modeSpace, openPage, signedOutNotice, signedOutAction, goneNotice, onConflict, onSaved, onOpened, actions }: WorkspacePageProps) {
  const t = useStrings().workspace;
  const state = useSyncExternalStore(directory.subscribe, directory.getState);
  const entry = state.servers.find((s) => s.info.id === target.server);
  const workspace = entry?.workspaces?.find((w) => w.id === target.workspace);
  const key = workspaceKey(target.server, target.workspace);
  const tree = state.trees[key];
  const node = tree?.nodes.find((n) => n.id === target.page);
  const signedOut = entry?.info.auth === "signed-out";

  // Poll this workspace's change feed while its page is open, even if the sidebar collapsed it.
  useEffect(() => {
    if (!signedOut) directory.expand(target.server, target.workspace);
  }, [directory, target.server, target.workspace, signedOut]);

  // ADR-0041: while the page is shown, the server hears that it is open (presence) and its changes stream in where possible.
  useEffect(() => directory.openPage({ server: target.server, workspace: target.workspace, page: target.page }), [directory, target.server, target.workspace, target.page]);
  const here = state.presence[presenceKey(target)] ?? [];
  const me = entry?.info.account?.id;
  const changeNotice = useMemo(
    // A change by this account (another window, a rename from the sidebar) is not news: no notice.
    () => ({ text: (by: string | null) => (by !== null && by === me ? null : t.changedBy(by === null ? null : directory.memberName(target.server, target.workspace, by))), dismiss: t.dismissChange }),
    [t, directory, target.server, target.workspace, me],
  );

  // Kept once known: a sign-out mid-edit must not unmount the editor and lose what is on screen.
  const known = useRef<{ role: Role; name: string } | null>(null);
  if (workspace) known.current = { role: workspace.role, name: workspace.name };
  const role = known.current?.role;
  const store = useMemo(
    () => (role ? workspacePageStore({ client: directory.client(target.server), workspace: target.workspace, page: target.page, role, onSaved: (page) => directory.notePageSaved(target.server, page) }) : null),
    [directory, target.server, target.workspace, target.page, role],
  );
  // Images (ADR-0028): attachments through the authorised download; editors upload new ones.
  const media = useMemo(() => workspacePageMedia(directory.client(target.server), target.workspace, { canWrite: role !== undefined && role !== "viewer" }), [directory, target.server, target.workspace, role]);
  const onWritten = useCallback(() => undefined, []);
  const openCopy = useCallback((page: string) => openPage({ ...target, page }), [openPage, target]);

  const opened = useRef(onOpened);
  opened.current = onOpened;
  const ready = store !== null;
  useEffect(() => {
    if (ready) opened.current?.();
  }, [ready, target.page]);

  if (!entry) return <>{goneNotice}</>;
  if (signedOut && !store) return <>{signedOutNotice}</>;
  // ADR-0024: signed in, the list loaded, and this workspace is not in it: the user left or was removed.
  if (!signedOut && entry.workspaces !== null && !workspace) return <Notice title={t.noAccessTitle} detail={t.noAccessDetail} />;
  if (!store || !known.current) {
    return entry.error ? <Notice title={t.couldNotLoad} detail={entry.error} /> : <Notice title={t.loading} detail="" />;
  }
  const name = known.current.name;
  const title = node?.title ?? t.pageFallback;
  return (
    <PageFrame
      key={`${key}\n${target.page}`}
      label={title}
      store={store}
      media={media}
      modeKey={{ space: `${modeSpace}\n${target.workspace}`, page: target.page }}
      crumbs={{ badge: <span className="badge badge-workspace">{t.badge(name)}</span>, parts: [title] }}
      checkTick={tree?.ticks[target.page] ?? 0}
      onWritten={onWritten}
      loadLinks={null}
      linkTick={0}
      openLink={() => undefined}
      openCopy={openCopy}
      readOnlyNote={t.readOnly(name)}
      missing={{ title: t.missingTitle, detail: t.missingDetail }}
      errorAction={signedOut ? signedOutAction : undefined}
      actions={
        <>
          {here.length > 0 && (
            <span className="presence" role="status" aria-label={t.presenceLabel}>
              <span className="presence-faces" aria-hidden="true">
                {here.slice(0, 3).map((p) => (
                  <span key={p.userId} className="presence-face" title={p.displayName}>
                    {[...p.displayName.trim()][0]?.toUpperCase() ?? "?"}
                  </span>
                ))}
              </span>
              <span className="presence-text">{t.presence(here.map((p) => p.displayName))}</span>
            </span>
          )}
          {actions}
        </>
      }
      changeNotice={changeNotice}
      {...(onConflict ? { onConflict } : {})}
      {...(onSaved ? { onSaved } : {})}
    />
  );
}
