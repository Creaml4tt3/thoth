// Split view (ADR-0030): the layout of one window, as plain data.
import { describe, expect, it } from "vitest";
import { HOME, initialTabs, serializeTabs, setPinned, type TabTarget, type TabsState } from "../src/tabs/model.ts";
import * as L from "../src/tabs/layout.ts";

const page = (path: string): TabTarget => ({ kind: "page", path });
const names = (s: TabsState) => s.tabs.map((t) => (t.target.kind === "page" ? t.target.path : t.target.kind));
const shape = (l: L.Layout) => l.panes.map(names);
const current = (l: L.Layout) => L.activeTabOf(l).target;
const ids = (l: L.Layout) => l.panes.flatMap((p) => p.tabs.map((t) => t.id));
const idOf = (l: L.Layout, path: string) => l.panes.flatMap((p) => p.tabs).find((t) => t.target.kind === "page" && t.target.path === path)!.id;

const two = (): L.Layout => {
  const one = L.single(initialTabs([page("A.md"), page("B.md"), page("C.md")], 1));
  return L.split(one, idOf(one, "B.md"));
};

describe("splitting", () => {
  it("moves the tab into a new right pane, which becomes active", () => {
    const l = two();
    expect(shape(l)).toEqual([["A.md", "C.md"], ["B.md"]]);
    expect(l.active).toBe(1);
    expect(current(l)).toEqual(page("B.md"));
    expect(l.ratio).toBe(0.5);
  });

  it("leaves a new tab behind when the pane had only that tab", () => {
    const one = L.single(initialTabs([page("A.md")]));
    const l = L.split(one, one.panes[0]!.active);
    expect(shape(l)).toEqual([["blank"], ["A.md"]]);
    expect(new Set(ids(l)).size).toBe(2);
  });

  it("does not make a third pane: with two, a split moves the tab to the other pane", () => {
    const l = two();
    const again = L.split(l, idOf(l, "A.md"));
    expect(shape(again)).toEqual([["C.md"], ["B.md", "A.md"]]);
    expect(again.panes.length).toBe(L.MAX_PANES);
  });

  it("keeps every tab id unique across panes, also for tabs opened afterwards", () => {
    let l = two();
    l = L.newTab(l);
    l = L.focusPane(l, 0);
    l = L.newTab(l);
    expect(new Set(ids(l)).size).toBe(ids(l).length);
  });

  it("keeps a pinned tab pinned when it moves", () => {
    let one = L.single(initialTabs([page("A.md"), page("B.md")]));
    one = L.setPinned(one, idOf(one, "B.md"), true);
    const l = L.split(one, idOf(one, "B.md"));
    expect(l.panes[1]!.tabs[0]!.pinned).toBe(true);
  });
});

describe("moving between panes", () => {
  it("moves a tab to the other pane, after its current tab, and makes that pane active", () => {
    const l = L.moveToPane(two(), idOf(two(), "C.md"), 1);
    expect(shape(l)).toEqual([["A.md"], ["B.md", "C.md"]]);
    expect(l.active).toBe(1);
    expect(current(l)).toEqual(page("C.md"));
  });

  it("puts it at an index when one is given (a drop on the other tab bar)", () => {
    const l = L.moveToPane(two(), idOf(two(), "C.md"), 1, 0);
    expect(shape(l)).toEqual([["A.md"], ["C.md", "B.md"]]);
  });

  it("closes the pane whose last tab leaves, and the window is one pane again", () => {
    const l = L.moveToPane(two(), idOf(two(), "B.md"), 0);
    expect(shape(l)).toEqual([["A.md", "C.md", "B.md"]]);
    expect(l.active).toBe(0);
    expect(current(l)).toEqual(page("B.md"));
  });

  it("does nothing when the other pane is full", () => {
    let l = two();
    for (let i = 0; i < 40; i++) l = L.newTab(l);
    expect(l.panes[1]!.tabs.length).toBe(30);
    expect(L.moveToPane(l, idOf(l, "A.md"), 1)).toBe(l);
  });
});

describe("closing", () => {
  it("closing the last tab of a pane closes the pane", () => {
    const l = L.close(two(), idOf(two(), "B.md"));
    expect(shape(l)).toEqual([["A.md", "C.md"]]);
    expect(l.active).toBe(0);
  });

  it("a pinned last tab of a pane stays", () => {
    let l = two();
    l = L.setPinned(l, idOf(l, "B.md"), true);
    expect(L.close(l, idOf(l, "B.md"))).toBe(l);
  });

  it("closing the last tab of the only pane leaves a new tab, as before", () => {
    const one = L.single(initialTabs([page("A.md")]));
    expect(shape(L.close(one, one.panes[0]!.active))).toEqual([["blank"]]);
  });

  it("removeTab (a tab sent to a window) closes its pane when it was the last", () => {
    expect(shape(L.removeTab(two(), idOf(two(), "B.md")))).toEqual([["A.md", "C.md"]]);
  });
});

describe("the active pane", () => {
  it("next, previous and jump act within the active pane", () => {
    let l = two();
    l = L.focusPane(l, 0);
    expect(current(l)).toEqual(page("C.md"));
    l = L.step(l, 1);
    expect(current(l)).toEqual(page("A.md"));
    l = L.jump(l, 9);
    expect(current(l)).toEqual(page("C.md"));
    expect(l.panes[1]!.active).toBe(two().panes[1]!.active);
  });

  it("activating a tab in the other pane makes that pane active", () => {
    const l = L.activate(L.focusPane(two(), 0), idOf(two(), "B.md"));
    expect(l.active).toBe(1);
  });

  it("opens new pages in the active pane", () => {
    const l = L.open(L.focusPane(two(), 0), page("D.md"), { newTab: true });
    expect(shape(l)).toEqual([["A.md", "C.md", "D.md"], ["B.md"]]);
  });

  it("focusOther goes to the other pane, and does nothing with one", () => {
    expect(L.focusOther(two()).active).toBe(0);
    const one = L.single(initialTabs([page("A.md")]));
    expect(L.focusOther(one)).toBe(one);
  });
});

