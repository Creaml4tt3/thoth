import { describe, expect, it } from "vitest";
import {
  activeTab,
  close,
  closeOthers,
  detach,
  initialTabs,
  isPinned,
  move,
  moveBy,
  newTab,
  open,
  parseTabs,
  pinnedCount,
  prune,
  serializeTabs,
  setPinned,
  type TabTarget,
  type TabsState,
} from "../src/tabs/model.ts";

const page = (path: string): TabTarget => ({ kind: "page", path });
const paths = (s: TabsState) => s.tabs.map((t) => (t.target.kind === "page" ? t.target.path : t.target.kind));
const pins = (s: TabsState) => s.tabs.map((t) => Boolean(t.pinned));
const idOf = (s: TabsState, path: string) => s.tabs.find((t) => t.target.kind === "page" && t.target.path === path)!.id;
const four = () => initialTabs([page("A.md"), page("B.md"), page("C.md"), page("D.md")], 2);

describe("pinning a tab (ADR-0027)", () => {
  it("moves it to the end of the pinned tabs at the start of the bar, and keeps it current", () => {
    let s = four();
    s = setPinned(s, idOf(s, "C.md"), true);
    expect(paths(s)).toEqual(["C.md", "A.md", "B.md", "D.md"]);
    expect(pins(s)).toEqual([true, false, false, false]);
    expect(activeTab(s).target).toEqual(page("C.md"));
    s = setPinned(s, idOf(s, "D.md"), true);
    expect(paths(s)).toEqual(["C.md", "D.md", "A.md", "B.md"]);
    expect(pinnedCount(s)).toBe(2);
    expect(isPinned(s, idOf(s, "D.md"))).toBe(true);
  });

  it("unpinning puts it first among the unpinned tabs", () => {
    let s = four();
    s = setPinned(setPinned(s, idOf(s, "C.md"), true), idOf(s, "D.md"), true);
    s = setPinned(s, idOf(s, "C.md"), false);
    expect(paths(s)).toEqual(["D.md", "C.md", "A.md", "B.md"]);
    expect(pins(s)).toEqual([true, false, false, false]);
  });

  it("returns the same state when nothing changes: already pinned, unknown id, or an empty tab", () => {
    let s = four();
    s = setPinned(s, idOf(s, "A.md"), true);
    expect(setPinned(s, idOf(s, "A.md"), true)).toBe(s);
    expect(setPinned(s, idOf(s, "B.md"), false)).toBe(s);
    expect(setPinned(s, "nope", true)).toBe(s);
    const blank = initialTabs();
    expect(setPinned(blank, blank.active, true)).toBe(blank); // nothing to keep
  });
});

describe("order rules with pinned tabs", () => {
  const pinnedTwo = () => {
    const s = four();
    return setPinned(setPinned(s, idOf(s, "A.md"), true), idOf(s, "B.md"), true); // A B | C D, C current
  };

  it("a drag or a move stops at the boundary: pinned among pinned, unpinned among unpinned", () => {
    const s = pinnedTwo();
    expect(paths(move(s, idOf(s, "D.md"), 0))).toEqual(["A.md", "B.md", "D.md", "C.md"]);
    expect(paths(move(s, idOf(s, "A.md"), 3))).toEqual(["B.md", "A.md", "C.md", "D.md"]);
    expect(move(s, idOf(s, "C.md"), 1)).toBe(s); // stopped at the boundary: it is already there
  });

  it("Alt/Option+Shift+Left and Right stop at the boundary too", () => {
    const s = pinnedTwo();
    expect(moveBy(s, idOf(s, "C.md"), -1)).toBe(s);
    expect(moveBy(s, idOf(s, "B.md"), 1)).toBe(s);
    expect(paths(moveBy(s, idOf(s, "B.md"), -1))).toEqual(["B.md", "A.md", "C.md", "D.md"]);
  });

  it("a new tab opened from a pinned tab goes after the pinned ones", () => {
    let s = pinnedTwo();
    s = { ...s, active: idOf(s, "A.md") };
    const n = newTab(s);
    expect(paths(n)).toEqual(["A.md", "B.md", "blank", "C.md", "D.md"]);
    expect(pins(n)).toEqual([true, true, false, false, false]);
    const o = open(s, page("E.md"), { newTab: true });
    expect(paths(o)).toEqual(["A.md", "B.md", "E.md", "C.md", "D.md"]);
  });

  it("a pinned tab keeps its page: opening another page in the current tab opens a new one beside the pinned tabs", () => {
    let s = pinnedTwo();
    s = { ...s, active: idOf(s, "B.md") };
    const o = open(s, page("E.md"));
    expect(paths(o)).toEqual(["A.md", "B.md", "E.md", "C.md", "D.md"]);
    expect(activeTab(o).target).toEqual(page("E.md"));
  });
});

