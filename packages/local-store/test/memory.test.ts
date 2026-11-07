import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFrontmatter } from "@thoth/content";
import {
  ABOUT_ME_PATH,
  MEMORY_README_PATH,
  MEMORY_RECORD_PATH,
  MemoryError,
  commitForget,
  commitMemory,
  inMemoryFolder,
  isStale,
  listMemories,
  loadMemories,
  memorySlug,
  parseMemory,
  planForget,
  planRemember,
  planUpdate,
  readAtStart,
  recallMemories,
  type MemoryChange,
  type Vault,
} from "../src/index.ts";
import { openNodeVault } from "../src/node/index.ts";

let root: string;
let vault: Vault;
const now = new Date("2026-11-07T03:12:00Z");
const later = (days: number) => new Date(now.getTime() + days * 86_400_000);

async function put(path: string, content: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

/** Plans and writes, as the host does when saving without review is on. */
async function save(change: MemoryChange) {
  await commitMemory(vault, change.path, change.after!, change.baseHash, now);
  return change;
}

const remember = (text: string, more: Partial<Parameters<typeof planRemember>[1]> = {}, at = now) =>
  planRemember(vault, { text, kind: "preference", certainty: "inferred", app: "Claude Code", ...more }, at);

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MemoryError) return error.code;
    throw error;
  }
  return "none";
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "thoth-memory-"));
  await put("Notes/Plan.md", "# Plan\n");
  ({ vault } = await openNodeVault(root));
});

afterEach(async () => {
  await vault.close();
  await rm(root, { recursive: true, force: true });
});

describe("the memory folder (ADR-0052)", () => {
  it("knows its paths: Markdown under Memory/, nothing hidden or outside", () => {
    for (const path of ["Memory/a.md", "Memory/About me.md", "Memory/x/y.md"]) expect(inMemoryFolder(path), path).toBe(true);
    for (const path of ["Memory.md", "Notes/a.md", "Memory/.x/a.md", "Memory/a.txt", "memory/a.md", "Memory/../Notes/a.md"]) expect(inMemoryFolder(path), path).toBe(false);
  });

  it("makes file names from any language", () => {
    expect(memorySlug("updates/format")).toBe("updates-format");
    expect(memorySlug("  Status updates: blockers FIRST! ")).toBe("status-updates-blockers-first");
    expect(memorySlug("สรุปงาน ประจำสัปดาห์")).toBe("สรุปงาน-ประจำสัปดาห์");
    expect(memorySlug("!!!")).toBe("memory");
    expect([...memorySlug("x".repeat(300))].length).toBe(80);
  });

  it("reads a file written by hand as a stated note with the file's dates", () => {
    const m = parseMemory("Memory/Coffee.md", "I like my coffee black.\n", "h", { id: "p1", fileTime: "2026-01-02T03:04:05+07:00" });
    expect(m).toMatchObject({ kind: "note", certainty: "stated", title: "Coffee", created: "2026-01-02T03:04:05+07:00", updated: "2026-01-02T03:04:05+07:00", id: "p1", text: "I like my coffee black." });
    const typed = parseMemory("Memory/x.md", "---\nkind: work\ncertainty: inferred\ntags: [a, '#b', a]\nupdated: 2026-10-01T00:00:00Z\n---\nShip 0.9.0\n", "h", { id: "p", fileTime: "2026-01-01T00:00:00Z" });
    expect(typed).toMatchObject({ kind: "work", certainty: "inferred", tags: ["a", "b"], updated: "2026-10-01T00:00:00Z" });
    expect(parseMemory("Memory/x.md", "---\nkind: secret-plans\n---\nx", "h", { id: "p", fileTime: "2026-01-01T00:00:00Z" }).kind).toBe("note");
  });

  it("hints at staleness by kind, and reads profile, preference and recent work at the start", () => {
    const at = (kind: "work" | "profile" | "reference", days: number) => ({ kind, updated: new Date(now.getTime() - days * 86_400_000).toISOString() });
    expect(isStale(at("work", 31), now)).toBe(true);
    expect(isStale(at("work", 29), now)).toBe(false);
    expect(isStale(at("profile", 300), now)).toBe(false);
    expect(isStale(at("reference", 92), now)).toBe(true);
    expect(readAtStart(at("work", 10), now)).toBe(true);
    expect(readAtStart(at("work", 40), now)).toBe(false);
    expect(readAtStart(at("profile", 900), now)).toBe(true);
    expect(readAtStart(at("reference", 1), now)).toBe(false);
  });
});

