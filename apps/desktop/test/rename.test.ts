// The rules of renaming in the Private Space tree, without a window: which title text follows the new name, and the
// rename itself on a real vault (ADR-0001 compare-and-swap, ADR-0016 rule 4).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNodeVault } from "@thoth/local-store/node";
import type { Vault } from "@thoth/local-store";
import { RenameError, renamePrivate, retitle } from "../src/features/shell/rename.ts";

describe("retitle: the title text that was the old name", () => {
  const to = (source: string) => retitle("New.md", source, "Old", "New");

  it("changes a first-level heading that says the old name, keeping the rest byte for byte", () => {
    expect(to("# Old\n\nBody\n")).toBe("# New\n\nBody\n");
    expect(to("---\nthoth_id: abc\n---\n# Old ##\n\nBody [[Old]]\n")).toBe("---\nthoth_id: abc\n---\n# New ##\n\nBody [[Old]]\n");
    expect(to("# Old\r\n\r\nBody\r\n")).toBe("# New\r\n\r\nBody\r\n");
  });

  it("changes a frontmatter title that says the old name, keeping every other key", () => {
    expect(to("---\ntags: [a, b]\ntitle: Old\nowner: ada # note\n---\nBody\n")).toBe("---\ntags: [a, b]\ntitle: New\nowner: ada # note\n---\nBody\n");
    expect(to('---\ntitle: "Old"\n---\nBody\n')).toBe("---\ntitle: New\n---\nBody\n");
    expect(to("---\ntitle: Old\n---\n# Old\n")).toBe("---\ntitle: New\n---\n# New\n");
  });

  it("leaves everything else alone: other titles, other headings, no title text, code, lower levels", () => {
    for (const source of [
      "# Something else\n",
      "---\ntitle: Custom\n---\n# Old heading\n",
      "---\ntitle: Custom\n---\nBody\n",
      "Just text about Old.\n",
      "## Old\n",
      "Old\n===\n", // a setext heading is not rewritten
      "```md\n# Old\n```\n",
      "> # Old\n",
      "# *Old*\n",
      "# Old and more\n",
      "---\ntitle: 2024\n---\n",
      "",
    ]) {
      expect(to(source), source).toBe(source);
    }
  });

  it("changes the first first-level heading only", () => {
    expect(to("Intro\n\n# Old\n\n# Old\n")).toBe("Intro\n\n# New\n\n# Old\n");
    expect(to("```\n# Old\n```\n\n# Old\n")).toBe("```\n# Old\n```\n\n# New\n");
  });

  it("does not write a name that would not read back as itself, and never rewrites malformed frontmatter", () => {
    expect(retitle("X.md", "# Old\n", "Old", "Tidy #")).toBe("# Old\n"); // a trailing ` #` would close the heading
    const broken = "---\ntitle: Old\ntitle: Dup\n---\n# Old\n";
    expect(retitle("X.md", broken, "Old", "New")).toBe("---\ntitle: Old\ntitle: Dup\n---\n# New\n");
    expect(retitle("X.md", "---\n{title: Old}\n---\nBody\n", "Old", "New")).toBe("---\n{title: Old}\n---\nBody\n");
  });

  it("copes with names that need quoting in YAML", () => {
    const out = retitle("X.md", "---\ntitle: Old\n---\nBody\n", "Old", "A: B # C");
    expect(out).toBe('---\ntitle: "A: B # C"\n---\nBody\n');
  });
});

