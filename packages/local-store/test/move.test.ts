import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@thoth/domain";
import { colorInOrder, ConflictError, emptyOrder, OrderRecordSchema, entryNameProblem, ORDER_PATH, orderChildren, readOrder, renameInOrder, writeOrder, type Vault } from "../src/index.ts";
import { openNodeVault } from "../src/node/index.ts";

let root: string;
let vault: Vault;

async function put(path: string, content: string | Uint8Array) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}
const read = (path: string) => readFile(join(root, path), "utf8");
const exists = (path: string) => stat(join(root, path)).then(() => true, () => false);

const OVERVIEW = "---\naliases: [Home]\ntitle: Overview\n---\n# Overview\n\nRead [the architecture](Architecture.md) and see ![d](../../Assets/diagram.svg).\n";
const ARCH = "# Architecture\n\nBack to [[Home]], [[Overview#Goals|goals]] and [[Projects/Thoth/Overview]].\n";
const WELCOME = "# Welcome\n\nStart at [[Overview]], [o](../Projects/Thoth/Overview.md#goals) and ![[diagram.svg]].\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-move-"));
  await put("Inbox/Welcome.md", WELCOME);
  await put("Projects/Thoth/Overview.md", OVERVIEW);
  await put("Projects/Thoth/Architecture.md", ARCH);
  await put("Assets/diagram.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
  ({ vault } = await openNodeVault(root));
});

afterEach(async () => {
  await vault.close();
  await rm(root, { recursive: true, force: true });
});

