import { useEffect, useMemo, useState } from "react";
import type { PageSummary } from "@thoth/domain";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";
import { useSession } from "../../app/context.ts";
import { ancestorFolders, buildTree, type TreeNode } from "./tree.ts";
import { ServersSidebar } from "../servers/ServersSidebar.tsx";
import type { WorkspacePageRef } from "@thoth/app-ui/workspace/directory.ts";

interface Props {
  pages: PageSummary[];
  current: string | null;
  /** The open workspace page, if any. */
  currentRemote?: WorkspacePageRef | null;
  onSearch(): void;
  onNewPage(): void;
}

function Node({ node, depth, open, toggle, current }: { node: TreeNode; depth: number; open: Set<string>; toggle(path: string): void; current: string | null }) {
  const { openPage } = useSession();
  const indent = { paddingLeft: 8 + depth * 14 };
  if (node.kind === "page") {
    return (
      <li role="none">
        <button type="button" role="treeitem" aria-selected={node.path === current} aria-current={node.path === current ? "page" : undefined} className="tree-item" style={indent} onClick={() => openPage(node.path)} title={node.path}>
          <span className="tree-label">{node.title}</span>
        </button>
      </li>
    );
  }
  const expanded = open.has(node.path);
  return (
    <li role="none">
      <button type="button" role="treeitem" aria-expanded={expanded} className="tree-item tree-folder" style={indent} onClick={() => toggle(node.path)}>
        <span className="tree-caret" aria-hidden="true">
          {expanded ? "⌄" : "›"}
        </span>
        <span className="tree-label">{node.name}</span>
      </button>
      {expanded && (
        <ul role="group">
          {node.children.map((child) => (
            <Node key={`${child.kind}:${child.path}`} node={child} depth={depth + 1} open={open} toggle={toggle} current={current} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** 260px page tree grouped by folder, with the Local space badge, search and new-page actions; workspace servers below it. */
export function Sidebar({ pages, current, currentRemote = null, onSearch, onNewPage }: Props) {
  const { connection, reveal, openSettings } = useSession();
  const tree = useMemo(() => buildTree(pages), [pages]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  // Keep the open page visible, and honour "reveal this folder" requests (e.g. after an import).
  useEffect(() => {
    if (!current) return;
    setOpen((prev) => {
      const next = new Set(prev);
      for (const folder of ancestorFolders(current)) next.add(folder);
      return next.size === prev.size ? prev : next;
    });
  }, [current]);
  useEffect(() => {
    if (!reveal) return;
    setOpen((prev) => new Set([...prev, ...ancestorFolders(`${reveal.path}/x`)]));
  }, [reveal]);

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="ws">
        <Mark size={18} />
        <span className="ws-name">Thoth</span>
      </div>
      <button type="button" className="search-trigger" onClick={onSearch} aria-label="Search pages" aria-keyshortcuts="Control+K Meta+K">
        <span>Search</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="sec">
        <span className="sec-name" title={connection.root}>
          {connection.label}
        </span>
        <span className="badge badge-private">Local</span>
      </div>
      <nav aria-label="Pages" className="tree-wrap">
        {tree.length === 0 ? (
          <p className="muted tree-empty">No pages yet.</p>
        ) : (
          <ul role="tree" aria-label="Pages in this Private Space">
            {tree.map((node) => (
              <Node key={`${node.kind}:${node.path}`} node={node} depth={0} open={open} toggle={toggle} current={current} />
            ))}
          </ul>
        )}
        <ServersSidebar current={currentRemote} />
      </nav>
      <div className="side-actions">
        <Button variant="ghost" small onClick={onNewPage}>
          New page
        </Button>
        <Button variant="quiet" small onClick={() => openSettings()}>
          Settings
        </Button>
      </div>
    </aside>
  );
}
