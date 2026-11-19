// Drawing string on the Board (ADR-0056) writes one link line at the end of the source page, on a real vault: spelled
// by linkText, after the editor's pending edits, compare-and-swap with one retry, and an undo that removes only that
// line while it is still the last one and unchanged.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNodeVault } from "@thoth/local-store/node";
import type { Vault } from "@thoth/local-store";
import { drawLink } from "../src/features/board/draw-link.ts";

let root: string;
let vault: Vault;
const put = async (path: string, text: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
};
const read = (path: string) => readFile(join(root, path), "utf8");
const flushed = async () => true;
/** Lines of `after` minus those of `before`, when `after` is `before` with lines added at the end. */
const added = (before: string, after: string) => {
  const [b, a] = [before.split(/\r?\n/).filter((l, i, all) => l !== "" || i < all.length - 1), after.split(/\r?\n/).filter((l, i, all) => l !== "" || i < all.length - 1)];
  expect(a.slice(0, b.length)).toEqual(b);
  return a.slice(b.length);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-draw-link-"));
  await put("Atlas.md", "# Atlas\n\nSome text.\n");
  await put("Roadmap.md", "# Roadmap\n");
  await put("C# notes.md", "# C# notes\n");
  ({ vault } = await openNodeVault(root));
});
afterEach(async () => {
  await vault.close();
  await rm(root, { recursive: true, force: true });
});