describe("Vault.move", () => {
  it("renames a page in its folder: links by name follow, aliases and fragments are kept, frontmatter is untouched", async () => {
    const report = await vault.move("Projects/Thoth/Overview.md", "Projects/Thoth/Summary.md");
    expect(report.moved).toEqual([{ from: "Projects/Thoth/Overview.md", to: "Projects/Thoth/Summary.md" }]);
    expect(report.rewritten.sort()).toEqual(["Inbox/Welcome.md", "Projects/Thoth/Architecture.md"]);
    expect(report.skipped).toEqual([]);
    expect(await read("Projects/Thoth/Architecture.md")).toBe("# Architecture\n\nBack to [[Home]], [[Summary#Goals|goals]] and [[Summary]].\n");
    expect(await read("Inbox/Welcome.md")).toBe("# Welcome\n\nStart at [[Summary]], [o](../Projects/Thoth/Summary.md#goals) and ![[diagram.svg]].\n");
    // The moved page's own content is byte-identical (its links still resolve from the same folder).
    expect(await read("Projects/Thoth/Summary.md")).toBe(OVERVIEW);
    expect((await vault.listPages()).map((p) => p.path)).toContain("Projects/Thoth/Summary.md");
    expect([...new Set((await vault.backlinks("Projects/Thoth/Summary.md")).map((b) => b.sourcePath))]).toEqual(["Inbox/Welcome.md", "Projects/Thoth/Architecture.md"]);
  });

  it("moves a page to another folder: relative links inside it are rewritten too", async () => {
    const report = await vault.move("Projects/Thoth/Overview.md", "Archive/Overview.md");
    expect(report.rewritten.sort()).toEqual(["Archive/Overview.md", "Inbox/Welcome.md", "Projects/Thoth/Architecture.md"]);
    expect(await read("Archive/Overview.md")).toBe("---\naliases: [Home]\ntitle: Overview\n---\n# Overview\n\nRead [the architecture](../Projects/Thoth/Architecture.md) and see ![d](../Assets/diagram.svg).\n");
    expect(await read("Inbox/Welcome.md")).toBe("# Welcome\n\nStart at [[Overview]], [o](../Archive/Overview.md#goals) and ![[diagram.svg]].\n");
    // [[Projects/Thoth/Overview]] no longer resolves by path: it becomes the shortest name that does.
    expect(await read("Projects/Thoth/Architecture.md")).toBe("# Architecture\n\nBack to [[Home]], [[Overview#Goals|goals]] and [[Overview]].\n");
    expect(await vault.unresolvedLinks()).toEqual([]);
  });

  it("moves an attachment and rewrites embeds and image links", async () => {
    const report = await vault.move("Assets/diagram.svg", "Assets/Pictures/chart.svg");
    expect(report.rewritten.sort()).toEqual(["Inbox/Welcome.md", "Projects/Thoth/Overview.md"]);
    expect(await read("Inbox/Welcome.md")).toContain("![[chart.svg]]");
    expect(await read("Projects/Thoth/Overview.md")).toContain("![d](../../Assets/Pictures/chart.svg)");
  });

  it("moves a folder with everything in it: links between its pages stay as they are", async () => {
    const report = await vault.move("Projects/Thoth", "Archive/Thoth 2026");
    expect(report.moved).toEqual([{ from: "Projects/Thoth", to: "Archive/Thoth 2026" }]);
    expect(await exists("Projects/Thoth")).toBe(false);
    expect(await read("Archive/Thoth 2026/Architecture.md")).toBe("# Architecture\n\nBack to [[Home]], [[Overview#Goals|goals]] and [[Overview]].\n");
    expect(await read("Archive/Thoth 2026/Overview.md")).toBe("---\naliases: [Home]\ntitle: Overview\n---\n# Overview\n\nRead [the architecture](Architecture.md) and see ![d](../../Assets/diagram.svg).\n");
    expect(await read("Inbox/Welcome.md")).toContain("[o](../Archive/Thoth%202026/Overview.md#goals)");
    expect(report.rewritten.sort()).toEqual(["Archive/Thoth 2026/Architecture.md", "Inbox/Welcome.md"]);
    expect(await vault.unresolvedLinks()).toEqual([]);
  });

  it("moves a folder: folder links to it follow, keeping their trailing slash and label (ADR-0049)", async () => {
    await put("Inbox/Index.md", "# Index\n\nSee [[Thoth/]], [[Projects/Thoth/|the project]] and [[Projects/]].\n");
    const report = await vault.move("Projects/Thoth", "Archive/Thoth 2026");
    expect(report.rewritten).toContain("Inbox/Index.md");
    expect(await read("Inbox/Index.md")).toBe("# Index\n\nSee [[Thoth 2026/]], [[Thoth 2026/|the project]] and [[Projects/]].\n");
  });

  it("renames a page whose name changes only in letter case", async () => {
    await vault.move("Inbox/Welcome.md", "Inbox/welcome.md");
    expect(await readdir(join(root, "Inbox"))).toEqual(["welcome.md"]);
    expect((await vault.listPages()).map((p) => p.path)).toContain("Inbox/welcome.md");
  });

  it("refuses an existing target, a stale expected hash, a folder into itself and .thoth", async () => {
    await expect(vault.move("Inbox/Welcome.md", "Projects/Thoth/Overview.md")).rejects.toBeInstanceOf(ConflictError);
    await expect(vault.move("Inbox/Welcome.md", "Inbox/Moved.md", { expectedHash: sha256Hex("old") })).rejects.toBeInstanceOf(ConflictError);
    await expect(vault.move("Projects", "Projects/Thoth/Inner")).rejects.toThrow(/into itself/);
    await expect(vault.move("Inbox/Welcome.md", ".thoth/Welcome.md")).rejects.toThrow(/\.thoth/);
    await expect(vault.move("Inbox/Welcome.md", "Inbox/Welcome.md")).rejects.toThrow();
    await expect(vault.move("Nowhere.md", "Somewhere.md")).rejects.toThrow(/not found/);
    expect(await read("Inbox/Welcome.md")).toBe(WELCOME);
    // With the right hash it moves.
    await vault.move("Inbox/Welcome.md", "Inbox/Moved.md", { expectedHash: sha256Hex(WELCOME) });
    expect(await read("Inbox/Moved.md")).toBe(WELCOME);
  });

  it("leaves a page that is not UTF-8 alone and reports it", async () => {
    await put("Latin.md", new Uint8Array([0x5b, 0x5b, 0x4f, 0x76, 0x65, 0x72, 0x76, 0x69, 0x65, 0x77, 0x5d, 0x5d, 0x20, 0xe9]));
    await vault.reconcile();
    const before = await readFile(join(root, "Latin.md"));
    const report = await vault.move("Projects/Thoth/Overview.md", "Projects/Thoth/Summary.md");
    expect(report.skipped).toEqual([{ path: "Latin.md", reason: "not_utf8" }]);
    expect(await readFile(join(root, "Latin.md"))).toEqual(before);
  });
});

