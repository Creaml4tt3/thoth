import { describe, expect, it } from "vitest";
import {
  BLANK,
  MAX_TABS,
  activate,
  activeIndex,
  activeTab,
  close,
  detach,
  initialTabs,
  jump,
  move,
  moveBy,
  newTab,
  open,
  parseTabs,
  prune,
  remapPaths,
  retarget,
  sameTarget,
  serializeTabs,
  step,
  type TabTarget,
  type TabsState,
} from "../src/tabs/model.ts";
import { remoteGone, remoteTitle } from "../src/tabs/remote.ts";
import { clickOpens, isMiddleClick, isOpenInNewTabKey } from "../src/tabs/open-keys.ts";
import type { DirectoryState } from "../src/workspace/directory.ts";

const page = (path: string): TabTarget => ({ kind: "page", path });
const ws = (id: string, workspace = "w1"): TabTarget => ({ kind: "workspace", server: "s", workspace, page: id });
const paths = (s: TabsState) => s.tabs.map((t) => (t.target.kind === "page" ? t.target.path : t.target.kind));

describe("opening", () => {
  it("starts with one empty tab", () => {
    const s = initialTabs();
    expect(s.tabs).toHaveLength(1);
    expect(activeTab(s).target).toEqual(BLANK);
  });

  it("a click opens in the current tab", () => {
    let s = initialTabs([page("A.md"), page("B.md")], 0);
    s = open(s, page("C.md"));
    expect(paths(s)).toEqual(["C.md", "B.md"]);
    expect(activeIndex(s)).toBe(0);
  });

  it("Cmd/Ctrl+click, middle-click and Cmd/Ctrl+Enter open a new tab right after the current one, and show it", () => {
    let s = initialTabs([page("A.md"), page("B.md")], 0);
    s = open(s, page("C.md"), { newTab: true });
    expect(paths(s)).toEqual(["A.md", "C.md", "B.md"]);
    expect(activeIndex(s)).toBe(1);
    expect(new Set(s.tabs.map((t) => t.id)).size).toBe(3);
  });

  it("opens a page that is already open in a new tab too, as a browser does", () => {
    const s = open(initialTabs([page("A.md")]), page("A.md"), { newTab: true });
    expect(paths(s)).toEqual(["A.md", "A.md"]);
  });

  it("Settings is one tab: opening it again goes to it, and an empty current tab becomes Settings", () => {
    let s = initialTabs([page("A.md")]);
    s = open(s, { kind: "settings" });
    expect(paths(s)).toEqual(["A.md", "settings"]);
    expect(activeIndex(s)).toBe(1);
    s = activate(s, s.tabs[0]!.id);
    s = open(s, { kind: "settings", section: "servers" });
    expect(paths(s)).toEqual(["A.md", "settings"]);
    expect(activeTab(s).target).toEqual({ kind: "settings", section: "servers" });

    const blank = open(initialTabs(), { kind: "settings" });
    expect(paths(blank)).toEqual(["settings"]);
  });

  it("an assistant session is one tab per run: opening it again goes to it, and it survives a restart", () => {
    const RUN_A = "019e1a2b-3c4d-7e5f-8a6b-7c8d9e0f1a2b";
    const RUN_B = "019e1a2b-3c4d-7e5f-9a6b-7c8d9e0f1a2c";
    const run = (id: string): TabTarget => ({ kind: "agent-run", run: id });
    let s = initialTabs([page("A.md")]);
    s = open(s, run(RUN_A));
    s = open(activate(s, s.tabs[0]!.id), run(RUN_B));
    expect(s.tabs.map((t) => t.target)).toEqual([page("A.md"), run(RUN_B), run(RUN_A)]);
    s = open(activate(s, s.tabs[0]!.id), run(RUN_A));
    expect(s.tabs).toHaveLength(3);
    expect(activeTab(s).target).toEqual(run(RUN_A));
    // An empty tab is taken, as for Settings.
    expect(open(initialTabs(), run(RUN_A)).tabs.map((t) => t.target)).toEqual([run(RUN_A)]);
    expect(sameTarget(run(RUN_A), run(RUN_B))).toBe(false);
    expect(sameTarget(run(RUN_A), { kind: "settings" })).toBe(false);
    const back = parseTabs(serializeTabs(s))!;
    expect(back.tabs.map((t) => t.target)).toEqual([page("A.md"), run(RUN_B), run(RUN_A)]);
    expect(activeTab(back).target).toEqual(run(RUN_A));
  });

  it("drops a stored session tab whose run is not a UUIDv7, and the old single review tab (no run is current at start)", () => {
    const stored = (tabs: unknown[]) => JSON.stringify({ v: 1, active: 0, tabs });
    for (const bad of ["../../etc", "019e1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b", "", 42, null, "019E1A2B-3C4D-7E5F-8A6B-7C8D9E0F1A2B"]) {
      expect(parseTabs(stored([{ k: "run", run: bad }, { k: "page", path: "A.md" }]))!.tabs.map((t) => t.target)).toEqual([page("A.md")]);
    }
    expect(parseTabs(stored([{ k: "agents" }, { k: "page", path: "A.md" }]))!.tabs.map((t) => t.target)).toEqual([page("A.md")]);
  });

  it("a new tab is empty, goes after the current tab and is shown", () => {
    const s = newTab(initialTabs([page("A.md"), page("B.md")], 0));
    expect(paths(s)).toEqual(["A.md", "blank", "B.md"]);
    expect(activeTab(s).target).toEqual(BLANK);
  });

  it("stops adding tabs at the limit and uses the current tab instead", () => {
    let s = initialTabs(Array.from({ length: MAX_TABS }, (_, i) => page(`P${i}.md`)));
    s = open(s, page("Extra.md"), { newTab: true });
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(activeTab(s).target).toEqual(page("Extra.md"));
  });

  it("compares targets by what they show", () => {
    expect(sameTarget(page("A.md"), page("A.md"))).toBe(true);
    expect(sameTarget(page("A.md"), page("B.md"))).toBe(false);
    expect(sameTarget(ws("1"), ws("1"))).toBe(true);
    expect(sameTarget(ws("1"), ws("1", "w2"))).toBe(false);
    expect(sameTarget(page("A.md"), BLANK)).toBe(false);
  });
});

