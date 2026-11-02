// Duplicate in the Private Space (ADR-0046), on a real vault without a window: names, a folder's structure and order,
// links inside the copied set, structure only, images copied under a free name, and the clean-up after a failure.
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNodeVault } from "@thoth/local-store/node";
import { readOrder, writeOrder, type Vault } from "@thoth/local-store";
import { en } from "@thoth/app-ui/strings/en.ts";
import { duplicatePrivate, type PrivateDuplicate } from "../src/features/shell/duplicate.ts";

let root: string;
let vault: Vault;
const put = async (path: string, text: string | Uint8Array) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
};
const read = (path: string) => readFile(join(root, path), "utf8");
const exists = (path: string) => access(join(root, path)).then(() => true, () => false);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ID = "01HZZZZZZZZZZZZZZZZZZZZZZZ";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-duplicate-"));
  await put("Alpha.md", `---\nthoth_id: ${ID}\n---\n# Alpha\n\nSee [[Plan]] and [notes](Notes/Notes.md).\n\n![chart](chart.png)\n`);
  await put("chart.png", PNG);
  await put("Notes/Plan.md", "# Plan\n\nBack to [[Alpha]], on to [[Diary]] and [notes](Notes.md).\n\n![logo](../logo.png)\n");
  await put("Notes/Notes.md", "# Notes\n");
  await put("Notes/Old/Diary.md", "# Diary\n\n[plan](../Plan.md)\n");
  await put("Notes/Old/photo.png", PNG);
  await mkdir(join(root, "Notes/Empty"), { recursive: true });
  await put("logo.png", PNG);
  ({ vault } = await openNodeVault(root));
  await writeOrder(vault, { version: 1, folders: { "": ["Notes", "Alpha.md", "chart.png", "logo.png"], Notes: ["Plan.md", "Old", "Notes.md", "Empty"] }, colors: { Notes: "blue", "Notes/Old": "red" } });
});
afterEach(async () => {
  await vault.close();
  await rm(root, { recursive: true, force: true });
});

const run = (input: Partial<PrivateDuplicate> & Pick<PrivateDuplicate, "source" | "kind">) =>
  duplicatePrivate(vault, { into: "", structureOnly: false, label: en.tree.copyName, place: { siblings: ["Notes", "Alpha.md", "chart.png", "logo.png"], index: 2 }, ...input });

