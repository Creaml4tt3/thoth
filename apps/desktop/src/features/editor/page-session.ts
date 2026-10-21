/**
 * The state machine behind one open page: load, edit, save, and the conflict
 * rules. It has no React or Tiptap in it; the editor is reached through an
 * `EditorBridge`, so the safety rules are testable on their own.
 *
 * Rules (ADR-001, spec section 3.1):
 * - Every write is compare-and-swap on the hash we last read or wrote.
 * - Nothing is written when the serialized Markdown equals what is on disk.
 * - A stale hash is never sent to `writePage`: before writing we compare the
 *   disk hash; a mismatch (or a `ConflictError` from a race) opens a conflict
 *   instead. While a conflict is open the editor is frozen and nothing saves.
 * - With no local edits, a changed file reloads silently.
 * - Operations run one at a time, so a save, a reload and a resolution never interleave.
 */
import { ConflictError, NotFoundError, type Vault } from "@thoth/local-store";
import { basename, dirname, stripExtension } from "@thoth/domain";

export interface EditorBridge {
  /** Markdown for the editor's current document, frontmatter included; null when the editor is gone (never written). */
  markdown(): string | null;
  /** Replaces the document (and undo history), keeping the cursor where possible. */
  load(source: string): void;
  setEditable(editable: boolean): void;
}

export interface DiskVersion {
  source: string;
  hash: string;
}

export interface Conflict {
  /** What is on disk now; null when the file was deleted. */
  disk: DiskVersion | null;
  /** The editor's version, frozen when the conflict opened. */
  mine: string;
}

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
export type ConflictChoice = "mine" | "theirs" | "both";
export type SaveOutcome = "saved" | "unchanged" | "conflict" | "error" | "skipped";

export interface PageState {
  phase: "loading" | "ready" | "missing" | "error";
  /** False for non-UTF-8 files: shown read-only, never written. */
  editable: boolean;
  save: SaveStatus;
  conflict: Conflict | null;
  /** Failure of the last save or conflict resolution. */
  error: string | null;
  /** Path of the file that kept "my" version after Keep both. */
  conflictCopy: string | null;
}

export interface PageSessionDeps {
  vault: Vault;
  path: string;
  editor: EditorBridge;
  /** Idle time before autosave; 0 disables it. */
  autosaveMs: number;
  now: () => Date;
  /** Called after Thoth itself wrote to the vault, so views can re-query. */
  onWritten(): void;
}

