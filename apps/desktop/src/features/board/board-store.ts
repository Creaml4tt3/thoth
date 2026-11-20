/**
 * Board files (JSON Canvas, `.canvas`) in a Private Space. Every write is compare-and-swap on the bytes read. Another
 * app (Obsidian) may write the same file: on a conflict the file is read again and only Thoth's own changes are applied
 * to it, by node id, then written once more; a file that no longer parses is never written over.
 */
import { decodeText, encodeText } from "@thoth/content";
import { collisionKey, extname, sha256Hex } from "@thoth/domain";
import { ConflictError, entryNameProblem, NotFoundError, type Vault } from "@thoth/local-store";
import { applyChanges, CanvasError, parseCanvas, serializeCanvas, type BoardChange, type CanvasFile, type CanvasNode } from "@thoth/app-ui/board/canvas.ts";
import { RenameError } from "../shell/rename.ts";

export interface Board {
  canvas: CanvasFile;
  hash: string;
}

export function boardStore(vault: Vault) {
  /** @throws NotFoundError the board is gone; CanvasError it is not UTF-8 or not a canvas */
  async function read(path: string): Promise<Board> {
    if ((await vault.fs.stat(path))?.kind !== "file") throw new NotFoundError(`Board ${path}`);
    const bytes = await vault.fs.readFile(path);
    const { text, editable } = decodeText(bytes);
    if (!editable) throw new CanvasError("The canvas is not UTF-8.");
    return { canvas: parseCanvas(text), hash: sha256Hex(bytes) };
  }
  async function write(path: string, canvas: CanvasFile, expectedHash: string | null): Promise<Board> {
    const hash = await vault.writeFileAtomic(path, encodeText(serializeCanvas(canvas)), { expectedHash });
    return { canvas, hash };
  }

  return {
    /** `.canvas` paths in the Space, sorted. The index is brought up to date by every write through the vault. */
    async list(): Promise<string[]> {
      return (await vault.listAttachments()).filter((a) => extname(a.path) === ".canvas").map((a) => a.path);
    },

    read,

    /** `${folder}/${name}.canvas` ("" is the Space root), with `nodes` (none by default) in one write. @throws RenameError a bad name, or one already taken in any letter case */
    async create(within: string, name: string, nodes: CanvasNode[] = []): Promise<string> {
      const folder = within.replace(/\/+$/, "");
      const stem = name.trim();
      const entry = `${stem}.canvas`;
      const problem = entryNameProblem(stem, "file") ?? entryNameProblem(entry, "file");
      if (problem) throw new RenameError(problem);
      const path = folder === "" ? entry : `${folder}/${entry}`;
      const key = collisionKey(entry);
      const siblings = (await vault.fs.stat(folder)) ? await vault.fs.list(folder) : [];
      if (siblings.some((e) => collisionKey(e.name) === key)) throw new RenameError("exists");
      try {
        await write(path, { raw: { nodes, edges: [] }, nodes, edges: [] }, null);
      } catch (error) {
        if (error instanceof ConflictError) throw new RenameError("exists");
        throw error;
      }
      return path;
    },

    /** Writes `changes` on top of `base`; on a conflict, once on top of the file as it is now. A second conflict throws. */
    async save(path: string, base: Board, changes: readonly BoardChange[]): Promise<Board> {
      try {
        return await write(path, applyChanges(base.canvas, changes), base.hash);
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        const now = await read(path); // throws on a file that no longer parses: nothing is written
        return write(path, applyChanges(now.canvas, changes), now.hash);
      }
    },
  };
}