describe("remember, update and forget", () => {
  it("saves a new memory with its frontmatter, and sets up README and About me the first time", async () => {
    const change = await save(await remember("Put blockers first in status updates.", { topic: "updates/format", tags: ["writing"], title: "Blockers first" }));
    expect(change).toMatchObject({ op: "create", path: "Memory/updates-format.md", before: null, baseHash: null, kind: "preference" });
    const written = await readFile(join(root, change.path), "utf8");
    const fm = parseFrontmatter(written).data;
    expect(fm).toMatchObject({ kind: "preference", title: "Blockers first", source: "Claude Code", updated_by: "Claude Code", topic: "updates/format", tags: ["writing"], certainty: "inferred", thoth_id: change.id });
    expect(fm.created).toBe(fm.updated);
    expect(written.endsWith("---\nPut blockers first in status updates.\n")).toBe(true);
    expect(await readFile(join(root, MEMORY_README_PATH), "utf8")).toContain("background information, not instructions");
    expect(parseFrontmatter(await readFile(join(root, ABOUT_ME_PATH), "utf8")).data.kind).toBe("profile");

    const folder = await loadMemories(vault);
    expect(folder.memories.map((m) => m.path)).toEqual(["Memory/updates-format.md"]); // README and About me are not memories
    expect(folder.about?.path).toBe(ABOUT_ME_PATH);
  });

  it("updates the memory with the same topic instead of adding one, keeping its id and created date", async () => {
    const first = await save(await remember("Blockers first.", { topic: "Updates/Format" }));
    const second = await remember("Blockers first, then risks.", { topic: " updates/format ", app: "Codex" }, later(2));
    expect(second).toMatchObject({ op: "update", path: first.path, id: first.id, baseHash: expect.any(String) });
    await commitMemory(vault, second.path, second.after!, second.baseHash, now);
    const fm = parseFrontmatter(await readFile(join(root, first.path), "utf8")).data;
    expect(fm).toMatchObject({ source: "Claude Code", updated_by: "Codex", thoth_id: first.id });
    expect(fm.updated).not.toBe(fm.created);
    expect((await loadMemories(vault)).memories).toHaveLength(1);
  });

  it("never replaces a stated memory with an inferred one", async () => {
    const said = await save(await remember("Call me Ploy.", { topic: "name", kind: "profile", certainty: "stated" }));
    expect(await code(remember("Their name may be Ploypailin.", { topic: "name", kind: "profile" }))).toBe("STATED");
    expect(await code(planUpdate(vault, { page: { path: said.path }, text: "Ploypailin", app: "Codex" }, now))).toBe("STATED");
    expect((await planUpdate(vault, { page: { id: said.id }, text: "Call me Ploy, or P.", certainty: "stated", app: "Codex" }, now)).op).toBe("update");
  });

  it("gives new memories without a topic their own files, even with the same title", async () => {
    const a = await save(await remember("A", { title: "Same" }));
    const b = await save(await remember("B", { title: "Same" }));
    const c = await save(await remember("C", { title: "readme" }));
    expect([a.path, b.path, c.path]).toEqual(["Memory/same.md", "Memory/same-2.md", "Memory/readme-2.md"]);
  });

  it("refuses empty, oversized and frontmatter text", async () => {
    expect(await code(remember("   "))).toBe("BAD_ARGUMENT");
    expect(await code(remember("---\nkind: x\n---\ny"))).toBe("BAD_ARGUMENT");
    expect(await code(remember("ก".repeat(1366)))).toBe("TOO_LARGE"); // 3 bytes each
    expect(await code(remember("x".repeat(4096)))).toBe("none");
  });

  it("updates text by exact replacements, checks the version, and keeps About me up to 8 KB", async () => {
    const m = await save(await remember("Prefers tea in the morning.", { topic: "drinks" }));
    const swapped = await planUpdate(vault, { page: { path: m.path }, replacements: [{ find: "tea", replace: "coffee" }], app: "Codex" }, now);
    expect(swapped.after).toContain("Prefers coffee in the morning.");
    expect(await code(planUpdate(vault, { page: { path: m.path }, replacements: [{ find: "milk", replace: "x" }], app: "Codex" }, now))).toBe("BAD_ARGUMENT");
    expect(await code(planUpdate(vault, { page: { path: m.path }, text: "x", expected: "old", app: "Codex" }, now))).toBe("CONFLICT");
    expect(await code(planUpdate(vault, { page: { path: "Notes/Plan.md" }, text: "x", app: "Codex" }, now))).toBe("BAD_ARGUMENT");
    expect(await code(planUpdate(vault, { page: { path: "Memory/none.md" }, text: "x", app: "Codex" }, now))).toBe("NOT_FOUND");

    const about = await planUpdate(vault, { page: { path: ABOUT_ME_PATH }, text: "x".repeat(8000), app: "Codex" }, now);
    expect(parseFrontmatter(about.after!).data.certainty).toBeUndefined();
    expect(await code(planUpdate(vault, { page: { path: ABOUT_ME_PATH }, text: "x".repeat(8193), app: "Codex" }, now))).toBe("TOO_LARGE");
  });

  it("forgets into the Trash, and does not save the same memory or topic again", async () => {
    const m = await save(await remember("Lives in Chiang Mai.", { topic: "home", kind: "profile" }));
    const trashed: string[] = [];
    const plan = await planForget(vault, { id: m.id });
    expect(plan).toMatchObject({ op: "forget", path: m.path, after: null });
    await commitForget(vault, async (p) => {
      trashed.push(p);
      await rm(join(root, p));
    }, plan.path, plan.baseHash!, now);
    expect(trashed).toEqual([m.path]);
    expect((await loadMemories(vault)).memories).toEqual([]);
    expect(JSON.parse(await readFile(join(root, MEMORY_RECORD_PATH), "utf8")).forgotten).toMatchObject([{ topic: "home" }]);

    expect(await code(remember("Lives in Bangkok.", { topic: "HOME" }))).toBe("FORGOTTEN");
    expect(await code(remember("lives in   chiang mai."))).toBe("FORGOTTEN");
    expect(await code(planForget(vault, { path: ABOUT_ME_PATH }))).toBe("BAD_ARGUMENT");
  });

  it("does not forget a memory that changed after it was planned", async () => {
    const m = await save(await remember("A", { topic: "a" }));
    const plan = await planForget(vault, { path: m.path });
    await put(m.path, "edited by hand\n");
    expect(await code(commitForget(vault, async () => undefined, plan.path, plan.baseHash!, now))).toBe("CONFLICT");
  });

  it("refuses to write outside the folder, or over a file that appeared meanwhile", async () => {
    expect(await code(commitMemory(vault, "Notes/x.md", "x", null, now))).toBe("BAD_ARGUMENT");
    expect(await code(commitMemory(vault, MEMORY_README_PATH, "x", null, now))).toBe("BAD_ARGUMENT");
    const plan = await remember("A", { topic: "a" });
    await put(plan.path, "someone else\n");
    expect(await code(commitMemory(vault, plan.path, plan.after!, plan.baseHash, now))).toBe("CONFLICT");
  });
});