describe("closing", () => {
  it("the current tab passes to its right neighbour, else its left", () => {
    let s = initialTabs([page("A.md"), page("B.md"), page("C.md")], 1);
    s = close(s, s.active);
    expect(paths(s)).toEqual(["A.md", "C.md"]);
    expect(activeTab(s).target).toEqual(page("C.md"));
    s = close(s, s.active);
    expect(activeTab(s).target).toEqual(page("A.md"));
  });

  it("a background tab closes without changing the current tab", () => {
    const s0 = initialTabs([page("A.md"), page("B.md"), page("C.md")], 2);
    const s = close(s0, s0.tabs[0]!.id);
    expect(paths(s)).toEqual(["B.md", "C.md"]);
    expect(s.active).toBe(s0.active);
  });

  it("closing the last tab leaves one empty tab", () => {
    const s0 = initialTabs([page("A.md")]);
    const s = close(s0, s0.active);
    expect(paths(s)).toEqual(["blank"]);
    expect(s.active).not.toBe(s0.active);
  });

  it("ignores an id that is not a tab", () => {
    const s = initialTabs([page("A.md")]);
    expect(close(s, "nope")).toBe(s);
  });
});

describe("switching", () => {
  const three = initialTabs([page("A.md"), page("B.md"), page("C.md")], 0);

  it("Ctrl+Tab and Ctrl+Shift+Tab go round", () => {
    expect(activeTab(step(three, 1)).target).toEqual(page("B.md"));
    expect(activeTab(step(three, -1)).target).toEqual(page("C.md"));
    expect(activeTab(step(step(step(three, 1), 1), 1)).target).toEqual(page("A.md"));
  });

  it("with one tab, switching changes nothing", () => {
    const one = initialTabs([page("A.md")]);
    expect(step(one, 1)).toBe(one);
  });

  it("Cmd/Ctrl+1–8 jump to that tab, 9 to the last, a missing number does nothing", () => {
    expect(activeTab(jump(three, 2)).target).toEqual(page("B.md"));
    expect(activeTab(jump(three, 9)).target).toEqual(page("C.md"));
    expect(jump(three, 5)).toBe(three);
  });

  it("retargets a tab in place", () => {
    const s = retarget(three, three.tabs[1]!.id, page("Z.md"));
    expect(paths(s)).toEqual(["A.md", "Z.md", "C.md"]);
  });
});