describe("one Home and one Settings per window", () => {
  it("openOrFocus finds a tab in either pane", () => {
    const l = L.openOrFocus(L.focusPane(two(), 0), page("B.md"));
    expect(l.active).toBe(1);
    expect(shape(l)).toEqual(shape(two()));
  });

  it("opening Home or Settings open in the other pane goes there", () => {
    let l = L.open(two(), HOME); // in the right pane (active)
    expect(shape(l)).toEqual([["A.md", "C.md"], ["B.md", "home"]]);
    l = L.focusPane(l, 0);
    l = L.open(l, HOME);
    expect(l.active).toBe(1);
    expect(current(l).kind).toBe("home");
    expect(shape(l)).toEqual([["A.md", "C.md"], ["B.md", "home"]]);
    l = L.open(L.focusPane(l, 0), { kind: "settings" });
    l = L.open(L.focusPane(l, 1), { kind: "settings", section: "agents" });
    expect(l.active).toBe(0);
    expect(current(l)).toEqual({ kind: "settings", section: "agents" });
    expect(shape(l).flat().filter((n) => n === "settings").length).toBe(1);
  });
});

describe("pages that move or go", () => {
  it("remapPaths and prune reach both panes", () => {
    let l = L.remapPaths(two(), "B.md", "Z.md");
    expect(shape(l)).toEqual([["A.md", "C.md"], ["Z.md"]]);
    // Each pane's current tab stays (it says "not found" itself); the left pane's current tab is C.
    l = L.prune(L.focusPane(l, 1), (t) => t.kind === "page" && (t.path === "A.md" || t.path === "C.md"));
    expect(shape(l)).toEqual([["C.md"], ["Z.md"]]);
  });
});

describe("detach (ADR-0019) from either pane", () => {
  it("sends a tab from the right pane, closing the pane when it was its last", () => {
    const out = L.detach(two(), idOf(two(), "B.md"))!;
    expect(names(out.moved)).toEqual(["B.md"]);
    expect(shape(out.source)).toEqual([["A.md", "C.md"]]);
  });

  it("a window's only tab cannot leave", () => {
    const one = L.single(initialTabs([page("A.md")]));
    expect(L.detach(one, one.panes[0]!.active)).toBeNull();
  });
});

describe("the split ratio", () => {
  it("is kept within range", () => {
    expect(L.setRatio(two(), 0.7).ratio).toBe(0.7);
    expect(L.setRatio(two(), 5).ratio).toBe(L.RATIO_MAX);
    expect(L.setRatio(two(), Number.NaN).ratio).toBe(0.5);
  });
});

describe("storage, v: 2", () => {
  it("round-trips panes, their tabs and current tabs, the active pane and the ratio", () => {
    let l = L.setRatio(two(), 0.62);
    l = L.setPinned(l, idOf(l, "A.md"), true);
    const text = L.serializeLayout(l);
    expect(JSON.parse(text).v).toBe(2);
    const back = L.parseLayout(text)!;
    expect(shape(back)).toEqual(shape(l));
    expect(back.active).toBe(1);
    expect(back.ratio).toBe(0.62);
    expect(current(L.focusPane(back, 0))).toEqual(page("C.md"));
    expect(back.panes[0]!.tabs[0]!.pinned).toBe(true);
    expect(new Set(ids(back)).size).toBe(ids(back).length);
  });

  it("reads v: 1 as one pane", () => {
    let s = initialTabs([page("A.md"), page("B.md")], 1);
    s = setPinned(s, s.tabs[0]!.id, true);
    const back = L.parseLayout(serializeTabs(s))!;
    expect(shape(back)).toEqual([["A.md", "B.md"]]);
    expect(current(back)).toEqual(page("B.md"));
    expect(back.panes[0]!.tabs[0]!.pinned).toBe(true);
    expect(back.ratio).toBe(0.5);
  });

  it("drops a pane with nothing readable, a second Home, and a bad ratio", () => {
    const raw = JSON.stringify({
      v: 2,
      active: 1,
      ratio: "wide",
      panes: [
        { active: 0, tabs: [{ k: "home" }, { k: "page", path: "A.md" }] },
        { active: 0, tabs: [{ k: "home" }, { k: "nope" }] },
      ],
    });
    const back = L.parseLayout(raw)!;
    expect(shape(back)).toEqual([["home", "A.md"]]);
    expect(back.active).toBe(0);
    expect(back.ratio).toBe(0.5);
  });

  it("applies `keep` to every pane", () => {
    const back = L.parseLayout(L.serializeLayout(two()), (t) => !(t.kind === "page" && t.path === "B.md"))!;
    expect(shape(back)).toEqual([["A.md", "C.md"]]);
  });

  it("gives null for anything unreadable", () => {
    expect(L.parseLayout("{")).toBeNull();
    expect(L.parseLayout(JSON.stringify({ v: 3 }))).toBeNull();
    expect(L.parseLayout(JSON.stringify({ v: 2, panes: [] }))).toBeNull();
  });
});
