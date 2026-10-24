import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { PageSummary } from "@thoth/domain";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { ancestorFolders, buildTree, type TreeNode } from "./tree.ts";
import { ServersSidebar } from "../servers/ServersSidebar.tsx";
import { pendingCleanups } from "../transfer/service.ts";
import type { WorkspacePageRef } from "@thoth/app-ui/workspace/directory.ts";
import type { TransferTarget } from "../transfer/TransferDialog.tsx";

interface Props {
  pages: PageSummary[];
  current: string | null;
  /** The open workspace page, if any. */
  currentRemote?: WorkspacePageRef | null;
  onSearch(): void;
  onNewPage(): void;
  /** Opens the copy/move dialog for the selected pages. */
  onTransfer(target: TransferTarget): void;
}

interface Selection {
  active: boolean;
  paths: ReadonlySet<string>;
  toggle(path: string): void;
}

function Node({ node, depth, open, toggle, current, selection }: { node: TreeNode; depth: number; open: Set<string>; toggle(path: string): void; current: string | null; selection: Selection }) {
  const { openPage } = useSession();
  const t = useDesktopStrings().transfer;
  const indent = { paddingLeft: 8 + depth * 14 };
  if (node.kind === "page") {
    const checked = selection.paths.has(node.path);
    if (selection.active) {
      // While selecting, the row is a checkbox: Space toggles it, the tree keeps its keyboard order.
      return (
        <li role="none">
          <label className="tree-item" style={indent} title={node.path}>
            <input type="checkbox" className="tree-select" checked={checked} onChange={() => selection.toggle(node.path)} aria-label={t.selectPage(node.title)} />
            <span className="tree-label">{node.title}</span>
          </label>
        </li>
      );
    }
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
            <Node key={`${child.kind}:${child.path}`} node={child} depth={depth + 1} open={open} toggle={toggle} current={current} selection={selection} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Moves whose originals were kept: the result stays visible until dismissed (ADR-0006: never reported as finished). */
function PendingTransfers() {
  const { transfers, openPage } = useSession();
  const t = useDesktopStrings().transfer;
  const state = useSyncExternalStore(transfers.subscribe, transfers.getState);
  const pending = pendingCleanups(state);
  if (pending.length === 0) return null;
  return (
    <section className="xfer-pending" aria-label={t.pendingList}>
      <b>{t.pendingList}</b>
      <ul>
        {pending.map((r) => {
          const kept = r.items.filter((i) => i.state === "cleanup_pending");
          const first = kept[0];
          return (
            <li key={r.id}>
              {r.direction === "to_workspace" && first ? (
                <button type="button" className="sec-link" onClick={() => openPage(first.sourcePath)}>
                  {t.pendingItem(kept.length, r.workspace.name)}
                </button>
              ) : (
                <span>{t.pendingItem(kept.length, r.workspace.name)}</span>
              )}
              <button type="button" className="sec-link" onClick={() => void transfers.dismiss(r.id)}>
                {t.dismiss}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 260px page tree grouped by folder, with the Local space badge, search and new-page actions; workspace servers below it. */
export function Sidebar({ pages, current, currentRemote = null, onSearch, onNewPage, onTransfer }: Props) {
  const { connection, reveal, openSettings } = useSession();
  const t = useDesktopStrings().shell;
  const tt = useDesktopStrings().transfer;
  const tree = useMemo(() => buildTree(pages), [pages]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

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
  // Pages that disappear (moved, deleted) leave the selection.
  useEffect(() => {
    setPicked((prev) => {
      const known = new Set(pages.map((p) => p.path));
      const next = new Set([...prev].filter((p) => known.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [pages]);

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const selection: Selection = {
    active: selecting,
    paths: picked,
    toggle: (path) =>
      setPicked((prev) => {
        const next = new Set(prev);
        if (!next.delete(path)) next.add(path);
        return next;
      }),
  };
  const startSelecting = () => {
    setPicked(new Set(current ? [current] : []));
    setSelecting(true);
  };
  const transfer = (mode: "copy" | "move") => {
    const paths = [...picked].sort();
    setSelecting(false);
    setPicked(new Set());
    onTransfer({ direction: "to_workspace", paths, mode });
  };

  return (
    <aside className="sidebar" aria-label={t.sidebar}>
      <div className="ws">
        <Mark size={18} />
        <span className="ws-name">Thoth</span>
      </div>
      <button type="button" className="search-trigger" onClick={onSearch} aria-label={t.searchPages} aria-keyshortcuts="Control+K Meta+K">
        <span>{t.search}</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="sec">
        <span className="sec-name" title={connection.root}>
          {connection.label}
        </span>
        <span className="sec-actions">
          {pages.length > 0 && (
            <button type="button" className="sec-link" aria-pressed={selecting} onClick={() => (selecting ? setSelecting(false) : startSelecting())}>
              {selecting ? tt.selectDone : tt.select}
            </button>
          )}
          <span className="badge badge-private">{t.local}</span>
        </span>
      </div>
      {selecting && (
        <div className="select-bar" role="region" aria-label={tt.select}>
          <span aria-live="polite">{tt.selected(picked.size)}</span>
          <div className="set-actions">
            <Button variant="primary" small disabled={picked.size === 0} onClick={() => transfer("copy")}>
              {tt.copyTo}
            </Button>
            <Button variant="ghost" small disabled={picked.size === 0} onClick={() => transfer("move")}>
              {tt.moveTo}
            </Button>
          </div>
        </div>
      )}
      <nav aria-label={t.pages} className="tree-wrap">
        {tree.length === 0 ? (
          <p className="muted tree-empty">{t.noPages}</p>
        ) : (
          <ul role="tree" aria-label={t.pagesInSpace} aria-multiselectable={selecting || undefined}>
            {tree.map((node) => (
              <Node key={`${node.kind}:${node.path}`} node={node} depth={0} open={open} toggle={toggle} current={current} selection={selection} />
            ))}
          </ul>
        )}
        <ServersSidebar current={currentRemote} />
      </nav>
      <PendingTransfers />
      <div className="side-actions">
        <Button variant="ghost" small onClick={onNewPage}>
          {t.newPage}
        </Button>
        <Button variant="quiet" small onClick={() => openSettings()}>
          {t.settings}
        </Button>
      </div>
    </aside>
  );
}