describe("close rules with pinned tabs", () => {
  it("a pinned tab is not closed: close leaves the state as it was", () => {
    let s = four();
    s = setPinned(s, idOf(s, "C.md"), true);
    expect(close(s, idOf(s, "C.md"))).toBe(s);
    const unpinned = setPinned(s, idOf(s, "C.md"), false);
    expect(paths(close(unpinned, idOf(unpinned, "C.md")))).toEqual(["A.md", "B.md", "D.md"]);
  });

  it("Close other tabs closes every unpinned tab but the one asked for, never a pinned one", () => {
    let s = four();
    s = setPinned(s, idOf(s, "A.md"), true);
    const c = closeOthers(s, idOf(s, "C.md"));
    expect(paths(c)).toEqual(["A.md", "C.md"]);
    expect(activeTab(c).target).toEqual(page("C.md"));
    const fromPinned = closeOthers(s, idOf(s, "A.md"));
    expect(paths(fromPinned)).toEqual(["A.md"]);
    expect(activeTab(fromPinned).target).toEqual(page("A.md"));
  });

  it("pruning still closes a pinned background tab whose page is gone", () => {
    let s = four();
    s = setPinned(s, idOf(s, "A.md"), true);
    expect(paths(prune(s, (t) => t.kind === "page" && t.path === "A.md"))).toEqual(["B.md", "C.md", "D.md"]);
  });

  it("a pinned tab that leaves for a new window is pinned there", () => {
    let s = four();
    s = setPinned(s, idOf(s, "A.md"), true);
    const out = detach(s, idOf(s, "A.md"))!;
    expect(pins(out.moved)).toEqual([true]);
    expect(pins(parseTabs(serializeTabs(out.moved))!)).toEqual([true]);
  });
});

describe("storing pinned tabs", () => {
  it("restores which tabs are pinned and the current tab", () => {
    let s = four();
    s = setPinned(s, idOf(s, "B.md"), true);
    const back = parseTabs(serializeTabs(s))!;
    expect(paths(back)).toEqual(["B.md", "A.md", "C.md", "D.md"]);
    expect(pins(back)).toEqual([true, false, false, false]);
    expect(activeTab(back).target).toEqual(page("C.md"));
  });

  it("writes the pin as one more field of the tab, so the stored version stays 1", () => {
    const s = initialTabs([page("A.md")]);
    expect(JSON.parse(serializeTabs(setPinned(s, s.active, true)))).toEqual({ v: 1, active: 0, tabs: [{ k: "page", path: "A.md", pin: true }] });
    expect(JSON.parse(serializeTabs(s))).toEqual({ v: 1, active: 0, tabs: [{ k: "page", path: "A.md" }] });
  });

  it("reads tabs stored before pinning existed, and puts stray pinned tabs first", () => {
    const old = parseTabs(JSON.stringify({ v: 1, active: 1, tabs: [{ k: "page", path: "A.md" }, { k: "page", path: "B.md" }] }))!;
    expect(pins(old)).toEqual([false, false]);
    expect(activeTab(old).target).toEqual(page("B.md"));
    const stray = parseTabs(JSON.stringify({ v: 1, active: 2, tabs: [{ k: "page", path: "A.md" }, { k: "page", path: "B.md", pin: true }, { k: "page", path: "C.md", pin: "yes" }, { k: "blank", pin: true }] }))!;
    expect(paths(stray)).toEqual(["B.md", "A.md", "C.md", "blank"]);
    expect(pins(stray)).toEqual([true, false, false, false]); // only `true` pins, and an empty tab is never pinned
    expect(activeTab(stray).target).toEqual(page("C.md"));
  });
});