describe("Vault.move keeps Board pins (.canvas)", () => {
  const board = (nodes: unknown[]) => ({
    nodes,
    edges: [{ id: "e1", fromNode: "t1", fromSide: "right", toNode: "f1", toSide: "left", label: "see" }],
    metadata: { version: "1.0" },
  });
  const pin = (id: string, file: string) => ({ id, type: "file", file, subpath: "#Goals", x: 10, y: 20, width: 160, height: 120, color: "4" });
  const TEXT = { id: "t1", type: "text", text: "Overview.md", x: 0, y: 0, width: 250, height: 60 };
  const json = async (path: string) => JSON.parse(await read(path));

  it("a page rename rewrites `file` in every board and leaves every other field and edge as it was", async () => {
    const a = board([TEXT, pin("f1", "Projects/Thoth/Overview.md"), pin("f2", "Inbox/Welcome.md")]);
    await put("Boards/A.canvas", JSON.stringify(a, null, "\t"));
    await put("B.canvas", JSON.stringify(board([pin("f1", "Projects/Thoth/Overview.md")])));
    const report = await vault.move("Projects/Thoth/Overview.md", "Projects/Thoth/Summary.md");
    expect(report.rewritten).toEqual(expect.arrayContaining(["Boards/A.canvas", "B.canvas"]));
    expect(report.skipped).toEqual([]);
    const after = await json("Boards/A.canvas");
    expect(after).toEqual({ ...a, nodes: [TEXT, pin("f1", "Projects/Thoth/Summary.md"), pin("f2", "Inbox/Welcome.md")] });
    expect(Object.keys(after.nodes[1])).toEqual(Object.keys(pin("f1", "x")));
    expect((await json("B.canvas")).nodes[0].file).toBe("Projects/Thoth/Summary.md");
    // The index sees the new bytes.
    const indexed = (await vault.listAttachments()).find((x) => x.path === "B.canvas");
    expect(indexed?.hash).toBe(sha256Hex(await readFile(join(root, "B.canvas"))));
  });

  it("a folder move rewrites every pin under it, also in a board that moved with the folder", async () => {
    await put("Boards/A.canvas", JSON.stringify(board([pin("f1", "Projects/Thoth/Overview.md"), pin("f2", "Projects/Thoth/Architecture.md"), pin("f3", "Inbox/Welcome.md")])));
    await put("Projects/Thoth/Map.canvas", JSON.stringify(board([pin("f1", "Projects/Thoth/Overview.md")])));
    const report = await vault.move("Projects/Thoth", "Archive/Thoth");
    expect(report.rewritten).toEqual(expect.arrayContaining(["Boards/A.canvas", "Archive/Thoth/Map.canvas"]));
    expect((await json("Boards/A.canvas")).nodes.map((n: { file: string }) => n.file)).toEqual(["Archive/Thoth/Overview.md", "Archive/Thoth/Architecture.md", "Inbox/Welcome.md"]);
    expect((await json("Archive/Thoth/Map.canvas")).nodes[0].file).toBe("Archive/Thoth/Overview.md");
  });

  it("a pin spelled `./` or in another Unicode form follows a rename; other spellings are left as written", async () => {
    await put("Café.md", "# Café\n");
    await vault.reconcile();
    const nodes = [pin("f1", "./Projects/Thoth/Overview.md"), pin("f2", "Cafe\u0301.md"), pin("f3", "./Inbox/Welcome.md"), pin("f4", "../Outside.md")];
    await put("A.canvas", JSON.stringify(board(nodes)));
    await vault.move("Projects/Thoth/Overview.md", "Projects/Thoth/Summary.md");
    expect((await json("A.canvas")).nodes.map((n: { file: string }) => n.file)).toEqual(["Projects/Thoth/Summary.md", "Cafe\u0301.md", "./Inbox/Welcome.md", "../Outside.md"]);
    await vault.move("Café.md", "Tea.md");
    expect((await json("A.canvas")).nodes.map((n: { file: string }) => n.file)).toEqual(["Projects/Thoth/Summary.md", "Tea.md", "./Inbox/Welcome.md", "../Outside.md"]);
  });

  it("a board another app changes while the move rewrites it is reported as changed and kept", async () => {
    await put("B.canvas", JSON.stringify(board([pin("f1", "Projects/Thoth/Overview.md")])));
    const theirs = JSON.stringify(board([pin("f1", "Projects/Thoth/Overview.md"), pin("f2", "Inbox/Welcome.md")]));
    const readFileOrig = vault.fs.readFile.bind(vault.fs);
    vi.spyOn(vault.fs, "readFile").mockImplementation(async (path) => {
      const bytes = await readFileOrig(path);
      // Right after the move reads the board, another app saves it.
      if (path === "B.canvas" && (await exists("Projects/Thoth/Summary.md"))) await put("B.canvas", theirs);
      return bytes;
    });
    const report = await vault.move("Projects/Thoth/Overview.md", "Projects/Thoth/Summary.md");
    expect(report.skipped).toContainEqual({ path: "B.canvas", reason: "changed" });
    expect(report.rewritten).not.toContain("B.canvas");
    expect(await read("B.canvas")).toBe(theirs);
    expect(await exists("Projects/Thoth/Summary.md")).toBe(true);
  });

  it("moving a board whose pins do not change leaves its bytes alone", async () => {
    const text = JSON.stringify(board([pin("f1", "Inbox/Welcome.md")]), null, "\t");
    await put("Boards/A.canvas", text);
    const report = await vault.move("Boards/A.canvas", "Archive/A.canvas");
    expect(report.rewritten).not.toContain("Archive/A.canvas");
    expect(await read("Archive/A.canvas")).toBe(text);
  });

  it("a board that is not a canvas is reported and the move still succeeds", async () => {
    await put("Broken.canvas", "{ not json");
    await put("Latin1.canvas", new Uint8Array([0x7b, 0xe9, 0x7d]));
    await put("Array.canvas", "[]");
    const report = await vault.move("Projects/Thoth/Overview.md", "Projects/Thoth/Summary.md");
    expect(report.skipped).toEqual(expect.arrayContaining([{ path: "Broken.canvas", reason: "not_canvas" }, { path: "Latin1.canvas", reason: "not_utf8" }]));
    expect(await read("Broken.canvas")).toBe("{ not json");
    expect(await read("Array.canvas")).toBe("[]");
    expect(await exists("Projects/Thoth/Summary.md")).toBe(true);
  });
});