export interface PageSession {
  getState(): PageState;
  subscribe(listener: () => void): () => void;
  open(): Promise<void>;
  /** The editor changed: schedule an autosave. */
  noteEdited(): void;
  save(snapshot?: string): Promise<SaveOutcome>;
  /** Compares the file on disk with what this page last saw; reloads or opens a conflict as needed. */
  checkDisk(): Promise<void>;
  resolveConflict(choice: ConflictChoice): Promise<void>;
  /** Saves pending edits before leaving the page. False means "stay": a conflict or an error needs the user. */
  flush(): Promise<boolean>;
  dispose(): void;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `YYYY-MM-DD HHmm` in local time. */
export function conflictStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** `<dir>/<name> (conflict YYYY-MM-DD HHmm).md`, with " 2", " 3"... added when that name is taken. */
export function conflictCopyPath(path: string, date: Date, attempt = 1): string {
  const dir = dirname(path);
  const name = stripExtension(basename(path));
  const suffix = attempt > 1 ? ` ${attempt}` : "";
  const file = `${name} (conflict ${conflictStamp(date)})${suffix}.md`;
  return dir ? `${dir}/${file}` : file;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createPageSession(deps: PageSessionDeps): PageSession {
  const { vault, path, editor } = deps;
  let state: PageState = { phase: "loading", editable: true, save: "idle", conflict: null, error: null, conflictCopy: null };
  const listeners = new Set<() => void>();
  /** The last content this page read from or wrote to disk. */
  let base: DiskVersion | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let disposed = false;

  const set = (patch: Partial<PageState>): void => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (): void => {
    clearTimer();
    if (deps.autosaveMs > 0 && !disposed) timer = setTimeout(() => void save(), deps.autosaveMs);
  };

  const readDisk = async (): Promise<(DiskVersion & { editable: boolean }) | null> => {
    try {
      const read = await vault.readPage(path);
      return { source: read.source, hash: read.hash, editable: read.editable };
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  };

  const adopt = (disk: DiskVersion & { editable: boolean }): void => {
    base = { source: disk.source, hash: disk.hash };
    editor.load(disk.source);
    editor.setEditable(disk.editable);
    set({ editable: disk.editable, save: "idle", conflict: null, error: null });
  };

  const enterConflict = async (mine: string, disk: (DiskVersion & { editable: boolean }) | null): Promise<void> => {
    if (disk && disk.source === mine) {
      // Both sides ended up identical (e.g. the same edit made elsewhere): nothing to decide.
      base = { source: disk.source, hash: disk.hash };
      set({ save: "idle", conflict: null });
      return;
    }
    clearTimer();
    editor.setEditable(false);
    set({ save: "idle", error: null, conflict: { mine, disk: disk ? { source: disk.source, hash: disk.hash } : null } });
  };

  const hasLocalEdits = (): boolean => {
    const current = editor.markdown();
    return base !== null && current !== null && current !== base.source;
  };

  const open = (): Promise<void> =>
    enqueue(async () => {
      try {
        const read = await vault.readPage(path);
        base = { source: read.source, hash: read.hash };
        editor.load(read.source);
        editor.setEditable(read.editable);
        set({ phase: "ready", editable: read.editable, save: "idle", conflict: null, error: null });
      } catch (error) {
        if (error instanceof NotFoundError) set({ phase: "missing" });
        else set({ phase: "error", error: message(error) });
      }
    });

  /** `snapshot` pins what to save (taken synchronously by `flush`, before the editor can change or go away). */
  const save = (snapshot?: string): Promise<SaveOutcome> =>
    enqueue(async (): Promise<SaveOutcome> => {
      clearTimer();
      if (disposed || !base || state.phase !== "ready" || !state.editable) return "skipped";
      if (state.conflict) return "conflict";
      const mine = snapshot ?? editor.markdown();
      if (mine === null) return "skipped";
      if (mine === base.source) {
        // Never write unchanged content (also covers edit-then-undo).
        if (state.save === "dirty") set({ save: "idle" });
        return "unchanged";
      }
      set({ save: "saving", error: null });
      try {
        // Compare before writing so a stale hash is never even offered to `writePage`.
        const disk = await readDisk();
        if (!disk || disk.hash !== base.hash) {
          await enterConflict(mine, disk);
          return state.conflict ? "conflict" : "unchanged";
        }
        const hash = await vault.writePage(path, mine, { expectedHash: base.hash });
        base = { source: mine, hash };
        deps.onWritten();
        const after = editor.markdown();
        if (after !== null && after !== mine && snapshot === undefined) {
          set({ save: "dirty" });
          schedule();
        } else {
          set({ save: "saved" });
        }
        return "saved";
      } catch (error) {
        if (error instanceof ConflictError) {
          // Lost a race with another writer between the check and the write; the file was not touched.
          await enterConflict(mine, await readDisk());
          return state.conflict ? "conflict" : "unchanged";
        }
        set({ save: "error", error: message(error) });
        return "error";
      }
    });

  const checkDisk = (): Promise<void> =>
    enqueue(async () => {
      if (disposed || state.phase !== "ready" || !base) return;
      let disk;
      try {
        disk = await readDisk();
      } catch {
        return; // a transient read failure is not a change
      }
      if (state.conflict) {
        // Keep the dialog truthful if the file moved again while it is open.
        if ((disk?.hash ?? null) !== (state.conflict.disk?.hash ?? null))
          set({ conflict: { mine: state.conflict.mine, disk: disk ? { source: disk.source, hash: disk.hash } : null } });
        return;
      }
      if (disk && disk.hash === base.hash) return;
      const mine = editor.markdown();
      if (mine === null) return;
      if (mine === base.source) {
        // No local edits: follow the disk silently.
        clearTimer();
        if (!disk) set({ phase: "missing", save: "idle" });
        else adopt(disk);
        return;
      }
      await enterConflict(mine, disk);
    });

  const writeConflictCopy = async (mine: string): Promise<string> => {
    for (let attempt = 1; attempt <= 50; attempt++) {
      const copy = conflictCopyPath(path, deps.now(), attempt);
      try {
        await vault.writePage(copy, mine, { expectedHash: null });
        return copy;
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
      }
    }
    throw new Error("Could not find a free name for the conflict copy");
  };

  const resolveConflict = (choice: ConflictChoice): Promise<void> =>
    enqueue(async () => {
      const conflict = state.conflict;
      if (!conflict || disposed) return;
      try {
        if (choice === "mine") {
          // Overwrite deliberately, but still compare-and-swap against the disk version the user saw.
          const hash = await vault.writePage(path, conflict.mine, { expectedHash: conflict.disk?.hash ?? null });
          base = { source: conflict.mine, hash };
          editor.setEditable(true);
          set({ conflict: null, save: "saved", error: null, editable: true });
          deps.onWritten();
          return;
        }
        let copy: string | null = null;
        if (choice === "both") {
          copy = await writeConflictCopy(conflict.mine);
          deps.onWritten();
        }
        if (conflict.disk) {
          adopt({ ...conflict.disk, editable: true });
        } else {
          set({ phase: "missing", conflict: null, save: "idle" });
        }
        set({ conflictCopy: copy });
      } catch (error) {
        if (error instanceof ConflictError) {
          // The file changed again while the dialog was open: show the new disk version and let the user choose again.
          const disk = await readDisk().catch(() => null);
          set({ conflict: { mine: conflict.mine, disk: disk ? { source: disk.source, hash: disk.hash } : null }, error: "The file changed on disk again. Review the new version and choose again." });
          return;
        }
        set({ error: message(error) });
      }
    });

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open,
    noteEdited() {
      if (disposed || state.phase !== "ready" || !state.editable || state.conflict) return;
      if (state.save !== "dirty") set({ save: state.save === "saving" ? "saving" : "dirty" });
      schedule();
    },
    save,
    checkDisk,
    resolveConflict,
    async flush() {
      if (state.conflict) return false;
      if (state.phase !== "ready" || !state.editable) return true;
      const snapshot = editor.markdown();
      if (snapshot === null || (state.save !== "dirty" && !hasLocalEdits())) return true;
      const outcome = await save(snapshot);
      return outcome === "saved" || outcome === "unchanged" || outcome === "skipped";
    },
    dispose() {
      disposed = true;
      clearTimer();
      listeners.clear();
    },
  };
}
