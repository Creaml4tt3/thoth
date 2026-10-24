import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from "react";
import { PAGE_TITLE_MAX, roleCan, type TreeNode, type Workspace } from "@thoth/workspace-protocol";
import { ContextMenu, type MenuItem } from "../order/ContextMenu.tsx";
import { useTreeDnd, type DropZone, type TreeDnd } from "../order/dnd.ts";
import { Disclosure, FolderIcon, PageIcon } from "../order/icons.tsx";
import { MoveToDialog, type Destination } from "../order/MoveToDialog.tsx";
import { clearMoveTo, usePendingMoveTo, type MoveToRequest } from "../order/move-to.ts";
import { RenameInput } from "../order/RenameInput.tsx";
import { focusTreeItemSoon, treeKeyDown } from "../order/tree-keys.ts";
import { useStrings } from "../strings/index.ts";
import type { OpenOptions } from "../tabs/model.ts";
import { clickOpens, isMiddleClick, isOpenInNewTabKey } from "../tabs/open-keys.ts";
import { workspaceKey, type ServerDirectory, type WorkspacePageRef } from "./directory.ts";
import { childrenOf, isWithin, nestWorkspaceTree, workspaceAncestors, type WorkspaceTreeItem } from "./tree.ts";

/** The drop target for "no parent": the workspace row itself. */
const TOP = "\u0000top";
const END = 1_000_000;

/** What every page row needs from its workspace section. */
interface Ctx {
  server: string;
  workspace: string;
  canWrite: boolean;
  /** The server keeps page order (`page-order`). */
  ordered: boolean;
  current: WorkspacePageRef | null;
  open: Set<string>;
  toggle(id: string, force?: boolean): void;
  openPage(ref: WorkspacePageRef, options?: OpenOptions): void;
  renaming: string | null;
  startRename(id: string): void;
  endRename(id: string): void;
  rename(id: string, title: string): Promise<void>;
  dnd: TreeDnd;
  openMenu(id: string, at: { x: number; y: number }): void;
  reorder(id: string, delta: -1 | 1): void;
}

interface PageItemProps {
  item: WorkspaceTreeItem;
  depth: number;
  /** 1-based place among the siblings, and how many there are. */
  index: number;
  size: number;
  ctx: Ctx;
}

const anchorOf = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + 16, y: r.bottom };
};

/**
 * A page. A folder page (`thoth_kind: folder`) is drawn as a folder and only opens and closes; any other page
 * opens in the editor, and one with sub-pages also shows them (keyboard users need no separate caret).
 */
