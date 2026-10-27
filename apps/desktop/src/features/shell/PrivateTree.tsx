import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from "react";
import { basename, dirname, stripExtension } from "@thoth/domain";
import { roleCan } from "@thoth/workspace-protocol";
import type { OrderRecord } from "@thoth/local-store";
import { ContextMenu, type MenuItem } from "@thoth/app-ui/order/ContextMenu.tsx";
import { useTreeDnd, type DropZone } from "@thoth/app-ui/order/dnd.ts";
import type { SpaceDrag } from "@thoth/app-ui/order/space-drag.ts";
import { Disclosure, FolderIcon, PageIcon } from "@thoth/app-ui/order/icons.tsx";
import { MoveToDialog, type Destination } from "@thoth/app-ui/order/MoveToDialog.tsx";
import { clearMoveTo, usePendingMoveTo, type MoveToRequest } from "@thoth/app-ui/order/move-to.ts";
import { clearNewFolder, usePendingNewFolder } from "@thoth/app-ui/order/new-folder-request.ts";
import { RenameInput, RenameRejected } from "@thoth/app-ui/order/RenameInput.tsx";
import { clearReorder, usePendingReorder, type ReorderRequest } from "@thoth/app-ui/order/reorder-request.ts";
import { TreeGroup } from "@thoth/app-ui/order/TreeGroup.tsx";
import { TreeList } from "@thoth/app-ui/order/TreeList.tsx";
import { focusTreeItem, focusTreeItemSoon, treeKeyDown } from "@thoth/app-ui/order/tree-keys.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { tipIfClipped } from "@thoth/app-ui/ui/Tooltip.tsx";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { clickOpens, isMiddleClick, isOpenInNewTabKey } from "@thoth/app-ui/tabs/open-keys.ts";
import { useSession } from "../../app/context.ts";
import { useFavorites } from "@thoth/app-ui/favorites/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { moveIntoFolder, reorderInFolder } from "./arrange.ts";
import { RenameError, renamePrivate, renameProblemText } from "./rename.ts";
import { childrenAt, listFolders, nodeName, type TreeNode } from "./tree.ts";
import { PRIVATE_SPACE, privateAcross } from "./space-drop.ts";
import type { TransferTarget } from "../transfer/TransferDialog.tsx";

/** Every page below a folder, at any depth. */
const pagesIn = (node: TreeNode): string[] => (node.kind === "page" ? [node.path] : node.children.flatMap(pagesIn));

export interface Selection {
  active: boolean;
  paths: ReadonlySet<string>;
  toggle(path: string): void;
}

/** The drop target for the top level, shown as a strip under the tree while something is dragged. */
const TOP = "\u0000top";
const END = 1_000_000;
/** The longest name the rename field takes, in characters (`entryNameProblem` also limits it in bytes). */
const NAME_MAX = 200;
const isPrivate = (request: MoveToRequest): request is Extract<MoveToRequest, { kind: "private" }> => request.kind === "private";
const isPrivateReorder = (request: ReorderRequest): request is Extract<ReorderRequest, { kind: "private" }> => request.kind === "private";

interface Props {
  tree: TreeNode[];
  current: string | null;
  open: ReadonlySet<string>;
  /** Opens (true), closes (false) or flips a folder. */
  setFolder(path: string, open?: boolean): void;
  /** Folders whose path changed (a folder was moved): their open state follows. */
  remapFolders(from: string, to: string): void;
  selection: Selection;
  /** The order record changed (reorder or move). */
  onOrder(order: OrderRecord): void;
  /** Opens the copy/move dialog (it writes pending edits first); the menu offers it while a workspace can be written to. */
  onTransfer?(target: TransferTarget): void;
}

