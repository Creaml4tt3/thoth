import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { roleCan, type Workspace } from "@thoth/workspace-protocol";
import { useStrings } from "../strings/index.ts";
import { workspaceKey, type ServerDirectory, type WorkspacePageRef } from "./directory.ts";
import { nestWorkspaceTree, workspaceAncestors, type WorkspaceTreeItem } from "./tree.ts";

interface PageItemProps {
  item: WorkspaceTreeItem;
  depth: number;
  server: string;
  workspace: string;
  current: WorkspacePageRef | null;
  open: Set<string>;
  toggle(id: string, force?: boolean): void;
  openPage(ref: WorkspacePageRef): void;
}

/** A page; opening a page that has sub-pages also shows them (keyboard users need no separate caret). */
function PageItem({ item, depth, server, workspace, current, open, toggle, openPage }: PageItemProps) {
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
            openPage({ server, workspace, page: item.id });
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
            <PageItem key={child.id} item={child} depth={depth + 1} server={server} workspace={workspace} current={current} open={open} toggle={toggle} openPage={openPage} />
          ))}
        </ul>
      )}
    </li>
  );
}

export interface WorkspaceSectionProps {
  directory: ServerDirectory;
  server: string;
  serverLabel: string;
  workspace: Workspace;
  current: WorkspacePageRef | null;
  openPage(ref: WorkspacePageRef): void;
  /** After New page created a page (before it opens). */
  onPageCreated?(): void;
}

/**
 * One workspace in a sidebar tree: expands to its pages (polling its change feed while expanded) and, for
 * editors and owners, offers New page. Shared by the desktop sidebar and the web client.
 */
export function WorkspaceSection({ directory, server, serverLabel, workspace, current, openPage, onPageCreated }: WorkspaceSectionProps) {
  const t = useStrings().workspace;
  const state = useSyncExternalStore(directory.subscribe, directory.getState);
  const key = workspaceKey(server, workspace.id);
  const expanded = state.expanded.includes(key);
  const tree = state.trees[key];
  const items = useMemo(() => nestWorkspaceTree(tree?.nodes ?? []), [tree?.nodes]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const here = current?.server === server && current.workspace === workspace.id ? current.page : null;
  const canWrite = roleCan(workspace.role, "write");

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

  const newPage = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const page = await directory.createPage(server, workspace.id, t.newPageTitle);
      directory.expand(server, workspace.id);
      onPageCreated?.();
      openPage({ server, workspace: workspace.id, page: page.id });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  return (
    <li role="none">
      <div className="tree-row">
        <button
          type="button"
          role="treeitem"
          aria-expanded={expanded}
          className="tree-item tree-folder"
          onClick={() => (expanded ? directory.collapse(server, workspace.id) : directory.expand(server, workspace.id))}
          title={t.onServer(workspace.name, serverLabel)}
        >
          <span className="tree-caret" aria-hidden="true">
            {expanded ? "⌄" : "›"}
          </span>
          <span className="tree-label">{workspace.name}</span>
          <span className="badge badge-workspace tree-badge">{t.badgeShort}</span>
        </button>
        {canWrite && (
          <button type="button" className="tree-add" aria-label={t.newPageIn(workspace.name)} title={creating ? t.creating : t.newPage} disabled={creating} onClick={() => void newPage()}>
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      {createError && (
        <p role="alert" className="tree-note tree-error">
          {createError}
        </p>
      )}
      {expanded && (
        <ul role="group" aria-label={t.pagesIn(workspace.name)}>
          {tree?.error ? (
            <li role="none" className="tree-note muted">
              {tree.error}
            </li>
          ) : tree?.loading && tree.nodes.length === 0 ? (
            <li role="none" className="tree-note muted">
              {t.loading}
            </li>
          ) : items.length === 0 ? (
            <li role="none" className="tree-note muted">
              {t.noPages}
            </li>
          ) : (
            items.map((item) => <PageItem key={item.id} item={item} depth={1} server={server} workspace={workspace.id} current={current} open={open} toggle={toggle} openPage={openPage} />)
          )}
        </ul>
      )}
    </li>
  );
}
