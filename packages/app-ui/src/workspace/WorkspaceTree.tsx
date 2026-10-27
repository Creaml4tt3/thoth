import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from "react";
import { PAGE_TITLE_MAX, WORKSPACE_NAME_MAX, roleCan, type TreeNode, type Workspace } from "@thoth/workspace-protocol";
import { ContextMenu, type MenuItem } from "../order/ContextMenu.tsx";
import { useTreeDnd, type AcrossTarget, type DropZone, type TreeDnd } from "../order/dnd.ts";
import { betweenRefusal, crossDirection, refusalText, spaceDropRefusal, workspaceAccess, type SpaceDrag } from "../order/space-drag.ts";
import { Disclosure, FolderIcon, PageIcon } from "../order/icons.tsx";
import { MoveToDialog, type Destination } from "../order/MoveToDialog.tsx";
import { clearMoveTo, usePendingMoveTo, type MoveToRequest } from "../order/move-to.ts";
import { clearReorder, usePendingReorder, type ReorderRequest } from "../order/reorder-request.ts";
import { RenameDialog } from "../order/RenameDialog.tsx";
import { RenameInput } from "../order/RenameInput.tsx";
import { TreeGroup } from "../order/TreeGroup.tsx";
import { focusTreeItemSoon, treeKeyDown } from "../order/tree-keys.ts";
import { useStrings } from "../strings/index.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { tipIfClipped } from "../ui/Tooltip.tsx";
import type { OpenOptions } from "../tabs/model.ts";
import { clickOpens, isMiddleClick, isOpenInNewTabKey } from "../tabs/open-keys.ts";
import { workspaceKey, type ServerDirectory, type WorkspacePageRef } from "./directory.ts";
import { useFavorites } from "../favorites/context.ts";
import { hasOtherWritableWorkspace } from "../transfer/targets.ts";
import { childrenOf, isWithin, nestWorkspaceTree, workspaceAncestors, type WorkspaceTreeItem } from "./tree.ts";
import { ShareDialog } from "./ShareDialog.tsx";
import { clearShare, usePendingShare } from "./share-request.ts";
import { MembersDialog } from "./MembersDialog.tsx";
import { clearMembers, usePendingMembers } from "./members-request.ts";
import { ConfirmByNameDialog } from "./ConfirmByNameDialog.tsx";
import { announceWorkspaces, clearWorkspaceAdmin, usePendingWorkspaceAdmin } from "./workspace-admin-request.ts";

/** The drop target for "no parent": the workspace row itself. */
const TOP = "\u0000top";
const END = 1_000_000;

