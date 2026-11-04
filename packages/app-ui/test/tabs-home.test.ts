import { describe, expect, it } from "vitest";
import { HOME, TIMELINE, activate, activeTab, initialTabs, newTab, open, parseTabs, sameTarget, serializeTabs, type TabTarget, type TabsState } from "../src/tabs/model.ts";

const page = (path: string): TabTarget => ({ kind: "page", path });
const kinds = (s: TabsState) => s.tabs.map((t) => (t.target.kind === "page" ? t.target.path : t.target.kind));

describe("the Home tab (ADR-0029)", () => {
  it("is one tab: opening Home again goes to it", () => {
    let s = initialTabs([page("A.md")]);
    s = open(s, HOME);
    expect(kinds(s)).toEqual(["A.md", "home"]);
    s = open(activate(s, s.tabs[0]!.id), HOME);
    expect(kinds(s)).toEqual(["A.md", "home"]);
    expect(activeTab(s).target).toEqual(HOME);
  });

  it("takes an empty current tab, as Settings does", () => {
    expect(kinds(open(initialTabs(), HOME))).toEqual(["home"]);
    expect(kinds(open(newTab(initialTabs([page("A.md")])), HOME))).toEqual(["A.md", "home"]);
  });

  it("is not a page and not Settings", () => {
    expect(sameTarget(HOME, HOME)).toBe(true);
    expect(sameTarget(HOME, { kind: "blank" })).toBe(false);
    expect(sameTarget(HOME, { kind: "settings" })).toBe(false);
    expect(sameTarget({ kind: "blank" }, HOME)).toBe(false);
  });

  it("is stored as {k:\"home\"} and comes back on restart", () => {
    const s = open(initialTabs([page("A.md")]), HOME);
    const text = serializeTabs(s);
    expect(JSON.parse(text).tabs[1]).toEqual({ k: "home" });
    expect(kinds(parseTabs(text)!)).toEqual(["A.md", "home"]);
    expect(activeTab(parseTabs(text)!).target).toEqual(HOME);
  });
});

describe("the Timeline tab (ADR-0051)", () => {
  it("is one tab like Home, is stored and comes back on restart", () => {
    let s = open(initialTabs([page("A.md")]), TIMELINE);
    s = open(activate(s, s.tabs[0]!.id), TIMELINE);
    expect(kinds(s)).toEqual(["A.md", "timeline"]);
    expect(sameTarget(TIMELINE, HOME)).toBe(false);
    expect(kinds(parseTabs(serializeTabs(s))!)).toEqual(["A.md", "timeline"]);
  });
});
