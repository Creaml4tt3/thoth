import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStableId } from "@thoth/domain";
import { FAVORITES_PATH, favoritePage, readFavorites, recordPath, updateFavorites, type Vault } from "../src/index.ts";
import { openNodeVault } from "../src/node/index.ts";

let root: string;
let vault: Vault;

async function put(path: string, content: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}
/** A page's stable id: starring adopts it (ADR-0003), which writes `thoth_id` into its frontmatter. */
const idOf = (path: string) => vault.adoptPage(path);
const pathOf = async (id: string) => (await vault.listPages()).find((p) => p.id === id)?.path;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-favorites-"));
  await put("Notes/A.md", "# A\n");
  await put("Notes/B.md", "# B\n");
  await put("C.md", "# C\n");
  ({ vault } = await openNodeVault(root));
});

afterEach(async () => {
  await vault.close();
  await rm(root, { recursive: true, force: true });
});

const add = (id: string) => (pages: readonly string[]) => (pages.includes(id) ? [...pages] : [...pages, id]);

describe("Private Space favorites (.thoth/favorites.json, ADR-0027)", () => {
  it("is empty with no file, and a broken or unknown file reads as empty (never an error)", async () => {
    expect((await readFavorites(vault)).pages).toEqual([]);
    for (const bad of ["{ nope", JSON.stringify({ version: 2, pages: [] }), JSON.stringify({ version: 1, pages: "x" })]) {
      await put(FAVORITES_PATH, bad);
      expect((await readFavorites(vault)).pages).toEqual([]);
    }
  });

  it("is a versioned record next to the tree order, by stable page id, in the order given", async () => {
    expect(recordPath(FAVORITES_PATH)).toBe(".thoth/favorites.json");
    const a = await idOf("Notes/A.md");
    const c = await idOf("C.md");
    await updateFavorites(vault, add(c));
    await updateFavorites(vault, add(a));
    expect((await readFavorites(vault)).pages).toEqual([c, a]);
    expect(JSON.parse(await readFile(join(root, FAVORITES_PATH), "utf8"))).toEqual({ version: 1, pages: [c, a] });
    // A broken file is replaced by the next change, not kept around.
    await put(FAVORITES_PATH, "{ nope");
    expect(await updateFavorites(vault, add(a))).toEqual([a]);
  });

  it("starring a page gives it a stable id in its frontmatter (ADR-0003) and adds that id once", async () => {
    const id = await favoritePage(vault, "Notes/B.md");
    expect(isStableId(id)).toBe(true);
    expect(await readFile(join(root, "Notes/B.md"), "utf8")).toBe(`---\nthoth_id: ${id}\n---\n# B\n`);
    expect(await favoritePage(vault, "Notes/B.md")).toBe(id);
    expect((await readFavorites(vault)).pages).toEqual([id]);
  });

  it("keeps only stable ids: a path or a provisional id in the file is ignored", async () => {
    const a = await idOf("Notes/A.md");
    await put(FAVORITES_PATH, JSON.stringify({ version: 1, pages: ["Notes/B.md", a, "p:abc"] }));
    expect((await readFavorites(vault)).pages).toEqual([a]);
  });

  it("follows a page renamed or moved in the app, or outside it: the id is in the page, so the favorite follows", async () => {
    const a = await idOf("Notes/A.md");
    await updateFavorites(vault, add(a));
    await vault.move("Notes/A.md", "Notes/Alpha.md");
    await vault.move("Notes/Alpha.md", "Archive/Alpha.md");
    expect((await readFavorites(vault)).pages).toEqual([a]);
    expect(await pathOf(a)).toBe("Archive/Alpha.md");
    // Moved by another app: the index finds the same id at the new path.
    await mkdir(join(root, "Elsewhere"), { recursive: true });
    await writeFile(join(root, "Elsewhere/Alpha.md"), await readFile(join(root, "Archive/Alpha.md")));
    await rm(join(root, "Archive/Alpha.md"));
    await vault.reconcile();
    expect(await pathOf(a)).toBe("Elsewhere/Alpha.md");
  });

  it("drops ids that are not pages any more when it next writes, and keeps the others in order", async () => {
    const a = await idOf("Notes/A.md");
    const b = await idOf("Notes/B.md");
    await updateFavorites(vault, (p) => [...p, a, "0190a3b0-0000-7000-8000-000000000000", b]);
    expect(await updateFavorites(vault, (p) => p, { keep: new Set([a, b]) })).toEqual([a, b]);
  });

  it("writes with compare-and-swap: a change made in between (another window) is not lost, the change is retried on it", async () => {
    const a = await idOf("Notes/A.md");
    const b = await idOf("Notes/B.md");
    let raced = false;
    const result = await updateFavorites(vault, async (pages) => {
      if (!raced) {
        raced = true;
        // Another window writes between this read and this write.
        await put(FAVORITES_PATH, JSON.stringify({ version: 1, pages: [b] }));
      }
      return [...pages, a];
    });
    expect(result).toEqual([b, a]);
    expect((await readFavorites(vault)).pages).toEqual([b, a]);
  });

  it("gives up after a few conflicts in a row rather than looping", async () => {
    let n = 0;
    await expect(
      updateFavorites(vault, async (pages) => {
        n++;
        await put(FAVORITES_PATH, JSON.stringify({ version: 1, pages: [`0190a3b0-0000-7000-8000-00000000000${n}`] }));
        return [...pages, "x"];
      }),
    ).rejects.toThrow(/changed/);
    expect(n).toBe(4);
  });
});