describe("drawLink", () => {
  it("adds a wikilink as one new last line when one resolves", async () => {
    const result = await drawLink(vault, flushed, "Atlas.md", "Roadmap.md");
    expect(result.outcome).toBe("linked");
    expect(await read("Atlas.md")).toBe("# Atlas\n\nSome text.\n[[Roadmap]]\n");
  });

  it("adds a Markdown link when no wikilink can reach the page", async () => {
    await drawLink(vault, flushed, "Atlas.md", "C# notes.md");
    const after = await read("Atlas.md");
    expect(added("# Atlas\n\nSome text.\n", after)).toEqual(["[C# notes](C%23%20notes.md)"]);
  });

  it("adds exactly one line to a file without a trailing newline, an empty file and a CRLF file", async () => {
    for (const [name, before, expected] of [
      ["NoEnd.md", "# No end\ntext", "# No end\ntext\n[[Roadmap]]\n"],
      ["Empty.md", "", "[[Roadmap]]\n"],
      ["Crlf.md", "# Crlf\r\nline\r\n", "# Crlf\r\nline\r\n[[Roadmap]]\r\n"],
    ] as const) {
      await put(name, before);
      await vault.reconcile();
      expect((await drawLink(vault, flushed, name, "Roadmap.md")).outcome).toBe("linked");
      expect(await read(name)).toBe(expected);
      expect(added(before, expected)).toEqual(["[[Roadmap]]"]);
    }
  });

  it("flushes the editor's pending edits before reading, keeps them, and links after them", async () => {
    const calls: string[] = [];
    const readPage = vault.readPage.bind(vault);
    vault.readPage = async (path) => (calls.push(`read ${path}`), readPage(path));
    const flushAll = async () => {
      calls.push("flush");
      const page = await readPage("Atlas.md");
      await vault.writePage("Atlas.md", `${page.source}Unsaved edit.\n`, { expectedHash: page.hash });
      return true;
    };
    expect((await drawLink(vault, flushAll, "Atlas.md", "Roadmap.md")).outcome).toBe("linked");
    expect(calls[0]).toBe("flush");
    expect(await read("Atlas.md")).toBe("# Atlas\n\nSome text.\nUnsaved edit.\n[[Roadmap]]\n");
  });

  it("writes nothing when the flush fails", async () => {
    expect((await drawLink(vault, async () => false, "Atlas.md", "Roadmap.md")).outcome).toBe("changed");
    expect(await read("Atlas.md")).toBe("# Atlas\n\nSome text.\n");
  });

  it("a conflict reads again and retries once, keeping the outside change", async () => {
    const write = vault.writePage.bind(vault);
    let first = true;
    vault.writePage = async (path, source, options) => {
      if (first) {
        first = false;
        await writeFile(join(root, path), "# Atlas\n\nEdited elsewhere.\n");
      }
      return write(path, source, options);
    };
    expect((await drawLink(vault, flushed, "Atlas.md", "Roadmap.md")).outcome).toBe("linked");
    expect(await read("Atlas.md")).toBe("# Atlas\n\nEdited elsewhere.\n[[Roadmap]]\n");
  });

  it("two conflicts write nothing of ours and say the page changed", async () => {
    const write = vault.writePage.bind(vault);
    let n = 0;
    vault.writePage = async (path, source, options) => {
      await writeFile(join(root, path), `# Atlas\n\nEdit ${++n}.\n`);
      return write(path, source, options);
    };
    expect((await drawLink(vault, flushed, "Atlas.md", "Roadmap.md")).outcome).toBe("changed");
    expect(await read("Atlas.md")).toBe("# Atlas\n\nEdit 2.\n");
  });

  it("undo puts back the original bytes", async () => {
    for (const [name, before] of [["NoEnd.md", "# No end\ntext"], ["Crlf.md", "# Crlf\r\nline\r\n"], ["Empty.md", ""]] as const) {
      await put(name, before);
      await vault.reconcile();
      const { undo } = await drawLink(vault, flushed, name, "Roadmap.md");
      expect(await undo!()).toBe("undone");
      expect(await read(name)).toBe(before);
    }
    const { undo } = await drawLink(vault, flushed, "Atlas.md", "Roadmap.md");
    expect(await undo!()).toBe("undone");
    expect(await read("Atlas.md")).toBe("# Atlas\n\nSome text.\n");
  });

  it("undo leaves the page alone when the link line was edited or another line follows it", async () => {
    const { undo } = await drawLink(vault, flushed, "Atlas.md", "Roadmap.md");
    await writeFile(join(root, "Atlas.md"), "# Atlas\n\nSome text.\n[[Roadmap]] is next\n");
    expect(await undo!()).toBe("changed");
    expect(await read("Atlas.md")).toBe("# Atlas\n\nSome text.\n[[Roadmap]] is next\n");
    await writeFile(join(root, "Atlas.md"), "# Atlas\n\nSome text.\n[[Roadmap]]\nMore.\n");
    expect(await undo!()).toBe("changed");
    expect(await read("Atlas.md")).toBe("# Atlas\n\nSome text.\n[[Roadmap]]\nMore.\n");
  });

  it("undo flushes the editor first and writes nothing when that fails", async () => {
    let flushes = 0;
    let ok = true;
    const { undo } = await drawLink(vault, async () => (flushes++, ok), "Atlas.md", "Roadmap.md");
    ok = false;
    expect(await undo!()).toBe("changed");
    expect(flushes).toBe(2);
    expect(await read("Atlas.md")).toBe("# Atlas\n\nSome text.\n[[Roadmap]]\n");
  });

  it("a missing target or source is gone; a page already linked is left alone; a page never links itself", async () => {
    expect((await drawLink(vault, flushed, "Atlas.md", "Nowhere.md")).outcome).toBe("gone");
    expect((await drawLink(vault, flushed, "Nowhere.md", "Roadmap.md")).outcome).toBe("gone");
    await put("Linked.md", "# Linked\n\nSee [[Roadmap]].\n");
    await vault.reconcile();
    const result = await drawLink(vault, flushed, "Linked.md", "Roadmap.md");
    expect(result).toEqual({ outcome: "linked" });
    expect(await read("Linked.md")).toBe("# Linked\n\nSee [[Roadmap]].\n");
    expect((await drawLink(vault, flushed, "Atlas.md", "Atlas.md")).outcome).toBe("changed");
    expect(await read("Atlas.md")).toBe("# Atlas\n\nSome text.\n");
  });
});
