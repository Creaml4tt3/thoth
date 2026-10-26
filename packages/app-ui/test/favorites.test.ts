import { describe, expect, it } from "vitest";
import { moveInGroup, toggleId } from "../src/favorites/list.ts";
import { createWorkspaceFavorites, WORKSPACE_FAVORITES_KEY } from "../src/favorites/workspace-favorites.ts";

/** A Storage that is a map, as localStorage is. */
function memory(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

describe("a list of favorites", () => {
  it("adds an id at the end, and takes it out again", () => {
    expect(toggleId(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(toggleId(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("moves an id to a place in its list, kept within the list", () => {
    expect(moveInGroup(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moveInGroup(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
    expect(moveInGroup(["a", "b"], "x", 0)).toEqual(["a", "b"]);
  });
});

describe("workspace favorites (per person, in this app only, ADR-0027)", () => {
  const scope = { server: "https://team.example", account: "usr_me", workspace: "ws_1" };

  it("keeps each account's favorites of each workspace apart, in order", () => {
    const storage = memory();
    const store = createWorkspaceFavorites(() => storage);
    store.set(scope, ["p1", "p2"]);
    store.set({ ...scope, account: "usr_other" }, ["p9"]);
    store.set({ ...scope, workspace: "ws_2" }, ["p3"]);
    expect(store.get(scope)).toEqual(["p1", "p2"]);
    expect(store.get({ ...scope, account: "usr_other" })).toEqual(["p9"]);
    expect(store.lists(scope.server, scope.account).map((l) => [l.workspace, l.pages])).toEqual([
      ["ws_1", ["p1", "p2"]],
      ["ws_2", ["p3"]],
    ]);
  });

  it("stores ids only, versioned, under one key; an empty list leaves nothing behind", () => {
    const storage = memory();
    const store = createWorkspaceFavorites(() => storage);
    store.set(scope, ["p1"]);
    expect(JSON.parse(storage.data.get(WORKSPACE_FAVORITES_KEY)!)).toEqual({ v: 1, lists: [{ server: scope.server, account: "usr_me", workspace: "ws_1", pages: ["p1"] }] });
    store.set(scope, []);
    expect(storage.data.has(WORKSPACE_FAVORITES_KEY)).toBe(false);
  });

  it("reads anything unreadable as no favorites, and drops entries it cannot read", () => {
    const storage = memory();
    const store = createWorkspaceFavorites(() => storage);
    for (const bad of ["{", "[]", '{"v":2,"lists":[]}', '{"v":1,"lists":"x"}']) {
      storage.setItem(WORKSPACE_FAVORITES_KEY, bad);
      expect(store.get(scope)).toEqual([]);
    }
    storage.setItem(WORKSPACE_FAVORITES_KEY, JSON.stringify({ v: 1, lists: [{ server: scope.server, account: "usr_me", workspace: "ws_1", pages: ["p1", 7, "", "p1", "p2"] }, { server: 1 }] }));
    expect(store.get(scope)).toEqual(["p1", "p2"]);
  });

  it("tells subscribers about a change here and in another window (the storage event)", () => {
    const storage = memory();
    const store = createWorkspaceFavorites(() => storage);
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.set(scope, ["p1"]);
    globalThis.dispatchEvent?.(Object.assign(new Event("storage"), { key: WORKSPACE_FAVORITES_KEY }));
    off();
    store.set(scope, ["p2"]);
    expect(calls).toBe(typeof globalThis.dispatchEvent === "function" ? 2 : 1);
  });

  it("lasts for the session when storage is unavailable", () => {
    const store = createWorkspaceFavorites(() => null);
    store.set(scope, ["p1"]);
    expect(store.get(scope)).toEqual(["p1"]);
  });
});
