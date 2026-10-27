import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { PageSummary } from "@thoth/domain";
import { emptyOrder, readOrder, type OrderRecord } from "@thoth/local-store";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { NotificationBell } from "@thoth/app-ui/notifications/NotificationBell.tsx";
import { IconButton } from "@thoth/app-ui/ui/IconButton.tsx";
import { Mark } from "@thoth/app-ui/ui/Mark.tsx";
import { useAcrossDropZone } from "@thoth/app-ui/order/dnd.ts";
import { onSpaceDrop, useSpaceHoverAt } from "@thoth/app-ui/order/space-drag.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { useSession } from "../../app/context.ts";
import { privateAcross } from "./space-drop.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { ancestorFolders, buildTree } from "./tree.ts";
import { PrivateTree, type Selection } from "./PrivateTree.tsx";
import { useServerSections } from "../servers/ServersSidebar.tsx";
import { SidebarSections, type SidebarSection } from "./SidebarSections.tsx";
import { FAVORITES_SECTION, PRIVATE_SECTION } from "./sections.ts";
import { FavoritesList } from "@thoth/app-ui/favorites/FavoritesList.tsx";
import type { FavoritesController } from "../favorites/useFavoritesController.ts";
import { useAgentsSection } from "../agents/AgentsSidebar.tsx";
import { pendingCleanups } from "../transfer/service.ts";
import type { WorkspacePageRef } from "@thoth/app-ui/workspace/directory.ts";
import type { TransferTarget } from "../transfer/TransferDialog.tsx";

