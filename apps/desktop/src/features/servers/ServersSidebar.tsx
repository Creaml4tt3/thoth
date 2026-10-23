import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Workspace } from "@thoth/workspace-protocol";
import { useSession } from "../../app/context.ts";
import { workspaceKey, type ServerEntry, type WorkspacePageRef } from "./directory.ts";
import { nestWorkspaceTree, workspaceAncestors, type WorkspaceTreeItem } from "./tree.ts";

interface Props {
  current: WorkspacePageRef | null;
}

/** A page; opening a page that has sub-pages also shows them (keyboard users need no separate caret). */
function PageItem({ item, depth, server, workspace, current, open, toggle }: { item: WorkspaceTreeItem; depth: number; server: string; workspace: string; current: WorkspacePageRef | null; open: Set<string>; toggle(id: string, force?: boolean): void }) {
  const { openWorkspacePage } = useSession();
  const selected = current?.server === server && current.workspace === workspace && current.page === item.id;
  const expanded = open.has(item.id);
  const indent = { paddingLeft: 8 + depth * 14 };
  return (
    <li role="none">
      <button
          type="button"
          role="treeitem"
          aria-selected={selected}
          aria-current={selected ? "page" : undefined}
          {...(item.children.length > 0 ? { "aria-expanded": expanded } : {})}
          className="tree-item"
          style={indent}
          onClick={() => {
            if (item.children.length > 0) toggle(item.id, true);
            openWorkspacePage({ server, workspace, page: item.id });
          }}
        >
          {item.children.length > 0 ? (
            <span
              className="tree-caret"
              aria-hidden="true"
              onClick={(event) => {
                event.stopPropagation();
                toggle(item.id);
              }}
            >
              {expanded ? "⌄" : "›"}
            </span>
          ) : (
            <span className="tree-caret" aria-hidden="true" />
          )}
          <span className="tree-label">{item.title}</span>
        </button>
      {expanded && item.children.length > 0 && (
        <ul role="group">
          {item.children.map((child) => (
            <PageItem key={child.id} item={child} depth={depth + 1} server={server} workspace={workspace} current={current} open={open} toggle={toggle} />
          ))}
        </ul>
      )}
    </li>
  );
}

function WorkspaceSection({ entry, workspace, current }: { entry: ServerEntry; workspace: Workspace; current: WorkspacePageRef | null }) {
  const { servers } = useSession();
  const state = useSyncExternalStore(servers.subscribe, servers.getState);
  const key = workspaceKey(entry.info.id, workspace.id);
  const expanded = state.expanded.includes(key);
  const tree = state.trees[key];
  const items = useMemo(() => nestWorkspaceTree(tree?.nodes ?? []), [tree?.nodes]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const here = current?.server === entry.info.id && current.workspace === workspace.id ? current.page : null;

  // Keep the open page visible.
  useEffect(() => {
    if (!here || !tree) return;
    const up = workspaceAncestors(tree.nodes, here);
    if (up.length === 0) return;
    setOpen((prev) => (up.every((id) => prev.has(id)) ? prev : new Set([...prev, ...up])));
  }, [here, tree]);

  const toggle = (id: string, force?: boolean) =>
    setOpen((prev) => {
      if (force && prev.has(id)) return prev;
      const next = new Set(prev);
      if (force || !next.delete(id)) next.add(id);
      return next;
    });

  return (
    <li role="none">
      <button
        type="button"
        role="treeitem"
        aria-expanded={expanded}
        className="tree-item tree-folder"
        onClick={() => (expanded ? servers.collapse(entry.info.id, workspace.id) : servers.expand(entry.info.id, workspace.id))}
        title={`${workspace.name} on ${entry.info.label}`}
      >
        <span className="tree-caret" aria-hidden="true">
          {expanded ? "⌄" : "›"}
        </span>
        <span className="tree-label">{workspace.name}</span>
        <span className="badge badge-workspace tree-badge">Workspace</span>
      </button>
      {expanded && (
        <ul role="group" aria-label={`Pages in ${workspace.name}`}>
          {tree?.error ? (
            <li role="none" className="tree-note muted">
              {tree.error}
            </li>
          ) : tree?.loading && tree.nodes.length === 0 ? (
            <li role="none" className="tree-note muted">
              Loading…
            </li>
          ) : items.length === 0 ? (
            <li role="none" className="tree-note muted">
              No pages yet.
            </li>
          ) : (
            items.map((item) => <PageItem key={item.id} item={item} depth={1} server={entry.info.id} workspace={workspace.id} current={current} open={open} toggle={toggle} />)
          )}
        </ul>
      )}
    </li>
  );
}

/** One section per known server, under the Private Space: its workspaces when signed in, a Sign in link when not. */
export function ServersSidebar({ current }: Props) {
  const { servers, openSettings } = useSession();
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
                  <WorkspaceSection key={workspace.id} entry={entry} workspace={workspace} current={current} />
                ))}
              </ul>
            ))}
        </section>
      ))}
    </>
  );
}
