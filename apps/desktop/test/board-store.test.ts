// Board files in a real Private Space: list, read, create, and save with compare-and-swap; on a conflict Thoth's own
// changes are applied again to what the other app wrote, never over it.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNodeVault } from "@thoth/local-store/node";
import { ConflictError, NotFoundError, type Vault } from "@thoth/local-store";
import { serializeCanvas, type CanvasNode } from "@thoth/app-ui/board/canvas.ts";
import { boardStore } from "../src/features/board/board-store.ts";
import { RenameError } from "../src/features/shell/rename.ts";

let root: string;
let vault: Vault;
const put = async (path: string, text: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
};
const read = (path: string) => readFile(join(root, path), "utf8");
const pin = (id: string, file: string, x = 0, y = 0): CanvasNode => ({ id, type: "file", file, x, y, width: 160, height: 120 });

// What another app keeps in the file: a text node, an edge, a field and a top-level key Thoth does not know.
const BOARD = {
  nodes: [
    { id: "t", type: "text", text: "hi", x: 0, y: 0, width: 250, height: 60, color: "4" },
    pin("x", "X.md", 10, 10),
    pin("y", "Y.md", 20, 20),
    pin("z", "Z.md", 30, 30),
  ],
  edges: [{ id: "e", fromNode: "t", toNode: "x", label: "see" }],
  metadata: { version: "1.0" },
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-board-"));
  await put("X.md", "# X\n");
  await put("Boards/Plan.canvas", JSON.stringify(BOARD, null, 2) + "\n");
  await put("Other.png", "png");
  ({ vault } = await openNodeVault(root));
});
afterEach(async () => {
  await vault.close();
  await rm(root, { recursive: true, force: true });
});

describe("boardStore", () => {
  it("lists the .canvas files, sorted", async () => {
    await put("A.canvas", "{}");
    await vault.reconcile();
    expect(await boardStore(vault).list()).toEqual(["A.canvas", "Boards/Plan.canvas"]);
  });

  it("creates an empty board, lists it, and refuses a duplicate or a bad name", async () => {
    const store = boardStore(vault);
    expect(await store.create("", "Ideas")).toBe("Ideas.canvas");
    expect(await store.create("Boards/", "Mind map")).toBe("Boards/Mind map.canvas");
    expect(JSON.parse(await read("Ideas.canvas"))).toEqual({ nodes: [], edges: [] });
    expect((await store.read("Ideas.canvas")).canvas.nodes).toEqual([]);
    expect(await store.list()).toEqual(["Boards/Mind map.canvas", "Boards/Plan.canvas", "Ideas.canvas"]);
    await expect(store.create("", "Ideas")).rejects.toThrow(RenameError);
    await expect(store.create("", "IDEAS")).rejects.toThrow(RenameError);
    await expect(store.create("", "a/b")).rejects.toThrow(RenameError);
    await expect(store.create("", " ")).rejects.toThrow(RenameError);
    expect(JSON.parse(await read("Ideas.canvas"))).toEqual({ nodes: [], edges: [] });
  });

  it("saves the changes and keeps everything else", async () => {
    const store = boardStore(vault);
    const base = await store.read("Boards/Plan.canvas");
    const saved = await store.save("Boards/Plan.canvas", base, [{ kind: "move", id: "x", x: 99, y: 98 }]);
    const file = JSON.parse(await read("Boards/Plan.canvas"));
    expect(file).toEqual({ ...BOARD, nodes: [BOARD.nodes[0], pin("x", "X.md", 99, 98), ...BOARD.nodes.slice(2)] });
    expect(saved.canvas.nodes[1]).toMatchObject({ x: 99, y: 98 });
    expect(saved.hash).toBe((await store.read("Boards/Plan.canvas")).hash);
  });

  it("on a conflict keeps the other app's changes and applies ours again", async () => {
    const store = boardStore(vault);
    const base = await store.read("Boards/Plan.canvas");
    // Another app moves X and deletes Y.
    const outside = { ...BOARD, nodes: [BOARD.nodes[0], pin("x", "X.md", -500, -500), BOARD.nodes[3]], extra: true };
    await put("Boards/Plan.canvas", JSON.stringify(outside));
    const saved = await store.save("Boards/Plan.canvas", base, [
      { kind: "move", id: "y", x: 1, y: 1 },
      { kind: "move", id: "z", x: 2, y: 2 },
      { kind: "pin", node: pin("p", "P.md", 3, 3) },
    ]);
    const file = JSON.parse(await read("Boards/Plan.canvas"));
    expect(file).toEqual({ ...outside, nodes: [BOARD.nodes[0], pin("x", "X.md", -500, -500), pin("z", "Z.md", 2, 2), pin("p", "P.md", 3, 3)] });
    expect(serializeCanvas(saved.canvas)).toBe(await read("Boards/Plan.canvas"));
  });

  it("does not pin a page twice when the other app pinned it too", async () => {
    const store = boardStore(vault);
    const base = await store.read("Boards/Plan.canvas");
    await put("Boards/Plan.canvas", JSON.stringify({ ...BOARD, nodes: [...BOARD.nodes, pin("theirs", "P.md")] }));
    await store.save("Boards/Plan.canvas", base, [{ kind: "pin", node: pin("ours", "P.md") }]);
    const files = JSON.parse(await read("Boards/Plan.canvas")).nodes.map((n: CanvasNode) => n.file);
    expect(files.filter((f: string) => f === "P.md")).toHaveLength(1);
  });

  it("never writes over a file it cannot parse", async () => {
    const store = boardStore(vault);
    const base = await store.read("Boards/Plan.canvas");
    await put("Boards/Plan.canvas", "{ broken");
    await expect(store.save("Boards/Plan.canvas", base, [{ kind: "move", id: "x", x: 1, y: 1 }])).rejects.toThrow();
    expect(await read("Boards/Plan.canvas")).toBe("{ broken");
  });

  it("save on a board that is gone throws NotFoundError and creates nothing", async () => {
    const store = boardStore(vault);
    const base = await store.read("Boards/Plan.canvas");
    await rm(join(root, "Boards/Plan.canvas"));
    await expect(store.save("Boards/Plan.canvas", base, [{ kind: "move", id: "x", x: 1, y: 1 }])).rejects.toThrow(NotFoundError);
    await expect(read("Boards/Plan.canvas")).rejects.toThrow();
  });

  it("throws on a second conflict", async () => {
    let writes = 0;
    const racing = new Proxy(vault, {
      get(target, key, receiver) {
        if (key !== "writeFileAtomic") return Reflect.get(target, key, receiver);
        // Another app writes just before each of our writes.
        return async (path: string, data: Uint8Array, options: { expectedHash: string | null }) => {
          await put(path, JSON.stringify({ ...BOARD, n: ++writes }));
          return target.writeFileAtomic(path, data, options);
        };
      },
    });
    const store = boardStore(racing);
    const base = await store.read("Boards/Plan.canvas");
    await expect(store.save("Boards/Plan.canvas", base, [{ kind: "move", id: "x", x: 1, y: 1 }])).rejects.toThrow(ConflictError);
    expect(writes).toBe(2);
    expect(JSON.parse(await read("Boards/Plan.canvas")).n).toBe(2);
  });
});
