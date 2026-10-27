import { describe, expect, it } from "vitest";
import { RECENT_KEEP, createRecentStore, parseRecent, pruneRecent, recentOf, recordRecent, remapRecent, serializeRecent, type RecentEntry, type RecentRef } from "../src/home/recent.ts";

const p = (path: string): RecentRef => ({ kind: "private", path });
const w = (page: string, workspace = "w1"): RecentRef => ({ kind: "workspace", server: "s", workspace, page });
const refs = (list: readonly RecentEntry[]) => list.map((e) => (e.ref.kind === "private" ? e.ref.path : `ws:${e.ref.workspace}/${e.ref.page}`));

function memory() {
  const map = new Map<string, string>();
  return { map, storage: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) } };
}

describe("recent pages (ADR-0029)", () => {
  it("puts the page opened last first, once", () => {
    let list: RecentEntry[] = [];
    list = recordRecent(list, p("A.md"), 1);
    list = recordRecent(list, w("x"), 2);
    list = recordRecent(list, p("B.md"), 3);
    list = recordRecent(list, p("A.md"), 4);
    expect(refs(list)).toEqual(["A.md", "B.md", "ws:w1/x"]);
    expect(list[0]!.at).toBe(4);
  });

  it(`keeps at most ${RECENT_KEEP}`, () => {
    let list: RecentEntry[] = [];
    for (let i = 0; i < RECENT_KEEP + 5; i++) list = recordRecent(list, p(`P${i}.md`), i);
    expect(list).toHaveLength(RECENT_KEEP);
    expect(refs(list)[0]).toBe(`P${RECENT_KEEP + 4}.md`);
  });

  it("follows a renamed page, and the pages of a renamed folder", () => {
    const list = [recordRecent([], p("Docs/Notes.md"), 1)[0]!, { ref: p("Docs.md"), at: 0 }, { ref: p("Other/Docs/x.md"), at: 0 }, { ref: w("Docs"), at: 0 }];
    expect(refs(remapRecent(list, "Docs", "Papers"))).toEqual(["Papers/Notes.md", "Docs.md", "Other/Docs/x.md", "ws:w1/Docs"]);
    expect(refs(remapRecent(list, "Docs/Notes.md", "Docs/Memo.md"))[0]).toBe("Docs/Memo.md");
    expect(remapRecent(list, "Nowhere", "X")).toBe(list);
  });

  it("drops pages that are gone, and returns the same list when none is", () => {
    const list = [{ ref: p("A.md"), at: 2 }, { ref: w("x"), at: 1 }];
    expect(refs(pruneRecent(list, (r) => r.kind === "workspace"))).toEqual(["A.md"]);
    expect(pruneRecent(list, () => false)).toBe(list);
  });

  it("is the page of a tab, and nothing for any other tab", () => {
    expect(recentOf({ kind: "page", path: "A.md" })).toEqual(p("A.md"));
    expect(recentOf({ kind: "workspace", server: "s", workspace: "w1", page: "x" })).toEqual(w("x"));
    for (const kind of ["home", "blank", "settings"] as const) expect(recentOf({ kind })).toBeNull();
  });

  it("stores ids and paths with a time, never a title, and reads back only what is sane", () => {
    const list = [{ ref: p("A.md"), at: 5 }, { ref: w("x"), at: 4 }];
    const text = serializeRecent(list)!;
    expect(JSON.parse(text)).toEqual({ v: 1, pages: [{ k: "page", path: "A.md", at: 5 }, { k: "ws", server: "s", workspace: "w1", page: "x", at: 4 }] });
    expect(parseRecent(text)).toEqual(list);
    expect(serializeRecent([])).toBeNull();
    for (const bad of [null, "", "{", "[]", '{"v":2,"pages":[]}', '{"v":1}']) expect(parseRecent(bad)).toEqual([]);
    const partly = JSON.stringify({ v: 1, pages: [{ k: "page", path: "A.md", at: 1 }, { k: "page", path: "", at: 1 }, { k: "ws", server: "s", page: "x", at: 1 }, { k: "page", path: "B.md" }, 7, { k: "page", path: "A.md", at: 0 }] });
    expect(refs(parseRecent(partly))).toEqual(["A.md", "B.md"]);
  });

  it("a store records, remaps and prunes in its key, and tells its listeners", () => {
    const { map, storage } = memory();
    const store = createRecentStore(() => storage, "k");
    let heard = 0;
    const stop = store.subscribe(() => heard++);
    store.record(p("A.md"), 1);
    store.record(p("B.md"), 2);
    expect(refs(store.get())).toEqual(["B.md", "A.md"]);
    store.remap("A.md", "C.md");
    store.prune((r) => r.kind === "private" && r.path === "B.md");
    expect(refs(store.get())).toEqual(["C.md"]);
    expect(refs(createRecentStore(() => storage, "k").get())).toEqual(["C.md"]); // another window reads the same key
    expect(heard).toBe(4);
    store.prune(() => true);
    expect(map.has("k")).toBe(false);
    stop();
  });
});
