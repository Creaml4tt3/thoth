import { describe, expect, it } from "vitest";
import { activate, activeTab, initialTabs, openOrFocus, setPinned, type TabTarget, type TabsState } from "../src/tabs/model.ts";

const page = (path: string): TabTarget => ({ kind: "page", path });
const ws = (id: string): TabTarget => ({ kind: "workspace", server: "s", workspace: "w1", page: id });
const paths = (s: TabsState) => s.tabs.map((t) => (t.target.kind === "page" ? t.target.path : t.target.kind === "workspace" ? `ws:${t.target.page}` : t.target.kind));

describe("opening what a notification is about (openOrFocus)", () => {
  it("switches to the tab that already shows the page, and changes nothing else", () => {
    const s0 = initialTabs([page("A.md"), page("B.md"), ws("p1")], 0);
    const s = openOrFocus(s0, page("B.md"));
    expect(paths(s)).toEqual(["A.md", "B.md", "ws:p1"]);
    expect(s.active).toBe(s0.tabs[1]!.id);
    expect(openOrFocus(s0, ws("p1")).active).toBe(s0.tabs[2]!.id);
  });

  it("opens it in a new tab after the current one otherwise, so the current page stays", () => {
    const s0 = initialTabs([page("A.md"), page("B.md")], 0);
    const s = openOrFocus(s0, page("C.md"));
    expect(paths(s)).toEqual(["A.md", "C.md", "B.md"]);
    expect(activeTab(s).target).toEqual(page("C.md"));
  });

  it("takes an empty current tab instead of adding one beside it", () => {
    const s0 = initialTabs([page("A.md"), { kind: "blank" }], 1);
    const s = openOrFocus(s0, page("C.md"));
    expect(paths(s)).toEqual(["A.md", "C.md"]);
    expect(s.active).toBe(s0.tabs[1]!.id);
  });

  it("finds a pinned tab on the page too, and leaves a pinned current tab on its own page", () => {
    let s0 = initialTabs([page("A.md"), page("B.md")], 0);
    s0 = setPinned(s0, s0.tabs[1]!.id, true); // B is pinned, first
    expect(openOrFocus(s0, page("B.md")).active).toBe(s0.tabs[0]!.id);
    const s = openOrFocus(activate(s0, s0.tabs[0]!.id), page("C.md"));
    expect(paths(s)).toEqual(["B.md", "C.md", "A.md"]);
  });

  it("returns the same state when the current tab already shows it", () => {
    const s0 = initialTabs([page("A.md")]);
    expect(openOrFocus(s0, page("A.md"))).toBe(s0);
  });
});