describe("folders", () => {
  it("lists every folder, also empty ones, and never Thoth's or other tools' metadata", async () => {
    await mkdir(join(root, "Empty/Deeper"), { recursive: true });
    await mkdir(join(root, ".git/objects"), { recursive: true });
    expect(await vault.listFolders()).toEqual(["Assets", "Empty", "Empty/Deeper", "Inbox", "Projects", "Projects/Thoth"]);
  });

  it("creates a folder and removes it only while it is empty", async () => {
    await vault.createFolder("Ideas/Later");
    expect(await vault.listFolders()).toContain("Ideas/Later");
    await expect(vault.createFolder("Ideas")).rejects.toBeInstanceOf(ConflictError);
    await expect(vault.createFolder("Inbox/Welcome.md")).rejects.toBeInstanceOf(ConflictError);
    await expect(vault.createFolder(".thoth/x")).rejects.toThrow();
    await writeFile(join(root, "Ideas/Later/.DS_Store"), "");
    await vault.removeEmptyFolder("Ideas");
    expect(await exists("Ideas")).toBe(false);
    await expect(vault.removeEmptyFolder("Inbox")).rejects.toThrow(/not empty/);
    expect(await read("Inbox/Welcome.md")).toBe(WELCOME);
  });
});

describe("new folders", () => {
  it("refuses a name that differs from an existing one only in letter case or Unicode form", async () => {
    await expect(vault.createFolder("inbox")).rejects.toBeInstanceOf(ConflictError);
    await expect(vault.createFolder("Inbox/WELCOME.MD")).rejects.toBeInstanceOf(ConflictError);
    await vault.createFolder("Café");
    await expect(vault.createFolder("Cafe\u0301")).rejects.toBeInstanceOf(ConflictError); // e + combining accent
    await expect(vault.createFolder("CAFÉ")).rejects.toBeInstanceOf(ConflictError);
    await expect(vault.createFolder("Inbox/Welcome.md/Inner")).rejects.toBeInstanceOf(ConflictError); // a file in the way
    await expect(vault.createFolder(".THOTH/x")).rejects.toThrow(/reserved/);
    expect(await readdir(root)).not.toContain("inbox"); // nothing was created under the refused names
  });

  it("creates 'Untitled folder', then 'Untitled folder 2', 3… at the top level and inside a folder", async () => {
    expect(await vault.createUniqueFolder("", "Untitled folder")).toBe("Untitled folder");
    expect(await vault.createUniqueFolder("", "Untitled folder")).toBe("Untitled folder 2");
    await mkdir(join(root, "untitled folder 3")); // taken in another letter case
    expect(await vault.createUniqueFolder("", "Untitled folder")).toBe("Untitled folder 4");
    expect(await vault.createUniqueFolder("Projects", "Untitled folder")).toBe("Projects/Untitled folder");
    expect(await vault.createUniqueFolder("Projects/Thoth", "Untitled folder")).toBe("Projects/Thoth/Untitled folder");
    expect(await vault.createUniqueFolder("Projects", "Untitled folder")).toBe("Projects/Untitled folder 2");
    expect(await vault.listFolders()).toEqual(expect.arrayContaining(["Untitled folder", "Untitled folder 2", "Untitled folder 4", "Projects/Untitled folder", "Projects/Untitled folder 2", "Projects/Thoth/Untitled folder"]));
    // Two at once never get the same name.
    const both = await Promise.all([vault.createUniqueFolder("Assets", "New"), vault.createUniqueFolder("Assets", "New")]);
    expect([...both].sort()).toEqual(["Assets/New", "Assets/New 2"]);
  });

  it("refuses .thoth and a parent that is a file", async () => {
    await expect(vault.createUniqueFolder(".thoth", "Untitled folder")).rejects.toThrow(/reserved/);
    await expect(vault.createUniqueFolder("Inbox/Welcome.md", "Untitled folder")).rejects.toBeInstanceOf(ConflictError);
  });

  it("checks names before touching the disk", () => {
    expect(entryNameProblem("Plan.md", "file")).toBeNull();
    expect(entryNameProblem("การประชุม 🚀", "folder")).toBeNull();
    expect(entryNameProblem("", "folder")).toBe("empty");
    expect(entryNameProblem("   ", "file")).toBe("empty");
    expect(entryNameProblem("a/b", "file")).toBe("separator");
    expect(entryNameProblem("a\\b", "folder")).toBe("separator");
    expect(entryNameProblem(".thoth", "folder")).toBe("reserved");
    expect(entryNameProblem(".THOTH", "folder")).toBe("reserved");
    expect(entryNameProblem(".thoth", "file")).toBe("reserved");
    expect(entryNameProblem(".git", "folder")).toBe("reserved"); // never scanned: it would vanish from the tree
    expect(entryNameProblem(".git", "file")).toBeNull();
    for (const bad of ["a:b", "a*b", 'a"b', "a<b", "a>b", "a|b", "a?b", "a\u0007b", ".", "..", "name.", "CON", "nul.md", "Lpt1"]) expect(entryNameProblem(bad, "folder"), bad).toBe("invalid");
    expect(entryNameProblem("a".repeat(256), "folder")).toBe("tooLong");
    expect(entryNameProblem("ก".repeat(86), "folder")).toBe("tooLong"); // 3 bytes each
    expect(entryNameProblem("ก".repeat(85), "folder")).toBeNull();
  });
});