describe("reordering (ADR-0019)", () => {
  const four = () => initialTabs([page("A.md"), page("B.md"), page("C.md"), page("D.md")], 1);

  it("moves a tab to a new place by pointer, and the same tab stays current", () => {
    const s0 = four();
    const s = move(s0, s0.tabs[0]!.id, 2);
    expect(paths(s)).toEqual(["B.md", "C.md", "A.md", "D.md"]);
    expect(activeTab(s).target).toEqual(page("B.md"));
    expect(s.active).toBe(s0.active);
    expect(new Set(s.tabs.map((t) => t.id))).toEqual(new Set(s0.tabs.map((t) => t.id)));
    const back = move(s, s0.tabs[3]!.id, 0);
    expect(paths(back)).toEqual(["D.md", "B.md", "C.md", "A.md"]);
  });

  it("keeps the place inside the list: past either end is the end", () => {
    const s0 = four();
    expect(paths(move(s0, s0.tabs[1]!.id, 99))).toEqual(["A.md", "C.md", "D.md", "B.md"]);
    expect(paths(move(s0, s0.tabs[2]!.id, -5))).toEqual(["C.md", "A.md", "B.md", "D.md"]);
  });

  it("returns the same state for no move, an unknown id or one tab", () => {
    const s0 = four();
    expect(move(s0, s0.tabs[2]!.id, 2)).toBe(s0);
    expect(move(s0, "nope", 0)).toBe(s0);
    const one = initialTabs([page("A.md")]);
    expect(move(one, one.active, 1)).toBe(one);
  });

  it("Alt/Option+Shift+Left and Right move the current tab one place, and stop at the ends", () => {
    let s = four(); // B is current, second
    s = moveBy(s, s.active, 1);
    expect(paths(s)).toEqual(["A.md", "C.md", "B.md", "D.md"]);
    s = moveBy(s, s.active, 1);
    expect(paths(s)).toEqual(["A.md", "C.md", "D.md", "B.md"]);
    const end = moveBy(s, s.active, 1);
    expect(end).toBe(s); // no wrap: the last place is the last place
    s = moveBy(moveBy(moveBy(s, s.active, -1), s.active, -1), s.active, -1);
    expect(paths(s)).toEqual(["B.md", "A.md", "C.md", "D.md"]);
    expect(moveBy(s, s.active, -1)).toBe(s);
    expect(activeTab(s).target).toEqual(page("B.md"));
  });

  it("the new order is what is stored and what comes back on restart", () => {
    const s0 = four();
    const s = move(s0, s0.tabs[3]!.id, 0);
    const back = parseTabs(serializeTabs(s))!;
    expect(paths(back)).toEqual(["D.md", "A.md", "B.md", "C.md"]);
    expect(activeTab(back).target).toEqual(page("B.md"));
  });
});

describe("moving a tab to a new window (ADR-0019)", () => {
  it("the window loses the tab and the new window gets it; both come back on restart", () => {
    const s0 = initialTabs([page("A.md"), page("B.md"), { kind: "settings" }], 1);
    const out = detach(s0, s0.tabs[1]!.id)!;
    expect(paths(out.source)).toEqual(["A.md", "settings"]);
    expect(activeTab(out.source).target).toEqual({ kind: "settings" }); // the current tab passed to its right
    expect(paths(out.moved)).toEqual(["B.md"]);
    expect(activeTab(out.moved).target).toEqual(page("B.md"));
    expect(paths(parseTabs(serializeTabs(out.source))!)).toEqual(["A.md", "settings"]);
    expect(paths(parseTabs(serializeTabs(out.moved))!)).toEqual(["B.md"]);
  });

  it("a background tab leaves without changing the current one", () => {
    const s0 = initialTabs([page("A.md"), page("B.md"), page("C.md")], 2);
    const out = detach(s0, s0.tabs[0]!.id)!;
    expect(out.source.active).toBe(s0.active);
    expect(paths(out.moved)).toEqual(["A.md"]);
  });

  it("the only tab of a window, or an unknown one, cannot leave", () => {
    const one = initialTabs([page("A.md")]);
    expect(detach(one, one.active)).toBeNull();
    expect(detach(initialTabs([page("A.md"), page("B.md")]), "nope")).toBeNull();
  });
});