describe("Duplicate a page", () => {
  it("names it “(copy)”, then “(copy 2)”, with a new thoth_id and the title in its text, right after the original", async () => {
    const first = await run({ source: "Alpha.md", kind: "page" });
    expect(first.path).toBe("Alpha (copy).md");
    const text = await read("Alpha (copy).md");
    expect(text).toMatch(/^---\nthoth_id: \S+\n---\n# Alpha \(copy\)\n/);
    expect(text).not.toContain(ID);
    expect(first.order.folders[""]).toEqual(["Notes", "Alpha.md", "Alpha (copy).md", "chart.png", "logo.png"]);
    const second = await run({ source: "Alpha.md", kind: "page" });
    expect(second.path).toBe("Alpha (copy 2).md");
    expect(await read("Alpha.md")).toContain(`thoth_id: ${ID}`);
  });

  it("copies the images it shows next to the copy, under a free name, and points the copy at it", async () => {
    await run({ source: "Alpha.md", kind: "page" });
    expect(await readFile(join(root, "chart-2.png"))).toEqual(Buffer.from(PNG));
    const text = await read("Alpha (copy).md");
    expect(text).toContain("![chart](chart-2.png)");
    // Links to other pages still reach them.
    expect(text).toContain("See [[Plan]] and [notes](Notes/Notes.md).");
  });

  it("into another folder: links and images are written so they still reach what they reached", async () => {
    const made = await run({ source: "Alpha.md", kind: "page", into: "Notes/Old", place: { siblings: ["Diary.md", "photo.png"], index: 99 } });
    expect(made.path).toBe("Notes/Old/Alpha (copy).md");
    const text = await read(made.path);
    // A Markdown link also resolves from the top of the Private Space, so this one still reaches Notes/Notes.md.
    expect(text).toContain("[notes](Notes/Notes.md)");
    expect(text).toContain("![chart](chart.png)");
    expect(await exists("Notes/Old/chart.png")).toBe(true);
    expect(made.order.folders["Notes/Old"]).toEqual(["Diary.md", "photo.png", "Alpha (copy).md"]);
  });

  it("structure only keeps just the title", async () => {
    const made = await run({ source: "Alpha.md", kind: "page", structureOnly: true });
    expect(await read(made.path)).toMatch(/^---\nthoth_id: \S+\n---\n# Alpha \(copy\)\n$/);
    expect(await exists("chart-2.png")).toBe(false);
  });
});

describe("Duplicate a folder", () => {
  it("copies everything in it, with its order and colors; links inside the set reach the copies, others stay", async () => {
    const made = await run({ source: "Notes", kind: "folder" });
    expect(made.path).toBe("Notes (copy)");
    expect((await readdir(join(root, "Notes (copy)"))).sort()).toEqual(["Empty", "Notes.md", "Old", "Plan.md", "logo.png"]);
    expect((await readdir(join(root, "Notes (copy)/Old"))).sort()).toEqual(["Diary.md", "photo.png"]);
    expect(made.order.folders["Notes (copy)"]).toEqual(["Plan.md", "Old", "Notes.md", "Empty"]);
    expect(made.order.colors).toMatchObject({ Notes: "blue", "Notes/Old": "red", "Notes (copy)": "blue", "Notes (copy)/Old": "red" });
    expect(made.order.folders[""]).toEqual(["Notes", "Alpha.md", "Notes (copy)", "chart.png", "logo.png"]);

    const plan = await read("Notes (copy)/Plan.md");
    // [[Diary]] would be ambiguous now: it names the copy by its path. Relative links already reach the copies.
    expect(plan).toBe("# Plan\n\nBack to [[Alpha]], on to [[Notes (copy)/Old/Diary|Diary]] and [notes](Notes.md).\n\n![logo](logo.png)\n");
    expect(await read("Notes (copy)/Old/Diary.md")).toBe("# Diary\n\n[plan](../Plan.md)\n");
    // The image outside the folder is copied next to the page's copy; the original stays.
    expect(await readFile(join(root, "Notes (copy)/logo.png"))).toEqual(Buffer.from(PNG));
    expect(await read("Notes/Plan.md")).toContain("![logo](../logo.png)");
  });

  it("structure only: the folders and pages, each page with just its title, and no other files", async () => {
    await run({ source: "Notes", kind: "folder", structureOnly: true });
    expect(await read("Notes (copy)/Plan.md")).toMatch(/^---\nthoth_id: \S+\n---\n# Plan\n$/);
    expect(await exists("Notes (copy)/Old/photo.png")).toBe(false);
    expect(await exists("Notes (copy)/Empty")).toBe(true);
    expect((await readOrder(vault)).colors?.["Notes (copy)"]).toBe("blue");
  });

  it("removes everything it made when a write fails part-way, and writes no order", async () => {
    const write = vault.writeFileAtomic.bind(vault);
    let n = 0;
    vault.writeFileAtomic = async (...args) => {
      if (++n === 3) throw new Error("The disk is full.");
      return write(...args);
    };
    await expect(run({ source: "Notes", kind: "folder" })).rejects.toThrow("The disk is full.");
    expect(await exists("Notes (copy)")).toBe(false);
    expect((await readdir(root)).sort()).toEqual([".thoth", "Alpha.md", "Notes", "chart.png", "logo.png"]);
    expect((await readOrder(vault)).folders[""]).toEqual(["Notes", "Alpha.md", "chart.png", "logo.png"]);
  });
});