interface Props {
  /** The Favorites (ADR-0027): their section is first by default, and hidden while there are none. */
  favorites?: FavoritesController;
  pages: PageSummary[];
  current: string | null;
  /** The open workspace page, if any. */
  currentRemote?: WorkspacePageRef | null;
  /** The run of the current tab, if it is an assistant session. */
  currentRun?: string | null;
  onSearch(): void;
  onNewPage(): void;
  /** Creates a folder in the Private Space (inside the folder the tree has focus in, else at the top level). */
  onNewFolder(): void;
  /** Opens the copy/move dialog for the selected pages. */
  onTransfer(target: TransferTarget): void;
  /** Whether the notification list under the bell is open (the palette opens it too). */
  notificationsOpen: boolean;
  onNotificationsOpen(open: boolean): void;
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

/**
 * The sidebar: the brand row and search at the top and the actions at the bottom, which stay put, and between them the
 * sections in the order the person chose (SidebarSections.tsx): the Private Space's page tree with its Local badge, and
 * one section per workspace server.
 */
export function Sidebar({ favorites, pages, current, currentRemote = null, currentRun = null, onSearch, onNewPage, onNewFolder, onTransfer, notificationsOpen, onNotificationsOpen }: Props) {
  const { connection, reveal, openSettings, vault, agents, askAssistant, notifications, openNotification, servers } = useSession();
  const t = useDesktopStrings().shell;
  const ttree = useStrings().tree;
  const tt = useDesktopStrings().transfer;
  const ta = useDesktopStrings().agents;
  const importFrom = useDesktopStrings().settings.importFrom;
  // The order people gave (`.thoth/order.json`) and the folders that hold no page; A–Z when there is none.
  const [order, setOrder] = useState<OrderRecord>(() => emptyOrder());
  const [emptyFolders, setEmptyFolders] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void Promise.all([readOrder(vault), vault.listFolders().catch(() => [] as string[])]).then(([record, folders]) => {
      if (!live) return;
      setOrder(record);
      setEmptyFolders(folders);
    });
    return () => {
      live = false;
    };
  }, [vault, pages]);
  const tree = useMemo(() => buildTree(pages, { folders: emptyFolders, order }), [pages, emptyFolders, order]);
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

  /** Opens (true), closes (false) or flips a folder. */
  const setFolder = useCallback(
    (path: string, force?: boolean) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (force === true || (force === undefined && !next.has(path))) next.add(path);
        else next.delete(path);
        return next.size === prev.size && [...next].every((p) => prev.has(p)) ? prev : next;
      }),
    [],
  );
  /** A folder moved: it and the folders in it stay open under their new paths. */
  const remapFolders = useCallback(
    (from: string, to: string) =>
      setOpen((prev) => new Set([...prev].map((p) => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p))),
      ),
    [],
  );
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
  const askAgent = () => {
    const paths = [...picked].sort();
    setSelecting(false);
    setPicked(new Set());
    askAssistant(paths);
  };
  const transfer = (mode: "copy" | "move") => {
    const paths = [...picked].sort();
    setSelecting(false);
    setPicked(new Set());
    onTransfer({ direction: "to_workspace", paths, mode });
  };
  // Pages dragged out of the Private Space end the selection, as the Copy and Move buttons do.
  useEffect(
    () =>
      onSpaceDrop((drop) => {
        if (drop.drag.from.kind !== "private") return;
        setSelecting(false);
        setPicked(new Set());
      }),
    [],
  );

  // The header is where a workspace page goes to the Private Space's top level (ADR-0006, amendment of 2026-10-26).
  const rootDrop = useAcrossDropZone((drag, move) => privateAcross(servers, drag, "", null, move, ttree.across));
  const rootLit = useSpaceHoverAt((to) => to.kind === "private" && to.folder === "");

  const privateSection: SidebarSection = {
    id: PRIVATE_SECTION,
    name: connection.label,
    label: t.privateSection(connection.label),
    title: connection.root,
    drop: rootDrop,
    dropLit: rootLit,
    actions: (
      <>
        {pages.length > 0 && (
          <IconButton icon={selecting ? "done" : "select"} label={selecting ? tt.selectDone : tt.select} aria-pressed={selecting} onClick={() => (selecting ? setSelecting(false) : startSelecting())} />
        )}
        <span className="badge badge-private">{t.local}</span>
      </>
    ),
    children: (
      <>
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
              {agents && (
                <Button variant="ghost" small disabled={picked.size === 0} onClick={askAgent}>
                  {ta.askAgent}
                </Button>
              )}
            </div>
          </div>
        )}
        <PrivateTree tree={tree} current={current} open={open} setFolder={setFolder} remapFolders={remapFolders} selection={selection} onOrder={setOrder} onTransfer={onTransfer} />
      </>
    ),
  };
  const tf = useStrings().favorites;
  const favoritesSection: SidebarSection | null =
    favorites && favorites.items.length > 0
      ? {
          id: FAVORITES_SECTION,
          name: tf.section,
          label: tf.section,
          children: <FavoritesList items={favorites.items} onOpen={favorites.open} onMove={favorites.move} onRemove={favorites.remove} scroller={() => document.querySelector<HTMLElement>(".sidebar .tree-wrap")} />,
        }
      : null;
  const serverSections = useServerSections(currentRemote, onTransfer);
  const agentsSection = useAgentsSection(currentRun);

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
      <nav aria-label={t.pages} className="tree-wrap">
        <SidebarSections root={connection.root} sections={[...(favoritesSection ? [favoritesSection] : []), privateSection, ...serverSections, ...(agentsSection ? [agentsSection] : [])]} />
      </nav>
      <PendingTransfers />
      <div className="side-actions">
        <IconButton icon="page-plus" label={t.newPage} shortcut="page.new" onClick={onNewPage} />
        <IconButton icon="folder-plus" label={t.newFolder} shortcut="folder.new" onClick={onNewFolder} />
        <IconButton icon="import" label={importFrom} onClick={() => openSettings("import")} />
        <span className="side-end">
          <NotificationBell center={notifications} open={notificationsOpen} onOpenChange={onNotificationsOpen} onOpenTarget={openNotification} />
          <IconButton icon="gear" label={t.settings} shortcut="settings.open" onClick={() => openSettings()} />
        </span>
      </div>
    </aside>
  );
}