/** The Private Space tree: folders and pages, in the order people gave them; drag and drop, keys and "Move to…". */
export function PrivateTree({ tree, current, open, setFolder, remapFolders, selection, onOrder, onTransfer }: Props) {
  const { vault, openPage, flushAll, refresh, tabs, servers, openSettings } = useSession();
  const directory = useSyncExternalStore(servers.subscribe, servers.getState);
  const canSend = directory.servers.some((s) => s.info.auth !== "signed-out" && (s.workspaces?.some((w) => roleCan(w.role, "write")) ?? false));
  const t = useDesktopStrings().shell;
  const tt = useStrings().tree;
  const ts = useDesktopStrings().transfer;
  const importFrom = useDesktopStrings().settings.importFrom;
  const favorites = useFavorites();
  const tf = useStrings().favorites;
  /** `path` is null for the menu of the empty area (the top level). */
  const [menu, setMenu] = useState<{ path: string | null; at: { x: number; y: number } } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Where the entry being renamed is after a successful rename: focus goes there. */
  const renamedTo = useRef<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Changes run one after another, each on the tree as the one before left it (a key held down repeats quickly).
  const latest = useRef(tree);
  latest.current = tree;
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = <T,>(job: () => Promise<T>): Promise<T> => {
    const run = chain.current.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0))).then(job);
    chain.current = run.catch(() => undefined);
    return run;
  };

  const find = (path: string): TreeNode | undefined => {
    const walk = (list: readonly TreeNode[]): TreeNode | undefined => {
      for (const node of list) {
        if (node.path === path) return node;
        if (node.kind === "folder" && path.startsWith(`${node.path}/`)) {
          const found = walk(node.children);
          if (found) return found;
        }
      }
      return undefined;
    };
    return walk(latest.current);
  };
  const label = (path: string) => {
    const node = find(path);
    return node ? (node.kind === "folder" ? node.name : node.title) : basename(path);
  };

  /**
   * Puts `from` into `folder` at `index` (among that folder's other items): a reorder when it is already there,
   * else a file move. Returns the reason it failed, or null.
   */
  const arrangeNow = async (from: string, folder: string, index: number): Promise<string | null> => {
    setError(null);
    try {
      if (!find(from)) return "";
      if (!(await flushAll())) return "";
      const name = basename(from);
      const siblings = childrenAt(latest.current, folder).map(nodeName).filter((n) => n !== name);
      const title = label(from);
      if (dirname(from) === folder) {
        const slot = Math.max(0, Math.min(index, siblings.length));
        onOrder(await reorderInFolder(vault, folder, name, siblings, slot));
        setSaid(tt.movedTo(title, slot + 1, siblings.length + 1));
        focusTreeItemSoon(from);
        return null;
      }
      const { to, order } = await moveIntoFolder(vault, from, folder, siblings, index);
      onOrder(order);
      if (find(from)?.kind === "folder") remapFolders(from, to);
      // Every tab on the page (or on a page in the folder) follows it, the way a rename does; a background tab would otherwise close as "gone".
      tabs.remapPaths(from, to);
      await refresh();
      setFolder(folder, true);
      setSaid(folder === "" ? tt.movedToTop(title) : tt.movedInto(title, label(folder)));
      focusTreeItemSoon(to);
      return null;
    } catch (failure) {
      const message = tt.moveFailed(failure instanceof Error ? failure.message : String(failure));
      setError(message);
      return message;
    }
  };
  const arrange = (from: string, folder: string, index: number) => enqueue(() => arrangeNow(from, folder, index));

  const stemOf = (node: TreeNode) => (node.kind === "folder" ? node.name : stripExtension(basename(node.path)));

  /**
   * Gives focus to a row once it is on screen (a renamed row has a new id, and the tree catches up a moment later).
   * `field` is the rename field that is going away: focus moves only while it is still in that field (or nowhere), so
   * a click or key press that went elsewhere in the meantime is left alone.
   */
  const restoreFocus = (id: string, field: Element | null) => {
    let tries = 0;
    const attempt = () => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== field) return;
      if (!focusTreeItem(id) && ++tries < 40) setTimeout(attempt, 30);
    };
    setTimeout(attempt, 0);
  };

  /**
   * Renames a page (its file name) or a folder, from the inline field. The field stays open with the reason when the
   * name is refused. Unsaved edits are written first, the open tabs follow, and the order entry keeps its place.
   */
  const commitRename = async (node: TreeNode, next: string): Promise<void> => {
    setError(null);
    if (!(await flushAll())) throw new RenameRejected(t.unsavedChanges);
    let renamed;
    try {
      renamed = await enqueue(() => renamePrivate(vault, node.path, next, { retitle: true }));
    } catch (failure) {
      if (failure instanceof RenameError) throw new RenameRejected(renameProblemText(failure.problem, tt));
      throw new RenameRejected(tt.renameFailed(failure instanceof Error ? failure.message : String(failure)));
    }
    onOrder(renamed.order);
    if (renamed.kind === "folder") remapFolders(renamed.from, renamed.to);
    tabs.remapPaths(renamed.from, renamed.to);
    renamedTo.current = renamed.to;
    await refresh();
    setSaid(tt.renamed(next));
    if (renamed.titleSkipped) setError(t.titleNotUpdated(next));
  };
  const endRename = (node: TreeNode) => {
    const active = document.activeElement;
    const field = active instanceof HTMLInputElement && active.classList.contains("tree-rename") ? active : null;
    setRenaming(null);
    restoreFocus(renamedTo.current ?? node.path, field);
    renamedTo.current = null;
  };

  /** Creates an empty folder in `parent` ("" is the top level), shows it and puts it into rename. */
  const newFolder = (parent: string) =>
    enqueue(async () => {
      setError(null);
      try {
        const path = await vault.createUniqueFolder(parent, t.untitledFolder);
        if (parent !== "") setFolder(parent, true);
        setRenaming(path);
        setSaid(t.folderCreated(basename(path)));
        await refresh();
      } catch (failure) {
        setError(tt.newFolderFailed(failure instanceof Error ? failure.message : String(failure)));
      }
    });

  /** The folder a "New folder" without a place goes into: the one the tree has focus in, else the top level. */
  const contextFolder = (): string => {
    const id = document.activeElement?.closest<HTMLElement>("[data-tree-id]")?.dataset["treeId"];
    const node = id !== undefined ? find(id) : undefined;
    return node ? (node.kind === "folder" ? node.path : dirname(node.path)) : "";
  };

  // "New folder" asked for from code (the shortcut, the command palette, the sidebar button).
  const folderRequest = usePendingNewFolder();
  useEffect(() => {
    if (!folderRequest) return;
    clearNewFolder();
    void newFolder(folderRequest.parent ?? contextFolder());
    // `newFolder` reads the current tree; the request is what triggers this.
  }, [folderRequest]);

  const reorder = (node: TreeNode, delta: -1 | 1) =>
    void enqueue(async () => {
      const folder = dirname(node.path);
      const list = childrenAt(latest.current, folder);
      const i = list.findIndex((n) => n.path === node.path);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return null;
      return arrangeNow(node.path, folder, j);
    });

  const target = (over: string, zone: DropZone): string => (zone === "inside" ? over : dirname(over));
  const dnd = useTreeDnd({
    enabled: !selection.active,
    canContain: (id) => id !== TOP && find(id)?.kind === "folder",
    onlyInside: (id) => id === TOP,
    firstChild: (id) => {
      const node = id === TOP ? undefined : find(id);
      return node?.kind === "folder" && open.has(node.path) ? (node.children[0]?.path ?? null) : null;
    },
    canOrder: true,
    canDrop: (drag, over, zone) => {
      if (over === drag) return false;
      if (over === TOP) return dirname(drag) !== "";
      const folder = target(over, zone);
      return folder !== drag && !folder.startsWith(`${drag}/`) && find(over) !== undefined;
    },
    onDrop: (drag, over, zone) => {
      if (over === TOP) return void arrange(drag, "", END);
      if (zone === "inside") return void arrange(drag, over, END);
      const folder = dirname(over);
      const rest = childrenAt(latest.current, folder).filter((n) => n.path !== drag);
      const index = rest.findIndex((n) => n.path === over) + (zone === "after" ? 1 : 0);
      // Dropped where it already is: nothing to write.
      if (dirname(drag) === folder && childrenAt(latest.current, folder).findIndex((n) => n.path === drag) === index) return;
      void arrange(drag, folder, index);
    },
    onHoverOpen: (id) => id !== TOP && setFolder(id, true),
    // Across spaces (ADR-0006, amendment of 2026-10-26): a page (or the selection it is in) or a folder's pages go
    // to a workspace; a workspace page lands in the folder under the pointer, or the folder of the page under it.
    carry: (path): SpaceDrag | null => {
      const node = find(path);
      if (!node) return null;
      if (node.kind === "page") {
        const ids = selection.active && selection.paths.has(path) ? [...selection.paths].sort() : [path];
        return { from: PRIVATE_SPACE, row: path, ids, title: node.title };
      }
      const ids = pagesIn(node);
      return ids.length === 0 ? null : { from: PRIVATE_SPACE, row: path, ids, title: node.name, base: dirname(path) };
    },
    across: (drag, id, move) => {
      const node = id === TOP ? undefined : find(id);
      const folder = node === undefined ? "" : node.kind === "folder" ? node.path : dirname(node.path);
      return privateAcross(servers, drag, folder, folder === "" ? null : folder, move, tt.across);
    },
  });

  // "Move to…" asked for from code (the command palette).
  const request = usePendingMoveTo(isPrivate);
  useEffect(() => {
    if (!request) return;
    clearMoveTo();
    if (find(request.path)) setMoving(request.path);
    // `find` reads the current tree; the request is what triggers this.
  }, [request]);

  // "Move page up / down" asked for from code (the command palette): the same change as Alt+Shift+Up and Down.
  const reorderRequest = usePendingReorder(isPrivateReorder);
  useEffect(() => {
    if (!reorderRequest) return;
    clearReorder();
    const node = find(reorderRequest.path);
    if (node) reorder(node, reorderRequest.delta);
    // `find` and `reorder` read the current tree; the request is what triggers this.
  }, [reorderRequest]);

  const menuItems = (node: TreeNode): MenuItem[] => {
    const list = childrenAt(tree, dirname(node.path));
    const i = list.findIndex((n) => n.path === node.path);
    const ref = { kind: "private" as const, path: node.path };
    return [
      ...(node.kind === "page" && favorites ? [{ id: "favorite", label: favorites.has(ref) ? tf.remove : tf.add, onSelect: () => favorites.toggle(ref) }] : []),
      { id: "rename", label: tt.rename, hint: "F2", onSelect: () => setRenaming(node.path) },
      ...(node.kind === "folder" ? [{ id: "new-folder", label: tt.newFolderInside, onSelect: () => void newFolder(node.path) }] : []),
      { id: "up", label: tt.moveUp, hint: "⌥⇧↑", disabled: i <= 0, onSelect: () => reorder(node, -1) },
      { id: "down", label: tt.moveDown, hint: "⌥⇧↓", disabled: i < 0 || i >= list.length - 1, onSelect: () => reorder(node, 1) },
      { id: "move", label: tt.moveTo, onSelect: () => setMoving(node.path) },
      ...(onTransfer && canSend ? sendItems(node, onTransfer) : []),
    ];
  };

  /** Copy or move a page, or a folder's pages (the folder travels too), to a workspace: the dialog picks which one. */
  const sendItems = (node: TreeNode, send: (target: TransferTarget) => void): MenuItem[] => {
    const paths = pagesIn(node);
    if (paths.length === 0) return [];
    const base = node.kind === "folder" ? { base: dirname(node.path) } : {};
    return [
      { id: "copy-to-workspace", label: ts.copyTo, onSelect: () => send({ direction: "to_workspace", paths, mode: "copy", ...base }) },
      { id: "move-to-workspace", label: ts.moveTo, onSelect: () => send({ direction: "to_workspace", paths, mode: "move", ...base }) },
    ];
  };

  const destinations = (path: string): Destination[] => [
    { id: "", label: tt.moveDialog.topLevel, depth: 0, folder: false },
    ...listFolders(tree)
      .filter((f) => f.path !== path && !f.path.startsWith(`${path}/`))
      .map((f) => ({ id: f.path, label: f.name, depth: f.depth + 1, folder: true })),
  ];

  const row = (node: TreeNode, depth: number, index: number, size: number) => {
    const indent = { paddingLeft: 8 + depth * 14 };
    const common = { "data-tree-id": node.path, "aria-level": depth + 1, "aria-posinset": index, "aria-setsize": size } as const;
    const keys = (event: KeyboardEvent<HTMLElement>) =>
      treeKeyDown(event, {
        expandable: node.kind === "folder",
        expanded: open.has(node.path),
        expand: () => setFolder(node.path, true),
        collapse: () => setFolder(node.path, false),
        ...(selection.active ? {} : { rename: () => setRenaming(node.path) }),
        reorder: (delta) => reorder(node, delta),
        menu: () => {
          const r = event.currentTarget.getBoundingClientRect();
          setMenu({ path: node.path, at: { x: r.left + 16, y: r.bottom } });
        },
      });
    const onContextMenu = (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      setMenu({ path: node.path, at: { x: event.clientX, y: event.clientY } });
    };

    if (renaming === node.path && !selection.active) {
      const field = (
        <RenameInput value={stemOf(node)} label={tt.renameLabel(stemOf(node))} maxLength={NAME_MAX} emptyMessage={tt.renameDialog.empty} onCommit={(next) => commitRename(node, next)} onDone={() => endRename(node)} />
      );
      if (node.kind === "page") {
        return (
          <li role="none" key={`page:${node.path}`}>
            <div role="treeitem" aria-selected={node.path === current} className="tree-item tree-renaming" data-kind="page" style={indent} {...common}>
              <Disclosure open={false} hidden />
              <PageIcon />
              {field}
            </div>
          </li>
        );
      }
      const open_ = open.has(node.path);
      return (
        <li role="none" key={`folder:${node.path}`}>
          <div role="treeitem" aria-expanded={open_} className="tree-item tree-folder tree-renaming" data-kind="folder" style={indent} {...common}>
            <Disclosure open={open_} />
            <FolderIcon open={open_} />
            {field}
          </div>
          {open_ && (
            <ul role="group">
              {node.children.map((child, i) => row(child, depth + 1, i + 1, node.children.length))}
            </ul>
          )}
        </li>
      );
    }

    if (node.kind === "page") {
      const checked = selection.paths.has(node.path);
      if (selection.active) {
        // While selecting, the row is a checkbox: Space toggles it, the tree keeps its keyboard order.
        return (
          <li role="none" key={`page:${node.path}`}>
            <label className="tree-item" style={indent} title={node.path} {...tipIfClipped(node.title)} data-dragging={dnd.dragging === node.path || undefined} {...dnd.rowProps(node.path)}>
              <input type="checkbox" className="tree-select" checked={checked} onChange={() => selection.toggle(node.path)} aria-label={ts.selectPage(node.title)} />
              <span className="tree-label">{node.title}</span>
            </label>
          </li>
        );
      }
      return (
        <li role="none" key={`page:${node.path}`}>
          <button
            type="button"
            role="treeitem"
            aria-selected={node.path === current}
            aria-current={node.path === current ? "page" : undefined}
            {...common}
            className="tree-item"
            data-kind="page"
            data-dragging={dnd.dragging === node.path || undefined}
            style={indent}
            onClick={(event) => openPage(node.path, clickOpens(event))}
            onAuxClick={(event) => {
              if (!isMiddleClick(event)) return;
              event.preventDefault();
              openPage(node.path, { newTab: true });
            }}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && isOpenInNewTabKey(event)) {
                event.preventDefault();
                openPage(node.path, { newTab: true });
                return;
              }
              keys(event);
            }}
            onContextMenu={onContextMenu}
            title={node.path}
            {...tipIfClipped(node.title)}
            {...dnd.rowProps(node.path)}
          >
            <Disclosure open={false} hidden />
            <PageIcon />
            <span className="tree-label">{node.title}</span>
          </button>
        </li>
      );
    }
    const expanded = open.has(node.path);
    return (
      <li role="none" key={`folder:${node.path}`}>
        <button
          type="button"
          role="treeitem"
          aria-expanded={expanded}
          {...common}
          className="tree-item tree-folder"
          data-kind="folder"
          data-dragging={dnd.dragging === node.path || undefined}
          style={indent}
          title={`${tt.folder} · ${tt.itemCount(node.children.length)}`}
          {...tipIfClipped(node.name)}
          onClick={() => setFolder(node.path)}
          onKeyDown={keys}
          onContextMenu={onContextMenu}
          {...dnd.rowProps(node.path)}
        >
          <Disclosure open={expanded} />
          <FolderIcon open={expanded} />
          <span className="tree-label">{node.name}</span>
        </button>
        <TreeGroup open={expanded} count={node.children.length}>
          {node.children.map((child, i) => row(child, depth + 1, i + 1, node.children.length))}
        </TreeGroup>
      </li>
    );
  };

  const { draggable: _draggable, onDragStart: _onDragStart, ...topDrop } = dnd.rowProps(TOP);
  const movingNode = moving ? find(moving) : undefined;
  const menuNode = menu?.path != null ? find(menu.path) : undefined;

  return (
    <div
      className="private-tree"
      onContextMenu={(event) => {
        // A row has already opened its own menu; this is the empty area around the rows.
        if (event.defaultPrevented) return;
        event.preventDefault();
        setMenu({ path: null, at: { x: event.clientX, y: event.clientY } });
      }}
    >
      {tree.length === 0 ? (
        <div className="muted tree-empty">
          <p>{t.noPages}</p>
          <Button variant="ghost" small onClick={() => openSettings("import")}>
            {importFrom}
          </Button>
        </div>
      ) : (
        <TreeList label={t.pagesInSpace} multiselectable={selection.active}>
          {tree.map((node, i) => row(node, 0, i + 1, tree.length))}
          {dnd.dragging !== null && dirname(dnd.dragging) !== "" && (
            <li role="none" className="tree-root-drop" {...topDrop}>
              {tt.moveDialog.topLevel}
            </li>
          )}
        </TreeList>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-tree-said>
        {said}
      </div>
      {error && (
        <p role="alert" className="tree-note tree-error">
          {error}
        </p>
      )}
      {menu && menu.path === null && (
        <ContextMenu label={t.pagesInSpace} at={menu.at} items={[{ id: "new-folder", label: t.newFolder, onSelect: () => void newFolder("") }]} onClose={() => setMenu(null)} />
      )}
      {menu && menuNode && (
        <ContextMenu
          label={tt.menuLabel(label(menuNode.path))}
          at={menu.at}
          items={menuItems(menuNode)}
          onClose={(restoreFocus) => {
            setMenu(null);
            if (restoreFocus) focusTreeItemSoon(menuNode.path);
          }}
        />
      )}
      {movingNode && (
        <MoveToDialog
          name={label(movingNode.path)}
          destinations={destinations(movingNode.path)}
          initial={dirname(movingNode.path)}
          onMove={(folder) => arrange(movingNode.path, folder, END)}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  );
}