describe("renamePrivate on a vault", () => {
  let root: string;
  let vault: Vault;
  const put = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const read = (path: string) => readFile(join(root, path), "utf8");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "thoth-rename-"));
    await put("Old.md", "# Old\n\nBody\n");
    await put("Linker.md", "See [[Old]] and [it](Old.md).\n");
    await put("Docs/Inner.md", "# Inner\n");
    ({ vault } = await openNodeVault(root));
  });
  afterEach(async () => {
    await vault.close();
    await rm(root, { recursive: true, force: true });
  });

  it("renames the page, follows links and the title text, and keeps the order entry in place", async () => {
    await vault.writeRecord(".thoth/order.json", { version: 1, folders: { "": ["Linker.md", "Old.md", "Docs"] } });
    const done = await renamePrivate(vault, "Old.md", " New ", { retitle: true });
    expect(done).toMatchObject({ from: "Old.md", to: "New.md", kind: "page", titleUpdated: true, titleSkipped: false });
    expect(done.order.folders[""]).toEqual(["Linker.md", "New.md", "Docs"]);
    expect(await read("New.md")).toBe("# New\n\nBody\n");
    expect(await read("Linker.md")).toBe("See [[New]] and [it](New.md).\n");
    expect((await vault.pageByPath("New.md"))?.title).toBe("New");
  });

  it("writes no order record just for a rename, and leaves the text alone when asked to", async () => {
    await renamePrivate(vault, "Old.md", "New", { retitle: false });
    expect(await read("New.md")).toBe("# Old\n\nBody\n");
    expect(await vault.readRecord(".thoth/order.json")).toBeUndefined();
  });

  it("renames a folder, with its order list, and does not touch its pages", async () => {
    await vault.writeRecord(".thoth/order.json", { version: 1, folders: { "": ["Docs", "Old.md"], Docs: ["Inner.md"] } });
    const done = await renamePrivate(vault, "Docs", "Papers", { retitle: true });
    expect(done).toMatchObject({ to: "Papers", kind: "folder", titleUpdated: false });
    expect(done.order.folders).toEqual({ "": ["Papers", "Old.md"], Papers: ["Inner.md"] });
    expect(await read("Papers/Inner.md")).toBe("# Inner\n");
  });

  it("keeps the extension, in any case", async () => {
    await put("Plain.markdown", "text\n");
    expect((await renamePrivate(vault, "Plain.markdown", "Other", { retitle: true })).to).toBe("Other.markdown");
  });

  it("refuses bad names and names taken in any letter case, before changing anything", async () => {
    await put("Other.md", "x\n");
    const refuse = async (name: string) => (await renamePrivate(vault, "Old.md", name, { retitle: true }).catch((e: unknown) => e)) as RenameError;
    expect((await refuse("")).problem).toBe("empty");
    expect((await refuse("a/b")).problem).toBe("separator");
    expect((await refuse("..")).problem).toBe("invalid");
    expect((await refuse(".thoth")).problem).toBe("reserved");
    expect((await refuse("a?b")).problem).toBe("invalid");
    expect((await refuse("other")).problem).toBe("exists");
    expect((await refuse("OTHER")).problem).toBe("exists");
    expect((await refuse("Linker")).problem).toBe("exists");
    expect(await read("Old.md")).toBe("# Old\n\nBody\n");
    expect(await read("Linker.md")).toBe("See [[Old]] and [it](Old.md).\n");
  });

  it("is a no-op for the same name, and allows a change of letter case only", async () => {
    expect((await renamePrivate(vault, "Old.md", "Old", { retitle: true })).to).toBe("Old.md");
    expect(await read("Old.md")).toBe("# Old\n\nBody\n");
    const done = await renamePrivate(vault, "Old.md", "OLD", { retitle: true });
    expect(done.to).toBe("OLD.md");
    expect(await read("OLD.md")).toBe("# OLD\n\nBody\n");
  });

  it("does not overwrite a page that changed after the move: the title is skipped and reported", async () => {
    const real = vault.readPage.bind(vault);
    vault.readPage = async (path) => {
      const read = await real(path);
      await writeFile(join(root, path), "Changed by another program.\n"); // between the read and the write
      return read;
    };
    const done = await renamePrivate(vault, "Old.md", "New", { retitle: true });
    expect(done).toMatchObject({ to: "New.md", titleUpdated: false, titleSkipped: true });
    expect(await read("New.md")).toBe("Changed by another program.\n");
  });
});
