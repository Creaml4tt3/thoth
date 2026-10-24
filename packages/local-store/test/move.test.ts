import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@thoth/domain";
import { ConflictError, emptyOrder, ORDER_PATH, orderChildren, readOrder, renameInOrder, writeOrder, type Vault } from "../src/index.ts";
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
});
