import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Vault } from "../src/index.ts";
import { openNodeVault } from "../src/node/index.ts";

let root: string;
let vault: Vault;

async function put(path: string, content: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-graph-"));
  await put("A.md", "# A\n\nSee [[B]] and [[B]] again, [[missing]], [[A]] #idea\n");
  await put("B.md", "# B\n\nBack to [[A]] with ![pic](img.png)\n");
  await put("C.md", `# C\n\n\n${"x".repeat(200)}\nsecond line\n`);
  await put("D.md", "---\naliases: [Dee, Dd]\n---\n# D\n\nfirst real line\n");
  await put("E.md", "# E\n");
  await put("F.md", `# F\n\n${"ไทย😀".repeat(60)}\n`);
  await put("img.png", "not really a png");
  ({ vault } = await openNodeVault(root));
});

afterEach(async () => {
  await vault.close();
  await rm(root, { recursive: true, force: true });
});

describe("Vault.graph", () => {
  it("returns pages with tags and excerpts, and only resolved page-to-page links", async () => {
    const { pages, links } = await vault.graph();
    expect(pages.map((p) => p.path)).toEqual(["A.md", "B.md", "C.md", "D.md", "E.md", "F.md"]);
    const [a, b, c] = pages;
    expect(a).toMatchObject({ title: "A", tags: ["idea"], excerpt: "See [[B]] and [[B]] again, [[missing]], [[A]] #idea" });
    expect(b!.tags).toEqual([]);
    expect(c!.excerpt).toBe("x".repeat(140));
    const byPath = Object.fromEntries(pages.map((p) => [p.path, p]));
    expect(byPath["D.md"]!.excerpt).toBe("first real line");
    expect(byPath["E.md"]!.excerpt).toBe("");
    const f = byPath["F.md"]!.excerpt;
    expect(Array.from(f).length).toBe(140);
    expect(f).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(pages.every((p) => p.id.length > 0)).toBe(true);
    expect(links).toEqual([
      { from: "A.md", to: "B.md" },
      { from: "B.md", to: "A.md" },
    ]);
  });
});