/** What every page row needs from its workspace section. */
interface Ctx {
  server: string;
  workspace: string;
  canWrite: boolean;
  /** A row has a menu: for writers, or for anyone where the app has Favorites (Add to Favorites, ADR-0027). */
  hasMenu: boolean;
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
      ...(ctx.canWrite ? { rename: () => ctx.startRename(item.id), reorder: (delta: -1 | 1) => ctx.reorder(item.id, delta) } : {}),
      ...(ctx.hasMenu ? { menu: () => ctx.openMenu(item.id, anchorOf(event.currentTarget)) } : {}),
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
        {...tipIfClipped(item.title)}
        onKeyDown={(event) => {
          if (!item.folder && event.target === event.currentTarget && isOpenInNewTabKey(event)) {
            event.preventDefault();
            ctx.openPage({ server, workspace, page: item.id }, { newTab: true });
            return;
          }
          onKeyDown(event);
        }}
        onContextMenu={(event: MouseEvent<HTMLElement>) => {
          if (!ctx.hasMenu) return;
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
      {expandable && (
        <TreeGroup open={expanded} count={item.children.length}>
          {item.children.map((child, i) => (
            <PageItem key={child.id} item={child} depth={depth + 1} index={i + 1} size={item.children.length} ctx={ctx} />
          ))}
        </TreeGroup>
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
  /**
   * Pages can be dragged between this workspace and the Private Space (the desktop app; `space-drag.ts`). A drop
   * only asks for the transfer dialog; dragging within the workspace is unchanged.
   */
  spaceDrops?: boolean;
  /**
   * "Copy to Private Space…" and "Move to Private Space…" in a page's menu (the desktop app; the web has no Private
   * Space): what the page would carry in a drag, for the same transfer dialog. Move needs write here.
   */
  onToPrivate?(drag: SpaceDrag, mode: "copy" | "move"): void;
  /**
   * "Copy to another workspace…" and "Move to another workspace…" in a page's menu (ADR-0006, amendment of
   * 2026-10-27), offered while there is another workspace the person can write to: what the page would carry in a
   * drag, for the transfer dialog, which picks the destination. Move needs write here.
   */
  onToWorkspace?(drag: SpaceDrag, mode: "copy" | "move"): void;
}

const isThisWorkspace = (server: string, workspace: string) => (request: MoveToRequest): request is Extract<MoveToRequest, { kind: "workspace" }> =>
  request.kind === "workspace" && request.server === server && request.workspace === workspace;

const isThisWorkspaceReorder = (server: string, workspace: string) => (request: ReorderRequest): request is Extract<ReorderRequest, { kind: "workspace" }> =>
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
export function WorkspaceSection({ directory, server, serverLabel, workspace, current, openPage, onPageCreated, flush, spaceDrops = false, onToPrivate, onToWorkspace }: WorkspaceSectionProps) {
  const t = useStrings().workspace;
  const tt = useStrings().tree;
  const tx = useStrings().transfer;
  const tm = useStrings().members;
  const tw = useStrings().workspaces;
  const tf = useStrings().favorites;
  const favorites = useFavorites();
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
  const [sharing, setSharing] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  /** ADR-0025: the owner's Rename… and Delete… of this workspace. */
  const [admin, setAdmin] = useState<"rename" | "delete" | null>(null);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number } | null>(null);
  const rowButton = useRef<HTMLButtonElement>(null);
  const [said, setSaid] = useState("");
  const here = current?.server === server && current.workspace === workspace.id ? current.page : null;
  const canWrite = roleCan(workspace.role, "write");
  /** Another workspace, on any server the person is signed in to, that takes pages. */
  const elsewhere = hasOtherWritableWorkspace(state, { server, workspace: workspace.id });
  // ADR-0023: owners and editors, on a server that lists `public-share`.
  const canShare = canWrite && (state.capabilities[server]?.includes("public-share") ?? false);
  // ADR-0024: every member sees the members; owners also manage them and, with `invite-links`, invite people.
  const canMembers = state.capabilities[server]?.includes("members") ?? false;
  const canInvite = state.capabilities[server]?.includes("invite-links") ?? false;
  // ADR-0025: owners rename and delete the workspace, on a server that lists `workspace-management`.
  const canAdminister = workspace.role === "owner" && (state.capabilities[server]?.includes("workspace-management") ?? false);
  const account = state.servers.find((s) => s.info.id === server)?.info;
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

  // Across spaces (`spaceDrops`): what a dragged page takes to the Private Space, and what a page from there may do here.
  const space = { kind: "workspace", server, workspace: workspace.id } as const;
  /** The page, and for a folder everything inside it, parents first. */
  const carry = (id: string): SpaceDrag | null => {
    const all = fresh();
    if (id === TOP || !all?.some((n) => n.id === id)) return null;
    const ids = [id];
    if (directory.getState().trees[key]?.kinds[id]?.folder) for (let i = 0; i < ids.length; i++) for (const n of all) if (n.parentId === ids[i]) ids.push(n.id);
    return { from: space, row: id, ids, title: titleOf(id) };
  };
  /** A drop lands at the top level (the workspace row) or inside the page under the pointer. */
  const across = (drag: SpaceDrag, id: string, move: boolean): AcrossTarget | null => {
    const direction = crossDirection(drag.from, space);
    if (direction !== "to_workspace" && direction !== "between_workspaces") return null;
    const access = workspaceAccess(directory, server, workspace.id);
    // From another workspace both ends are asked: this one receives, the other gives (its export restriction).
    const refused =
      drag.from.kind === "workspace" ? betweenRefusal(workspaceAccess(directory, drag.from.server, drag.from.workspace), access) : ((r) => (r ? { refusal: r, access } : null))(spaceDropRefusal("to_workspace", access));
    if (refused) return { highlight: null, to: null, text: refusalText(refused.refusal, refused.access, tt.across) };
    const parentId = id !== TOP && fresh()?.some((n) => n.id === id) ? id : null;
    return { highlight: parentId ?? TOP, to: { ...space, parentId }, text: (move ? tt.across.moveTo : tt.across.copyTo)(workspace.name) };
  };

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
    onlyInside: (id) => id === TOP,
    firstChild: (id) => (id !== TOP && open.has(id) && nodes ? (childrenOf(nodes, id, ordered)[0]?.id ?? null) : null),
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
    // The workspace row itself opens only for a drag from the Private Space (a drag within needs it open already).
    onHoverOpen: (id) => (id === TOP ? !expanded && directory.expand(server, workspace.id) : toggle(id, true)),
    // A viewer's rows stay undraggable, as before; they copy out with the page's "Copy to Private Space…".
    ...(spaceDrops ? { across, ...(canWrite ? { carry } : {}) } : {}),
  });

  const ctx: Ctx = {
    server,
    workspace: workspace.id,
    canWrite,
    hasMenu: canWrite || favorites !== null || onToPrivate !== undefined,
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

  // "Share…" asked for from code (the command palette).
  const shareRequest = usePendingShare(server, workspace.id);
  useEffect(() => {
    if (!shareRequest) return;
    clearShare();
    if (canShare && nodes?.some((n) => n.id === shareRequest.page)) setSharing(shareRequest.page);
  }, [shareRequest, canShare, nodes]);

  // "Members…" asked for from code (the command palette).
  const membersRequest = usePendingMembers(server, workspace.id);
  useEffect(() => {
    if (!membersRequest) return;
    clearMembers();
    if (canMembers) setMembersOpen(true);
  }, [membersRequest, canMembers]);

  // "Rename workspace…" and "Delete workspace…" asked for from code (the command palette).
  const adminRequest = usePendingWorkspaceAdmin(server, workspace.id);
  useEffect(() => {
    if (!adminRequest) return;
    clearWorkspaceAdmin();
    if (canAdminister) setAdmin(adminRequest.kind);
  }, [adminRequest, canAdminister]);

  // "Move page up / down" asked for from code (the command palette): the same change as Alt+Shift+Up and Down.
  const reorderRequest = usePendingReorder(isThisWorkspaceReorder(server, workspace.id));
  useEffect(() => {
    if (!reorderRequest) return;
    clearReorder();
    if (canWrite && nodes?.some((n) => n.id === reorderRequest.page)) reorder(reorderRequest.page, reorderRequest.delta);
    // `reorder` reads the current tree; the request is what triggers this.
  }, [reorderRequest]);

  const menuItems = (id: string): MenuItem[] => {
    const at = siblingsOf(id);
    const i = at ? at.list.findIndex((n) => n.id === id) : -1;
    const ref = { kind: "workspace" as const, server, workspace: workspace.id, page: id };
    // Folders hold pages; only a page is starred (ADR-0027).
    const star: MenuItem[] =
      favorites && favorites.can(ref) && tree?.kinds[id]?.folder !== true
        ? [{ id: "favorite", label: favorites.has(ref) ? tf.remove : tf.add, onSelect: () => favorites.toggle(ref) }]
        : [];
    // Like the page header's Copy here / Move here: the dialog explains an export restriction or a missing capability.
    const drag = onToPrivate ? carry(id) : null;
    const toPrivate: MenuItem[] =
      onToPrivate && drag
        ? [
            { id: "copy-to-private", label: tt.across.copyTo(tt.across.privateSpace), onSelect: () => onToPrivate(drag, "copy") },
            ...(canWrite ? [{ id: "move-to-private", label: tt.across.moveTo(tt.across.privateSpace), onSelect: () => onToPrivate(drag, "move") }] : []),
          ]
        : [];
    const carried = onToWorkspace && elsewhere ? (drag ?? carry(id)) : null;
    const toWorkspace: MenuItem[] =
      onToWorkspace && carried
        ? [
            { id: "copy-to-workspace", label: tx.copyToOther, onSelect: () => onToWorkspace(carried, "copy") },
            ...(canWrite ? [{ id: "move-to-workspace", label: tx.moveToOther, onSelect: () => onToWorkspace(carried, "move") }] : []),
          ]
        : [];
    if (!canWrite) return [...star, ...toPrivate, ...toWorkspace];
    return [
      ...star,
      { id: "rename", label: tt.rename, hint: "F2", onSelect: () => setRenaming(id) },
      { id: "new-page", label: tt.newPageInside, onSelect: () => void create("page", id) },
      { id: "new-folder", label: tt.newFolderInside, onSelect: () => void create("folder", id) },
      { id: "up", label: tt.moveUp, hint: "⌥⇧↑", disabled: !ordered || i <= 0, onSelect: () => reorder(id, -1) },
      { id: "down", label: tt.moveDown, hint: "⌥⇧↓", disabled: !ordered || !at || i < 0 || i >= at.list.length - 1, onSelect: () => reorder(id, 1) },
      { id: "move", label: tt.moveTo, onSelect: () => setMoving(id) },
      ...toPrivate,
      ...toWorkspace,
      ...(canShare ? [{ id: "share", label: tt.share, onSelect: () => setSharing(id) }] : []),
    ];
  };

  // The workspace row takes drops ("to the top level") but is not itself draggable.
  const { draggable: _draggable, onDragStart: _onDragStart, ...topDrop } = dnd.rowProps(TOP);
  const movingNode = moving ? nodes?.find((n) => n.id === moving) : undefined;
  /** The workspace row's own menu: Members…, for owners Rename… and Delete…, and for writers New page and New folder. */
  const rowItems: MenuItem[] = [
    ...(canMembers ? [{ id: "members", label: tm.menuItem, onSelect: () => setMembersOpen(true) }] : []),
    ...(canAdminister
      ? [
          { id: "rename-workspace", label: tw.rename, hint: "F2", onSelect: () => setAdmin("rename") },
          { id: "delete-workspace", label: tw.delete, onSelect: () => setAdmin("delete") },
        ]
      : []),
    ...(canWrite
      ? [
          { id: "new-page", label: t.newPage, onSelect: () => void create("page", null) },
          { id: "new-folder", label: tt.newFolder, onSelect: () => void create("folder", null) },
        ]
      : []),
  ];
  const rowKeys = (event: KeyboardEvent<HTMLElement>) =>
    treeKeyDown(event, {
      expandable: true,
      expanded,
      expand: () => directory.expand(server, workspace.id),
      collapse: () => directory.collapse(server, workspace.id),
      ...(canAdminister ? { rename: () => setAdmin("rename") } : {}),
      ...(rowItems.length > 0 ? { menu: () => setRowMenu(anchorOf(event.currentTarget)) } : {}),
    });

  return (
    <li role="none">
      <div className="tree-row">
        <button
          ref={rowButton}
          type="button"
          role="treeitem"
          aria-expanded={expanded}
          aria-level={1}
          data-tree-id={`${key}\n`}
          className="tree-item tree-folder"
          onClick={() => (expanded ? directory.collapse(server, workspace.id) : directory.expand(server, workspace.id))}
          onKeyDown={rowKeys}
          onContextMenu={(event: MouseEvent<HTMLElement>) => {
            if (rowItems.length === 0) return;
            event.preventDefault();
            setRowMenu({ x: event.clientX, y: event.clientY });
          }}
          title={t.onServer(workspace.name, serverLabel)}
          {...tipIfClipped(workspace.name)}
          {...topDrop}
        >
          <Disclosure open={expanded} />
          <span className="tree-label">{workspace.name}</span>
          <span className="badge badge-workspace tree-badge">{t.badgeShort}</span>
        </button>
        {canMembers && <IconButton icon="people" className="tree-add" label={tm.button(workspace.name)} onClick={() => setMembersOpen(true)} />}
        {canWrite && (
          <>
            <IconButton icon="folder-plus" className="tree-add" label={tt.newFolderIn(workspace.name)} disabled={creating} onClick={() => void create("folder", null)} />
            <IconButton icon="page-plus" className="tree-add" label={t.newPageIn(workspace.name)} disabled={creating} onClick={() => void create("page", null)} />
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
      <TreeGroup open={expanded} count={items.length} label={t.pagesIn(workspace.name)}>
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
      </TreeGroup>
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
      {rowMenu && (
        <ContextMenu
          label={tm.workspaceMenu(workspace.name)}
          at={rowMenu}
          items={rowItems}
          onClose={(restoreFocus) => {
            setRowMenu(null);
            if (restoreFocus) rowButton.current?.focus();
          }}
        />
      )}
      {membersOpen && canMembers && (
        <MembersDialog
          client={directory.client(server)}
          workspace={workspace}
          {...(account?.account?.id ? { me: account.account.id } : {})}
          canInvite={canInvite}
          {...(account?.limits?.["maxMembersPerWorkspace"] !== undefined ? { maxMembers: account.limits["maxMembersPerWorkspace"] } : {})}
          onChanged={() => void directory.loadWorkspaces(server)}
          onLeft={() => {
            setMembersOpen(false);
            void directory.forgetWorkspace(server, workspace.id);
          }}
          onClose={() => setMembersOpen(false)}
        />
      )}
      {admin === "rename" && canAdminister && (
        <RenameDialog
          name={workspace.name}
          maxLength={WORKSPACE_NAME_MAX}
          onRename={async (next) => {
            try {
              const renamed = await directory.renameWorkspace(server, workspace.id, next);
              setSaid(tw.renamed(renamed.name));
              focusTreeItemSoon(`${key}\n`);
              return null;
            } catch (error) {
              return tw.renameFailed(error instanceof Error ? error.message : String(error));
            }
          }}
          onClose={() => setAdmin(null)}
        />
      )}
      {admin === "delete" && canAdminister && (
        <ConfirmByNameDialog
          title={tw.deleteTitle(workspace.name)}
          body={tw.deleteBody(workspace.memberCount)}
          name={workspace.name}
          confirmLabel={tw.deleteConfirm}
          busyLabel={tw.deleting}
          onConfirm={async () => {
            try {
              const name = workspace.name;
              await directory.deleteWorkspace(server, workspace.id);
              announceWorkspaces(server, tw.deleted(name));
              return null;
            } catch (error) {
              return tw.deleteFailed(error instanceof Error ? error.message : String(error));
            }
          }}
          onClose={() => setAdmin(null)}
        />
      )}
      {sharing && canShare && <ShareDialog client={directory.client(server)} workspace={workspace.id} page={sharing} title={titleOf(sharing)} onClose={() => setSharing(null)} />}
    </li>
  );
}
