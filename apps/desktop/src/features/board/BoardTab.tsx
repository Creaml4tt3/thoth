/**
 * A Board tab (ADR-0056): the Overview of every page (`path` undefined) or one `.canvas` board, with a small header
 * (board switcher, New board, Add note on a board, tag and folder filters on the Overview) above the BoardView.
 *
 * - Data: `vault.graph()` and the folder colours, read again whenever the index revision changes; a board's file too,
 *   while no save is pending (another app may have changed it). A board that is gone or cannot be read says so and is
 *   never written.
 * - Saving: moves, pins and removals show at once and are queued; 500 ms after the last one they are written in one
 *   `boardStore.save` (which merges once on a conflict). A failed save says so and reads the file again. Leaving the tab
 *   writes what is still queued.
 * - Undo/redo covers moves, pins, removals and drawn links for the tab's life. After a drawn link is written or undone
 *   the session is refreshed, so an open editor of the source page is not left stale.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { basename, dirname, stripExtension } from "@thoth/domain";
import { NotFoundError, readOrder } from "@thoth/local-store";
import { BoardView, NOTE_H, NOTE_W, type BoardActions } from "@thoth/app-ui/board/BoardView.tsx";
import { applyChanges, CanvasError, newNodeId, pinnedPaths, type BoardChange, type CanvasFile, type CanvasNode } from "@thoth/app-ui/board/canvas.ts";
import { createHistory } from "@thoth/app-ui/board/history.ts";
import { layoutOverviewAsync } from "@thoth/app-ui/board/layout.ts";
import { boardNotes, overviewNotes, type Graph } from "@thoth/app-ui/board/model.ts";
import { shellRoot } from "@thoth/app-ui/order/ContextMenu.tsx";
import { focusTreeItem } from "@thoth/app-ui/order/tree-keys.ts";
import { useStrings } from "@thoth/app-ui/strings/index.ts";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { useSession } from "../../app/context.ts";
import { RenameError, renameProblemText } from "../shell/rename.ts";
import { targetFolder } from "../shell/target-folder.ts";
import { boardStore, type Board } from "./board-store.ts";
import { drawLink } from "./draw-link.ts";

const SAVE_MS = 500;
type Point = { x: number; y: number };

/**
 * Overview positions (top-left corners) for the session, per Private Space: laid out again only when the set of pages
 * changes, and then pages that had a place keep it.
 */
const overviewCache = new Map<string, { key: string; positions: Map<string, Point> }>();

const stem = (path: string) => stripExtension(basename(path));

type Loaded = { kind: "loading" } | { kind: "ready"; canvas: CanvasFile } | { kind: "gone" } | { kind: "invalid" };

