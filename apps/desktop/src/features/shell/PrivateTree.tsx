import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { basename, dirname } from "@thoth/domain";
import type { OrderRecord } from "@thoth/local-store";
import { ContextMenu, type MenuItem } from "@thoth/app-ui/order/ContextMenu.tsx";
import { useTreeDnd, type DropZone } from "@thoth/app-ui/order/dnd.ts";
import { Disclosure, FolderIcon, PageIcon } from "@thoth/app-ui/order/icons.tsx";
import { MoveToDialog, type Destination } from "@thoth/app-ui/order/MoveToDialog.tsx";
import { clearMoveTo, usePendingMoveTo, type MoveToRequest } from "@thoth/app-ui/order/move-to.ts";
import { clearReorder, usePendingReorder, type ReorderRequest } from "@thoth/app-ui/order/reorder-request.ts";
import { TreeGroup } from "@thoth/app-ui/order/TreeGroup.tsx";
import { TreeList } from "@thoth/app-ui/order/TreeList.tsx";
import { focusTreeItemSoon, treeKeyDown } from "@thoth/app-ui/order/tree-keys.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { clickOpens, isMiddleClick, isOpenInNewTabKey } from "@thoth/app-ui/tabs/open-keys.ts";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { moveIntoFolder, reorderInFolder } from "./arrange.ts";
import { childrenAt, listFolders, nodeName, type TreeNode } from "./tree.ts";

export interface Selection {
  active: boolean;
  paths: ReadonlySet<string>;
  toggle(path: string): void;
}

/** The drop target for the top level, shown as a strip under the tree while something is dragged. */
const TOP = "\u0000top";
const END = 1_000_000;
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
}

/** The Private Space tree: folders and pages, in the order people gave them; drag and drop, keys and "Move to…". */
export function PrivateTree({ tree, current, open, setFolder, remapFolders, selection, onOrder }: Props) {
  const { vault, openPage, flushAll, refresh } = useSession();
  const t = useDesktopStrings().shell;
  const tt = useStrings().tree;
  const ts = useDesktopStrings().transfer;
  const [menu, setMenu] = useState<{ path: string; at: { x: number; y: number } } | null>(null);
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
      await refresh();
      setFolder(folder, true);
      if (current && (current === from || current.startsWith(`${from}/`))) openPage(to + current.slice(from.length));
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
    return [
      { id: "up", label: tt.moveUp, hint: "⌥⇧↑", disabled: i <= 0, onSelect: () => reorder(node, -1) },
      { id: "down", label: tt.moveDown, hint: "⌥⇧↓", disabled: i < 0 || i >= list.length - 1, onSelect: () => reorder(node, 1) },
      { id: "move", label: tt.moveTo, onSelect: () => setMoving(node.path) },
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

    if (node.kind === "page") {
      const checked = selection.paths.has(node.path);
      if (selection.active) {
        // While selecting, the row is a checkbox: Space toggles it, the tree keeps its keyboard order.
        return (
          <li role="none" key={`page:${node.path}`}>
            <label className="tree-item" style={indent} title={node.path}>
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

  return (
    <>
      <TreeList label={t.pagesInSpace} multiselectable={selection.active}>
        {tree.map((node, i) => row(node, 0, i + 1, tree.length))}
        {dnd.dragging !== null && dirname(dnd.dragging) !== "" && (
          <li role="none" className="tree-root-drop" {...topDrop}>
            {tt.moveDialog.topLevel}
          </li>
        )}
      </TreeList>
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-tree-said>
        {said}
      </div>
      {error && (
        <p role="alert" className="tree-note tree-error">
          {error}
        </p>
      )}
      {menu && find(menu.path) && (
        <ContextMenu
          label={tt.menuLabel(label(menu.path))}
          at={menu.at}
          items={menuItems(find(menu.path)!)}
          onClose={(restoreFocus) => {
            setMenu(null);
            if (restoreFocus) focusTreeItemSoon(menu.path);
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
    </>
  );
}