describe("pruning", () => {
  it("closes background tabs that are gone and keeps the current one to say so", () => {
    const s0 = initialTabs([page("Gone.md"), page("Here.md"), page("Gone2.md")], 2);
    const s = prune(s0, (t) => t.kind === "page" && t.path.startsWith("Gone"));
    expect(paths(s)).toEqual(["Here.md", "Gone2.md"]);
    expect(activeTab(s).target).toEqual(page("Gone2.md"));
  });

  it("returns the same state when nothing is gone", () => {
    const s = initialTabs([page("A.md")]);
    expect(prune(s, () => false)).toBe(s);
  });
});

describe("renamed and moved pages", () => {
  const s0 = initialTabs([page("Docs/Notes.md"), page("Docs/Deep/Inner.md"), page("Docs.md"), ws("p1"), page("Other/Docs/x.md")], 1);

  it("a renamed page keeps its tab, and so does every page under a renamed folder", () => {
    expect(paths(remapPaths(s0, "Docs/Notes.md", "Docs/Memo.md"))).toEqual(["Docs/Memo.md", "Docs/Deep/Inner.md", "Docs.md", "workspace", "Other/Docs/x.md"]);
    const folder = remapPaths(s0, "Docs", "Papers");
    expect(paths(folder)).toEqual(["Papers/Notes.md", "Papers/Deep/Inner.md", "Docs.md", "workspace", "Other/Docs/x.md"]);
    expect(folder.active).toBe(s0.active); // same tabs, same current one
    expect(folder.tabs.map((t) => t.id)).toEqual(s0.tabs.map((t) => t.id));
  });

  it("returns the same state when no tab is on it", () => {
    expect(remapPaths(s0, "Nowhere", "Elsewhere")).toBe(s0);
    expect(remapPaths(s0, "Doc", "Papers")).toBe(s0); // a prefix of a name is not a parent folder
  });
});

describe("storage", () => {
  it("restores the same targets and the current tab", () => {
    const s0 = initialTabs([page("A.md"), ws("p1"), { kind: "settings", section: "servers" }, BLANK], 1);
    const back = parseTabs(serializeTabs(s0))!;
    expect(back.tabs.map((t) => t.target)).toEqual(s0.tabs.map((t) => t.target));
    expect(activeIndex(back)).toBe(1);
  });

  it("restores Settings opened at Import & Export", () => {
    const back = parseTabs(serializeTabs(initialTabs([{ kind: "settings", section: "import" }])))!;
    expect(back.tabs[0]!.target).toEqual({ kind: "settings", section: "import" });
  });

  it("keeps only ids for workspace pages: no title, no text, nothing but the three ids", () => {
    const text = serializeTabs(initialTabs([ws("page-id-1", "workspace-id-1")]));
    expect(JSON.parse(text)).toEqual({ v: 1, active: 0, tabs: [{ k: "ws", server: "s", workspace: "workspace-id-1", page: "page-id-1" }] });
  });

  it("falls back to nothing on unreadable text, and drops a tab it cannot read", () => {
    for (const bad of [null, undefined, "", "{", "[]", '{"v":2,"tabs":[]}', '{"v":1}', '{"v":1,"tabs":"x"}']) expect(parseTabs(bad as string | null)).toBeNull();
    const partly = parseTabs(JSON.stringify({ v: 1, active: 0, tabs: [{ k: "page", path: "A.md" }, { k: "page" }, { k: "nope" }, 7, null, { k: "ws", server: "s", workspace: "", page: "p" }] }))!;
    expect(paths(partly)).toEqual(["A.md"]);
  });

  it("lets the app drop targets it knows are invalid, and lands on a neighbour when the current tab is dropped", () => {
    const text = serializeTabs(initialTabs([page("A.md"), page("B.md"), page("C.md")], 1));
    const s = parseTabs(text, (t) => !(t.kind === "page" && t.path === "B.md"))!;
    expect(paths(s)).toEqual(["A.md", "C.md"]);
    expect(activeTab(s).target).toEqual(page("C.md"));
    const none = parseTabs(text, () => false)!;
    expect(paths(none)).toEqual(["blank"]);
  });

  it("never restores more than the limit", () => {
    const many = serializeTabs({ tabs: Array.from({ length: MAX_TABS + 10 }, (_, i) => ({ id: `t${i}`, target: page(`P${i}.md`) })), active: "t0", seq: 99 });
    expect(parseTabs(many)!.tabs).toHaveLength(MAX_TABS);
  });
});