function PageItem({ item, depth, index, size, ctx }: PageItemProps) {
  const t = useStrings().tree;
  const { server, workspace, current } = ctx;
  const selected = !item.folder && current?.server === server && current.workspace === workspace && current.page === item.id;
  const expanded = ctx.open.has(item.id);
  const hasChildren = item.children.length > 0;
  const expandable = item.folder || hasChildren;
  const indent = { paddingLeft: 8 + depth * 14 };
  const common = { "data-tree-id": item.id, "aria-level": depth + 1, "aria-posinset": index, "aria-setsize": size } as const;

  const label = (
    <>
      {expandable ? <Disclosure open={expanded} onToggle={() => ctx.toggle(item.id)} /> : <Disclosure open={false} hidden />}
      {item.folder ? <FolderIcon open={expanded} /> : <PageIcon />}
      <span className="tree-label">{item.title}</span>
    </>
  );

  if (ctx.renaming === item.id) {
    return (
      <li role="none">
        <div role="treeitem" aria-selected={selected} className="tree-item tree-renaming" style={indent} {...common} {...(expandable ? { "aria-expanded": expanded } : {})}>
          {label}
          <RenameInput value={item.title} label={t.renameLabel(item.title)} maxLength={PAGE_TITLE_MAX} onCommit={(next) => ctx.rename(item.id, next)} onDone={() => ctx.endRename(item.id)} />
        </div>
      </li>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) =>
    treeKeyDown(event, {
      expandable,
      expanded,
      expand: () => ctx.toggle(item.id, true),
      collapse: () => ctx.toggle(item.id, false),
      ...(ctx.canWrite ? { rename: () => ctx.startRename(item.id), reorder: (delta: -1 | 1) => ctx.reorder(item.id, delta), menu: () => ctx.openMenu(item.id, anchorOf(event.currentTarget)) } : {}),
    });

  return (
    <li role="none">
      <button
        type="button"
        role="treeitem"
        aria-selected={selected}
        aria-current={selected ? "page" : undefined}
        {...(expandable ? { "aria-expanded": expanded } : {})}
        {...common}
        className="tree-item"
        data-kind={item.folder ? "folder" : "page"}
        data-dragging={ctx.dnd.dragging === item.id || undefined}
        style={indent}
        title={item.folder ? `${t.folder} · ${t.itemCount(item.children.length)}` : undefined}
        onKeyDown={(event) => {
          if (!item.folder && event.target === event.currentTarget && isOpenInNewTabKey(event)) {
            event.preventDefault();
            ctx.openPage({ server, workspace, page: item.id }, { newTab: true });
            return;
          }
          onKeyDown(event);
        }}
        onContextMenu={(event: MouseEvent<HTMLElement>) => {
          if (!ctx.canWrite) return;
          event.preventDefault();
          ctx.openMenu(item.id, { x: event.clientX, y: event.clientY });
        }}
        onClick={(event) => {
          if (item.folder) return ctx.toggle(item.id, !expanded);
          if (hasChildren) ctx.toggle(item.id, true);
          ctx.openPage({ server, workspace, page: item.id }, clickOpens(event));
        }}
        onAuxClick={(event) => {
          if (item.folder || !isMiddleClick(event)) return;
          event.preventDefault();
          ctx.openPage({ server, workspace, page: item.id }, { newTab: true });
        }}
        {...ctx.dnd.rowProps(item.id)}
      >
        {label}
      </button>
      {expanded && expandable && (
        <ul role="group">
          {item.children.map((child, i) => (
            <PageItem key={child.id} item={child} depth={depth + 1} index={i + 1} size={item.children.length} ctx={ctx} />
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
  openPage(ref: WorkspacePageRef, options?: OpenOptions): void;
  /** After New page created a page (before it opens). */
  onPageCreated?(): void;
  /** Writes the open page's pending edits before the tree changes a page; false keeps everything as it is. */
  flush?(): Promise<boolean>;
}

const isThisWorkspace = (server: string, workspace: string) => (request: MoveToRequest): request is Extract<MoveToRequest, { kind: "workspace" }> =>
  request.kind === "workspace" && request.server === server && request.workspace === workspace;

/** Pages of the tree below `items`, for the "Move to…" list; the subtree of `except` is left out (it cannot move into itself). */
function destinationsFor(items: WorkspaceTreeItem[], except: string, topLevel: string): Destination[] {
  const out: Destination[] = [{ id: "", label: topLevel, depth: 0, folder: false }];
  const walk = (list: WorkspaceTreeItem[], depth: number) => {
    for (const item of list) {
      if (item.id === except) continue;
      out.push({ id: item.id, label: item.title, depth, folder: item.folder });
      walk(item.children, depth + 1);
    }
  };
  walk(items, 1);
  return out;
}

/**
 * One workspace in a sidebar tree: expands to its pages (polling its change feed while expanded) and, for
 * editors and owners, offers New page and New folder, rename (F2, context menu), and drag and drop, Alt+Shift+Up/Down
 * and "Move to…" to reorder and nest pages. Shared by the desktop sidebar and the web client.
 */
export function WorkspaceSection({ directory, server, serverLabel, workspace, current, openPage, onPageCreated, flush }: WorkspaceSectionProps) {
  const t = useStrings().workspace;
  const tt = useStrings().tree;
  const state = useSyncExternalStore(directory.subscribe, directory.getState);
  const key = workspaceKey(server, workspace.id);
  const expanded = state.expanded.includes(key);
  const tree = state.trees[key];
  const ordered = state.capabilities[server]?.includes("page-order") ?? false;
  const items = useMemo(() => nestWorkspaceTree(tree?.nodes ?? [], { ordered, isFolder: (id) => tree?.kinds[id]?.folder === true }), [tree?.nodes, tree?.kinds, ordered]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const here = current?.server === server && current.workspace === workspace.id ? current.page : null;
  const canWrite = roleCan(workspace.role, "write");
  const nodes = tree?.nodes;
  /** The tree as it is now, also while a change is under way (the rendered `nodes` lag behind by a render). */
  const fresh = (): readonly TreeNode[] | undefined => directory.getState().trees[key]?.nodes;
  // Changes run one after another: a key held down repeats faster than the server answers.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = <T,>(job: () => Promise<T>): Promise<T> => {
    const run = chain.current.then(job, job);
    chain.current = run.catch(() => undefined);
    return run;
  };

  // Keep the open page visible.
  useEffect(() => {
    if (!here || !tree) return;
    const up = workspaceAncestors(tree.nodes, here);
    if (up.length === 0) return;
    setOpen((prev) => (up.every((id) => prev.has(id)) ? prev : new Set([...prev, ...up])));
  }, [here, tree]);

  const toggle = (id: string, force?: boolean) =>
    setOpen((prev) => {
      if (force === true && prev.has(id)) return prev;
      if (force === false && !prev.has(id)) return prev;
      const next = new Set(prev);
      if (force === true || (force === undefined && !next.delete(id))) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Runs a change to the tree: pending edits are written first, and a failure is shown, never thrown. */
  const lastError = useRef("");
  const run = async (action: () => Promise<void>, failed: (detail: string) => string): Promise<boolean> => {
    setCreateError(null);
    lastError.current = "";
    try {
      if (flush && !(await flush())) return false;
      await action();
      return true;
    } catch (error) {
      lastError.current = failed(error instanceof Error ? error.message : String(error));
      setCreateError(lastError.current);
      return false;
    }
  };

  const create = async (kind: "page" | "folder", parentId: string | null) => {
    setCreating(true);
    setCreateError(null);
    try {
      const parent = parentId === null ? undefined : parentId;
      if (kind === "page") {
        const page = await directory.createPage(server, workspace.id, t.newPageTitle, parent);
        directory.expand(server, workspace.id);
        if (parentId) toggle(parentId, true);
        onPageCreated?.();
        openPage({ server, workspace: workspace.id, page: page.id });
      } else {
        const folder = await directory.createFolder(server, workspace.id, tt.newFolderTitle, parent);
        directory.expand(server, workspace.id);
        if (parentId) toggle(parentId, true);
        onPageCreated?.();
        setRenaming(folder.id); // named at once, like a new folder in a file manager
      }
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  const siblingsOf = (id: string): { parent: string | null; list: TreeNode[] } | null => {
    const all = fresh();
    const node = all?.find((n) => n.id === id);
    if (!all || !node) return null;
    const known = node.parentId !== null && node.parentId !== node.id && all.some((n) => n.id === node.parentId);
    const parent = known ? node.parentId : null;
    return { parent, list: childrenOf(all, parent, ordered) };
  };

  const titleOf = (id: string) => fresh()?.find((n) => n.id === id)?.title || "Untitled";

  /** Moves `id` under `parent` at `index`; `say` is announced when it worked. */
  const moveTo = (id: string, parent: string | null, index: number, say: () => string) =>
    enqueue(async () => {
      const ok = await run(() => directory.movePage(server, workspace.id, id, { parentId: parent, index }), tt.moveFailed);
      if (ok) {
        if (parent) toggle(parent, true);
        setSaid(say());
      }
      focusTreeItemSoon(id);
      return ok;
    });

  const reorder = (id: string, delta: -1 | 1) => {
    if (!ordered) {
      setSaid(tt.orderUnavailable);
      return;
    }
    void enqueue(async () => {
      const at = siblingsOf(id);
      if (!at) return;
      const i = at.list.findIndex((n) => n.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= at.list.length) return;
      const ok = await run(() => directory.movePage(server, workspace.id, id, { parentId: at.parent, index: j }), tt.moveFailed);
      if (ok) setSaid(tt.movedTo(titleOf(id), j + 1, at.list.length));
      focusTreeItemSoon(id);
    });
  };

  const drop = (dragId: string, overId: string, zone: DropZone) => {
    if (overId === TOP) return void moveTo(dragId, null, END, () => tt.movedToTop(titleOf(dragId)));
    if (zone === "inside") return void moveTo(dragId, overId, END, () => tt.movedInto(titleOf(dragId), titleOf(overId)));
    const over = siblingsOf(overId);
    if (!over) return;
    const rest = over.list.filter((n) => n.id !== dragId);
    const index = rest.findIndex((n) => n.id === overId) + (zone === "after" ? 1 : 0);
    const mine = siblingsOf(dragId);
    // Dropped where it already is: nothing to write.
    if (mine && mine.parent === over.parent && mine.list.findIndex((n) => n.id === dragId) === index) return;
    void moveTo(dragId, over.parent, index, () => tt.movedTo(titleOf(dragId), index + 1, rest.length + 1));
  };

  const dnd = useTreeDnd({
    enabled: canWrite && expanded,
    canContain: () => true,
    canOrder: ordered,
    canDrop: (dragId, overId, zone) => {
      if (!nodes || dragId === overId) return false;
      const node = nodes.find((n) => n.id === dragId);
      if (!node) return false; // another workspace's page
      if (overId === TOP) return node.parentId !== null;
      if (!nodes.some((n) => n.id === overId)) return false;
      // Never into itself or below itself.
      if (isWithin(nodes, overId, dragId)) return false;
      return zone === "inside" || ordered;
    },
    onDrop: drop,
    onHoverOpen: (id) => id !== TOP && toggle(id, true),
  });

  const ctx: Ctx = {
    server,
    workspace: workspace.id,
    canWrite,
    ordered,
    current,
    open,
    toggle,
    openPage,
    renaming,
    startRename: (id) => setRenaming(id),
    endRename: (id) => {
      setRenaming(null);
      focusTreeItemSoon(id);
    },
    rename: async (id, title) => {
      const ok = await run(async () => void (await directory.renamePage(server, workspace.id, id, title)), tt.renameFailed);
      if (ok) setSaid(tt.renamed(title));
    },
    dnd,
    openMenu: (id, at) => setMenu({ id, at }),
    reorder,
  };

  // "Move to…" asked for from code (the command palette).
  const request = usePendingMoveTo(isThisWorkspace(server, workspace.id));
  useEffect(() => {
    if (!request) return;
    clearMoveTo();
    if (canWrite && nodes?.some((n) => n.id === request.page)) setMoving(request.page);
  }, [request, canWrite, nodes]);

  const menuItems = (id: string): MenuItem[] => {
    const at = siblingsOf(id);
    const i = at ? at.list.findIndex((n) => n.id === id) : -1;
    return [
      { id: "rename", label: tt.rename, hint: "F2", onSelect: () => setRenaming(id) },
      { id: "new-page", label: tt.newPageInside, onSelect: () => void create("page", id) },
      { id: "new-folder", label: tt.newFolderInside, onSelect: () => void create("folder", id) },
      { id: "up", label: tt.moveUp, hint: "⌥⇧↑", disabled: !ordered || i <= 0, onSelect: () => reorder(id, -1) },
      { id: "down", label: tt.moveDown, hint: "⌥⇧↓", disabled: !ordered || !at || i < 0 || i >= at.list.length - 1, onSelect: () => reorder(id, 1) },
      { id: "move", label: tt.moveTo, onSelect: () => setMoving(id) },
    ];
  };

  // The workspace row takes drops ("to the top level") but is not itself draggable.
  const { draggable: _draggable, onDragStart: _onDragStart, ...topDrop } = dnd.rowProps(TOP);
  const movingNode = moving ? nodes?.find((n) => n.id === moving) : undefined;
  const rowKeys = (event: KeyboardEvent<HTMLElement>) =>
    treeKeyDown(event, { expandable: true, expanded, expand: () => directory.expand(server, workspace.id), collapse: () => directory.collapse(server, workspace.id) });

  return (
    <li role="none">
      <div className="tree-row">
        <button
          type="button"
          role="treeitem"
          aria-expanded={expanded}
          aria-level={1}
          data-tree-id={`${key}\n`}
          className="tree-item tree-folder"
          onClick={() => (expanded ? directory.collapse(server, workspace.id) : directory.expand(server, workspace.id))}
          onKeyDown={rowKeys}
          title={t.onServer(workspace.name, serverLabel)}
          {...topDrop}
        >
          <Disclosure open={expanded} />
          <span className="tree-label">{workspace.name}</span>
          <span className="badge badge-workspace tree-badge">{t.badgeShort}</span>
        </button>
        {canWrite && (
          <>
            <button type="button" className="tree-add" aria-label={tt.newFolderIn(workspace.name)} title={tt.newFolder} disabled={creating} onClick={() => void create("folder", null)}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 4.2a1 1 0 0 1 1-1h3l1.4 1.6H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z M8 7.2v3.6 M6.2 9h3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button type="button" className="tree-add" aria-label={t.newPageIn(workspace.name)} title={creating ? t.creating : t.newPage} disabled={creating} onClick={() => void create("page", null)}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </>
        )}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-tree-said>
        {said}
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
            items.map((item, i) => <PageItem key={item.id} item={item} depth={1} index={i + 1} size={items.length} ctx={ctx} />)
          )}
          {canWrite && !ordered && items.length > 1 && (
            <li role="none" className="tree-note muted">
              {tt.orderUnavailable}
            </li>
          )}
        </ul>
      )}
      {menu && (
        <ContextMenu
          label={tt.menuLabel(titleOf(menu.id))}
          at={menu.at}
          items={menuItems(menu.id)}
          onClose={(restoreFocus) => {
            setMenu(null);
            if (restoreFocus) focusTreeItemSoon(menu.id);
          }}
        />
      )}
      {movingNode && (
        <MoveToDialog
          name={movingNode.title || "Untitled"}
          destinations={destinationsFor(items, movingNode.id, tt.moveDialog.topLevel)}
          initial={movingNode.parentId && nodes?.some((n) => n.id === movingNode.parentId) ? movingNode.parentId : ""}
          onMove={async (destination) => {
            const parent = destination === "" ? null : destination;
            const name = titleOf(movingNode.id);
            const ok = await moveTo(movingNode.id, parent, END, () => (parent === null ? tt.movedToTop(name) : tt.movedInto(name, titleOf(parent))));
            return ok ? null : lastError.current;
          }}
          onClose={() => setMoving(null)}
        />
      )}
    </li>
  );
}