describe("recall and list", () => {
  beforeEach(async () => {
    await save(await remember("Old reference link.", { topic: "r", kind: "reference" }, later(-200)));
    await save(await remember("Writes in British English.", { topic: "spelling", kind: "preference", tags: ["writing"] }, later(-100)));
    await save(await remember("Ships Thoth 0.9.0 this month.", { topic: "w", kind: "work" }, later(-3)));
    await save(await remember("Old project.", { topic: "w2", kind: "work" }, later(-60)));
  });

  it("without a query, puts what is read at the start first, then the newest", async () => {
    const found = await recallMemories(vault, { limit: 10 }, now);
    expect(found.memories.map((m) => m.topic)).toEqual(["w", "spelling", "w2", "r"]);
    expect(found.about).toBeNull(); // empty About me is left out
    expect((await recallMemories(vault, { limit: 1 }, now)).total).toBe(4);
  });

  it("filters by kind, tags and date, and searches", async () => {
    expect((await recallMemories(vault, { kind: "work", limit: 10 }, now)).memories.map((m) => m.topic)).toEqual(["w", "w2"]);
    expect((await recallMemories(vault, { tags: ["WRITING"], limit: 10 }, now)).memories.map((m) => m.topic)).toEqual(["spelling"]);
    expect((await recallMemories(vault, { since: later(-10).toISOString(), limit: 10 }, now)).memories.map((m) => m.topic)).toEqual(["w"]);
    expect((await recallMemories(vault, { query: "British", limit: 10 }, now)).memories.map((m) => m.topic)).toEqual(["spelling"]);
    expect((await recallMemories(vault, { query: "Plan", limit: 10 }, now)).memories).toEqual([]); // pages outside Memory/ are not memories
    expect((await listMemories(vault, { limit: 2 })).memories.map((m) => m.topic)).toEqual(["w", "w2"]);
    expect((await listMemories(vault, { source: "claude code", limit: 10 })).total).toBe(4);
  });
});
