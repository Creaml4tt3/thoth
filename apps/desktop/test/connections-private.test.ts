// Connections in the Private Space (ADR-0050 rule 6), on a real vault without a window: links and backlinks from the
// index, mentions found through the search index (Thai too), and a mention linked with compare-and-swap.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNodeVault } from "@thoth/local-store/node";
import type { Vault } from "@thoth/local-store";
import { privateConnectionsSource } from "../src/features/editor/PrivateConnections.tsx";

let root: string;
let vault: Vault;
const put = async (path: string, text: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
};
const read = (path: string) => readFile(join(root, path), "utf8");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-connections-"));
  await put("Projects/Atlas.md", "# Atlas\n\nSee [[Roadmap]].\n");
  await put("Roadmap.md", "# Roadmap\n");
  await put("Index.md", "# Index\n\n[[Atlas]] and Atlas again.\n");
  await put("Notes/Meeting.md", "# Meeting\n\nWe talked about atlas and `Atlas` code.\n");
  await put("Notes/Unrelated.md", "# Unrelated\n\nAtlases are books.\n");
  await put("ทอธ.md", "# ทอธ\n");
  await put("ไทย.md", "# ไทย\n\nฉันใช้ทอธทุกวัน\n");
  ({ vault } = await openNodeVault(root));
});
afterEach(async () => {
  await vault.close();
  await rm(root, { recursive: true, force: true });
});

const source = (path: string, title: string, flushAll = async () => true) => privateConnectionsSource(vault, path, title, { revision: 0, open: () => undefined, flushAll });

describe("Private Space connections", () => {
  it("lists links and backlinks from the index", async () => {
    const atlas = source("Projects/Atlas.md", "Atlas");
    expect((await atlas.links()).map((p) => p.ref)).toEqual(["Roadmap.md"]);
    expect((await atlas.backlinks()!).map((p) => p.ref)).toEqual(["Index.md"]);
  });

  it("finds mentions outside code, skips pages that already link and word-edge misses", async () => {
    const { rows } = await source("Projects/Atlas.md", "Atlas").mentions()!;
    expect(rows.map((r) => [r.page.ref, r.mention.text])).toEqual([["Notes/Meeting.md", "atlas"]]);
  });

  it("finds a Thai title inside Thai text", async () => {
    const { rows } = await source("ทอธ.md", "ทอธ").mentions()!;
    expect(rows.map((r) => r.page.ref)).toEqual(["ไทย.md"]);
  });

  it("links one mention with the shortest wikilink, keeping the words as written", async () => {
    const atlas = source("Projects/Atlas.md", "Atlas");
    const [row] = (await atlas.mentions()!).rows;
    expect(await atlas.link!(row!)).toBe("linked");
    expect(await read("Notes/Meeting.md")).toBe("# Meeting\n\nWe talked about [[Atlas|atlas]] and `Atlas` code.\n");
    expect((await vault.backlinks("Projects/Atlas.md")).map((b) => b.sourcePath)).toContain("Notes/Meeting.md");
  });

  it("writes nothing when an open page's edits could not be written first", async () => {
    const atlas = source("Projects/Atlas.md", "Atlas", async () => false);
    const [row] = (await atlas.mentions()!).rows;
    expect(await atlas.link!(row!)).toBe("changed");
    expect(await read("Notes/Meeting.md")).toContain("about atlas and");
  });
});