export function BoardTab({ path }: { path?: string | undefined }) {
  const { vault, connection, revision, refresh, flushAll, openPage, openFolder, tabs } = useSession();
  const strings = useStrings();
  const t = strings.board;
  const store = useMemo(() => boardStore(vault), [vault]);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [boards, setBoards] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<"new" | "add" | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([vault.graph(), readOrder(vault), store.list()]).then(
      ([g, order, list]) => {
        if (!live) return;
        setGraph(g);
        setColors(order.colors ?? {});
        setBoards(list);
      },
      () => undefined, // the vault may have closed while this was in flight
    );
    return () => {
      live = false;
    };
  }, [vault, store, revision]);

  // ---------------------------------------------------------------- a board: its file, the save queue, history
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const base = useRef<Board | null>(null);
  const queue = useRef<BoardChange[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inflight = useRef(0);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const [history] = useState(() => createHistory());
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  const show = (canvas: CanvasFile) => live.current && setLoaded({ kind: "ready", canvas });
  const reread = () => {
    if (path === undefined) return;
    void store.read(path).then(
      (board) => {
        base.current = board;
        show(applyChanges(board.canvas, queue.current));
      },
      (error: unknown) => {
        base.current = null;
        if (!live.current) return;
        if (error instanceof NotFoundError) setLoaded({ kind: "gone" });
        else if (error instanceof CanvasError) setLoaded({ kind: "invalid" });
        else setMessage(error instanceof Error ? error.message : String(error));
      },
    );
  };
  useEffect(reread, [path, store]); // eslint-disable-line react-hooks/exhaustive-deps
  // Another app may have changed the file: read it again, unless Thoth has something of its own still to write.
  const seen = useRef(revision);
  useEffect(() => {
    if (seen.current === revision) return;
    seen.current = revision;
    if (timer.current === undefined && inflight.current === 0 && queue.current.length === 0) reread();
  }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Writes what is queued, after any save still running (each save starts from the base the one before left). */
  const flush = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (path === undefined || queue.current.length === 0) return;
    const changes = queue.current.splice(0);
    inflight.current++;
    saving.current = saving.current.then(async () => {
      try {
        if (!base.current) throw new Error(t.saveFailed);
        base.current = await store.save(path, base.current, changes);
      } catch {
        if (live.current) setMessage(t.saveFailed);
        reread();
      } finally {
        inflight.current--;
      }
    });
  };
  // Leaving the tab writes what is queued: fired, not dropped.
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const canvasNow = (): CanvasFile | null => (loaded.kind === "ready" ? loaded.canvas : null);
  const latest = useRef<CanvasFile | null>(null);
  latest.current = canvasNow();
  /** Shows a change at once and queues it; the save waits for 500 ms of quiet. */
  const change = (ch: BoardChange) => {
    const now = latest.current;
    if (!now) return;
    queue.current.push(ch);
    latest.current = applyChanges(now, [ch]);
    show(latest.current);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_MS);
  };
  const nodeOf = (file: string): CanvasNode | undefined => latest.current?.nodes.find((n) => n.type === "file" && n.file === file);

  const pinNode = (node: CanvasNode) => {
    change({ kind: "pin", node });
    history.push({ undo: () => change({ kind: "unpin", id: node.id }), redo: () => change({ kind: "pin", node }) });
  };

  // ---------------------------------------------------------------- the Overview's layout
  const [positions, setPositions] = useState<Map<string, Point> | null>(null);
  const pagesKey = useMemo(() => (graph ? graph.pages.map((p) => p.path).join("\n") : null), [graph]);
  useEffect(() => {
    if (path !== undefined || !graph || pagesKey === null) return;
    const cached = overviewCache.get(connection.root);
    if (cached?.key === pagesKey) return setPositions(cached.positions);
    let current = true;
    void layoutOverviewAsync(graph.pages, graph.links).then((centres) => {
      // The one place centres become top-left corners.
      const next = new Map<string, Point>();
      for (const [p, c] of centres) next.set(p, cached?.positions.get(p) ?? { x: c.x - NOTE_W / 2, y: c.y - NOTE_H / 2 });
      overviewCache.set(connection.root, { key: pagesKey, positions: next });
      if (current) setPositions(next);
    });
    return () => {
      current = false;
    };
  }, [path, pagesKey, connection.root]); // eslint-disable-line react-hooks/exhaustive-deps

  const [tag, setTag] = useState("");
  const [folder, setFolder] = useState("");
  const tags = useMemo(() => [...new Set(graph?.pages.flatMap((p) => p.tags) ?? [])].sort((a, b) => a.localeCompare(b)), [graph]);
  const folders = useMemo(() => [...new Set(graph?.pages.map((p) => dirname(p.path)).filter(Boolean) ?? [])].sort((a, b) => a.localeCompare(b)), [graph]);

  const shown = useMemo(() => {
    if (!graph) return null;
    if (path === undefined) {
      if (!positions) return null;
      const pages = graph.pages.filter((p) => (tag === "" || p.tags.includes(tag)) && (folder === "" || p.path === folder || p.path.startsWith(`${folder}/`)));
      return overviewNotes({ pages, links: graph.links }, colors, positions);
    }
    return loaded.kind === "ready" ? boardNotes(graph, loaded.canvas, colors) : null;
  }, [graph, path, positions, tag, folder, colors, loaded]);

  // ---------------------------------------------------------------- actions
  const actions: BoardActions = {
    open: (page, options) => openPage(page, options),
    reveal: (page) => {
      openFolder(dirname(page), { openFirstPage: false });
      // shortcut: the row appears once the sidebar re-renders; one late try, retry if this proves flaky.
      setTimeout(() => focusTreeItem(page), 50);
    },
    drawLink: async (from, to) => {
      const r = await drawLink(vault, flushAll, from, to);
      if (r.outcome === "linked" && r.undo) {
        await refresh([from]);
        let undo = r.undo;
        history.push({
          undo: async () => {
            if ((await undo()) === "changed") return void setMessage(t.undoLinkEdited);
            await refresh([from]);
          },
          redo: async () => {
            const again = await drawLink(vault, flushAll, from, to);
            if (again.undo) undo = again.undo;
            if (again.outcome === "linked") await refresh([from]);
          },
        });
      }
      return r.outcome;
    },
    undo: () => void history.undo().catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e))),
    redo: () => void history.redo().catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e))),
  };
  if (path !== undefined && loaded.kind === "ready") {
    actions.move = (page, x, y) => {
      const node = nodeOf(page);
      if (!node) return;
      const from = { x: node.x, y: node.y };
      change({ kind: "move", id: node.id, x, y });
      history.push({ undo: () => change({ kind: "move", id: node.id, ...from }), redo: () => change({ kind: "move", id: node.id, x, y }) });
    };
    actions.pin = (page) => {
      const at = shown?.notes.find((n) => n.path === page) ?? { x: 0, y: 0 };
      pinNode({ id: newNodeId(), type: "file", file: page, x: at.x, y: at.y, width: NOTE_W, height: NOTE_H });
    };
    actions.unpin = (page) => {
      const node = nodeOf(page);
      if (!node) return;
      change({ kind: "unpin", id: node.id });
      history.push({ undo: () => change({ kind: "pin", node }), redo: () => change({ kind: "unpin", id: node.id }) });
    };
  }

  /** Add note: to the right of everything on the board (simple, and never on top of a note). */
  const addNote = (page: string) => {
    setDialog(null);
    const nodes = latest.current?.nodes ?? [];
    const x = nodes.length ? Math.max(...nodes.map((n) => n.x + n.width)) + 40 : 0;
    const y = nodes.length ? Math.min(...nodes.map((n) => n.y)) : 0;
    pinNode({ id: newNodeId(), type: "file", file: page, x, y, width: NOTE_W, height: NOTE_H });
  };

  const createBoard = async (name: string): Promise<string | null> => {
    try {
      const made = await store.create(targetFolder(), name);
      await refresh([made]);
      setDialog(null);
      tabs.open({ kind: "board", path: made });
      return null;
    } catch (error) {
      return error instanceof RenameError ? renameProblemText(error.problem, strings.tree) : error instanceof Error ? error.message : String(error);
    }
  };

  // ---------------------------------------------------------------- render
  const switcherId = useId();
  const listed = [...new Set([...boards, ...(path !== undefined ? [path] : [])])].sort((a, b) => stem(a).localeCompare(stem(b)) || a.localeCompare(b));
  const pinned = loaded.kind === "ready" ? new Set(pinnedPaths(loaded.canvas)) : new Set<string>();
  const label = path === undefined ? t.overview : stem(path);

  return (
    <div className="board-tab">
      <div className="board-header">
        {/* Native selects for now: the Thoth Select (parallel work) replaces every native select. */}
        <label className="board-field" htmlFor={switcherId}>
          <span className="sr-only">{t.switcher}</span>
          <select id={switcherId} className="input" value={path ?? ""} onChange={(e) => tabs.open(e.target.value === "" ? { kind: "board" } : { kind: "board", path: e.target.value })}>
            <option value="">{t.overview}</option>
            {listed.map((b) => (
              <option key={b} value={b} title={b}>
                {stem(b)}
              </option>
            ))}
          </select>
        </label>
        <Button small onClick={() => setDialog("new")}>
          {t.newBoard}
        </Button>
        {path !== undefined && loaded.kind === "ready" && (
          <Button small onClick={() => setDialog("add")}>
            {t.addNote}
          </Button>
        )}
        {path === undefined && (
          <>
            <select className="input" aria-label={t.filterTag} value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">{t.allTags}</option>
              {tags.map((x) => (
                <option key={x} value={x}>
                  #{x}
                </option>
              ))}
            </select>
            <select className="input" aria-label={t.filterFolder} value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">{t.allFolders}</option>
              {folders.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </>
        )}
        <span className="board-message" role="status">
          {message}
        </span>
      </div>
      {loaded.kind === "gone" && path !== undefined ? (
        <p className="board-empty">{t.gone}</p>
      ) : loaded.kind === "invalid" && path !== undefined ? (
        <p className="board-empty">{t.invalid}</p>
      ) : (
        <>
          {shown && shown.notes.length === 0 && <p className="board-empty">{path === undefined ? t.emptyOverview : t.empty}</p>}
          <BoardView label={label} notes={shown?.notes ?? []} strings={shown?.strings ?? []} actions={actions} />
        </>
      )}
      {dialog === "new" && <NewBoardDialog onCreate={createBoard} onClose={() => setDialog(null)} />}
      {dialog === "add" && graph && <AddNoteDialog pages={graph.pages.filter((p) => !pinned.has(p.path))} onChoose={addNote} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** New board: a name, created in the sidebar's selected folder. */
function NewBoardDialog({ onCreate, onClose }: { onCreate(name: string): Promise<string | null>; onClose(): void }) {
  const t = useStrings().board;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const submit = async () => {
    if (value.trim() === "") return;
    setBusy(true);
    const failure = await onCreate(value);
    setBusy(false);
    setError(failure);
  };
  return createPortal(
    <Modal title={t.newBoard} onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>{t.newBoardName}</span>
          <input data-autofocus className="input" value={value} placeholder={t.newBoardPlaceholder} disabled={busy} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} onChange={(e) => setValue(e.target.value)} />
        </label>
        {error && (
          <p id={errorId} role="alert" className="alert alert-danger">
            {error}
          </p>
        )}
        <div className="move-actions">
          <Button variant="quiet" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button variant="primary" type="submit" disabled={busy || value.trim() === ""}>
            {t.create}
          </Button>
        </div>
      </form>
    </Modal>,
    shellRoot(),
  );
}

/** Add note: a filter over the pages not on the board yet; Enter pins the first match, a click pins that one. */
function AddNoteDialog({ pages, onChoose, onClose }: { pages: Graph["pages"]; onChoose(path: string): void; onClose(): void }) {
  const t = useStrings().board;
  const [query, setQuery] = useState("");
  const q = query.trim().toLocaleLowerCase();
  const sorted = useMemo(() => [...pages].sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path)), [pages]);
  const matches = (q ? sorted.filter((p) => p.title.toLocaleLowerCase().includes(q) || p.path.toLocaleLowerCase().includes(q)) : sorted).slice(0, 50);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || !matches[0]) return;
    e.preventDefault();
    onChoose(matches[0].path);
  };
  return createPortal(
    <Modal title={t.addNote} onClose={onClose}>
      <input data-autofocus className="input" aria-label={t.addNoteFilter} placeholder={t.addNoteFilter} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} />
      <ul className="board-link-list" aria-label={t.addNoteFilter}>
        {matches.map((p) => (
          <li key={p.path}>
            <button type="button" className="board-add-option" onClick={() => onChoose(p.path)}>
              <span className="board-link-title">{p.title}</span>
              {dirname(p.path) && <span className="board-link-folder">{dirname(p.path)}</span>}
            </button>
          </li>
        ))}
      </ul>
      {!matches.length && <p className="board-link-none">{t.addNoteNone}</p>}
    </Modal>,
    shellRoot(),
  );
}