describe("order record", () => {
  const az = (a: string, b: string) => a.localeCompare(b);

  it("falls back to A–Z when the record is missing, corrupt or of another shape", async () => {
    expect(await readOrder(vault)).toEqual(emptyOrder());
    await put(ORDER_PATH, "{ not json");
    expect(await readOrder(vault)).toEqual(emptyOrder());
    await put(ORDER_PATH, JSON.stringify({ version: 2, folders: {} }));
    expect(await readOrder(vault)).toEqual(emptyOrder());
    await put(ORDER_PATH, JSON.stringify({ version: 1, folders: { "": "nope" } }));
    expect(await readOrder(vault)).toEqual(emptyOrder());
  });

  it("round-trips through the durable record path", async () => {
    const record = { version: 1 as const, folders: { "": ["Projects", "Inbox"], Inbox: ["Welcome.md"] } };
    await writeOrder(vault, record);
    expect(await readOrder(vault)).toEqual(record);
    expect(JSON.parse(await read(ORDER_PATH))).toEqual(record);
    expect(await readdir(join(root, ".thoth/tmp"))).toEqual([]);
  });

  it("orders listed children first, then the rest A–Z, ignoring stale names", () => {
    const record = { version: 1 as const, folders: { "": ["c.md", "gone.md", "a.md"] } };
    expect(orderChildren("", ["a.md", "b.md", "c.md", "d.md"], (n) => n, az, record)).toEqual(["c.md", "a.md", "b.md", "d.md"]);
    expect(orderChildren("Other", ["b", "a"], (n) => n, az, record)).toEqual(["a", "b"]);
  });

  it("follows renames and moves", () => {
    const record = { version: 1 as const, folders: { "": ["B", "a.md", "A"], A: ["x.md", "y.md"], "A/Sub": ["z.md"], B: ["k.md"] } };
    // A rename in place keeps the position.
    expect(renameInOrder(record, [{ from: "a.md", to: "renamed.md" }]).folders[""]).toEqual(["B", "renamed.md", "A"]);
    // A move to another folder leaves the old list and is not added to the new one.
    const moved = renameInOrder(record, [{ from: "A/x.md", to: "B/x.md" }]);
    expect(moved.folders["A"]).toEqual(["y.md"]);
    expect(moved.folders["B"]).toEqual(["k.md"]);
    // A folder move takes its lists, nested ones too.
    const folder = renameInOrder(record, [{ from: "A", to: "B/A" }]);
    expect(folder.folders[""]).toEqual(["B", "a.md"]);
    expect(folder.folders["B/A"]).toEqual(["x.md", "y.md"]);
    expect(folder.folders["B/A/Sub"]).toEqual(["z.md"]);
    expect(folder.folders["A"]).toBeUndefined();
    // The input is not changed.
    expect(record.folders["A"]).toEqual(["x.md", "y.md"]);
  });

  it("keeps folder colors through renames and moves, and clears a folder's with the folders in it (0.2.6)", () => {
    const record = { version: 1 as const, folders: {}, colors: { A: "green", "A/Sub": "red", B: "blue" } };
    expect(renameInOrder(record, [{ from: "A", to: "B/A" }]).colors).toEqual({ "B/A": "green", "B/A/Sub": "red", B: "blue" });
    expect(renameInOrder({ version: 1, folders: {} }, [{ from: "a.md", to: "b.md" }])).toEqual({ version: 1, folders: {} });
    expect(colorInOrder(record, "B", "purple").colors).toEqual({ A: "green", "A/Sub": "red", B: "purple" });
    expect(colorInOrder(record, "A", null).colors).toEqual({ B: "blue" });
    expect(colorInOrder({ version: 1, folders: {}, colors: { A: "green" } }, "A", null)).toEqual({ version: 1, folders: {} });
    // Older records, without colors, still read.
    expect(OrderRecordSchema.safeParse({ version: 1, folders: { "": ["a.md"] } }).success).toBe(true);
  });
});