describe("workspace pages in tabs", () => {
  const dir = (patch: Partial<DirectoryState["trees"][string]> | null, workspaces: { id: string }[] | null = [{ id: "w1" }], auth = "signed-in"): DirectoryState =>
    ({
      loaded: true,
      error: null,
      servers: [{ info: { id: "s", auth }, workspaces, error: null }],
      trees: patch === null ? {} : { "s\nw1": { nodes: [{ id: "p1", title: "Plan", parentId: null }], cursor: "1", loading: false, error: null, ticks: {}, kinds: {}, ...patch } },
      expanded: [],
      capabilities: {},
    }) as unknown as DirectoryState;
  const ref = { server: "s", workspace: "w1", page: "p1" };

  it("reads the title from the loaded tree and nowhere else", () => {
    expect(remoteTitle(dir({}), ref)).toBe("Plan");
    expect(remoteTitle(dir(null), ref)).toBeNull();
  });

  it("calls a page gone only when the server has said so", () => {
    expect(remoteGone(dir({}), ref)).toBe(false);
    expect(remoteGone(dir({}), { ...ref, page: "p2" })).toBe(true);
    expect(remoteGone(dir({}, [{ id: "other" }]), ref)).toBe(true);
    // Not known is not gone: loading, an error, no tree yet, signed out, an unknown server.
    expect(remoteGone(dir({ loading: true }), { ...ref, page: "p2" })).toBe(false);
    expect(remoteGone(dir({ error: "offline" }), { ...ref, page: "p2" })).toBe(false);
    expect(remoteGone(dir({ cursor: null }), { ...ref, page: "p2" })).toBe(false);
    expect(remoteGone(dir(null), ref)).toBe(false);
    expect(remoteGone(dir({ loading: true }, null), { ...ref, page: "p2" })).toBe(false);
    expect(remoteGone(dir({}, [{ id: "other" }], "signed-out"), ref)).toBe(false);
    expect(remoteGone(dir({}), { ...ref, server: "nope" })).toBe(false);
  });
});

describe("the gestures that open a new tab", () => {
  const mods = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  it("Cmd or Ctrl on a click", () => {
    expect(clickOpens({ metaKey: true, ctrlKey: false })).toEqual({ newTab: true });
    expect(clickOpens({ metaKey: false, ctrlKey: true })).toEqual({ newTab: true });
    expect(clickOpens({ metaKey: false, ctrlKey: false })).toBeUndefined();
  });
  it("the middle button", () => {
    expect(isMiddleClick({ button: 1 })).toBe(true);
    expect(isMiddleClick({ button: 0 })).toBe(false);
    expect(isMiddleClick({ button: 2 })).toBe(false);
  });
  it("Cmd/Ctrl+Enter and nothing else", () => {
    expect(isOpenInNewTabKey({ ...mods, key: "Enter", ctrlKey: true })).toBe(true);
    expect(isOpenInNewTabKey({ ...mods, key: "Enter", metaKey: true })).toBe(true);
    expect(isOpenInNewTabKey({ ...mods, key: "Enter" })).toBe(false);
    expect(isOpenInNewTabKey({ ...mods, key: "Enter", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isOpenInNewTabKey({ ...mods, key: "a", ctrlKey: true })).toBe(false);
  });
});
