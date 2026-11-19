// What the Board draws: notes and strings from the index graph and a board file.
import { describe, expect, it } from "vitest";
import { boardNotes, folderColor, overviewNotes, suggestions } from "../src/board/model.ts";
import { parseCanvas } from "../src/board/canvas.ts";

const page = (path: string, tags: string[] = []) => ({ id: path, path, title: path.replace(/^.*\//, "").replace(/\.md$/, ""), tags, excerpt: `about ${path}` });
const canvas = (...files: string[]) =>
  parseCanvas(JSON.stringify({ nodes: files.map((f, i) => ({ id: `n${i}`, type: "file", file: f, x: i * 500, y: 10, width: 160, height: 120 })) }));

describe("folderColor", () => {
  it("takes the nearest coloured folder, own folder first", () => {
    expect(folderColor("Projects/2026/x.md", { Projects: "blue" })).toBe("blue");
    expect(folderColor("Projects/2026/x.md", { "Projects/2026": "red", Projects: "blue" })).toBe("red");
    expect(folderColor("Projects/2026/x.md", {})).toBeNull();
    expect(folderColor("x.md", { Projects: "blue" })).toBeNull();
  });
  it("matches whole folder names and never inherited members", () => {
    expect(folderColor("Projects/x.md", { Pro: "red" })).toBeNull();
    expect(folderColor("constructor/x.md", {})).toBeNull();
    expect(folderColor("__proto__/x.md", {})).toBeNull();
  });
});

describe("suggestions", () => {
  const pages = ["A.md", "B.md", "C.md", "D.md", "E.md"].map((p) => page(p));
  const links = [
    { from: "A.md", to: "B.md" },
    { from: "C.md", to: "A.md" },
    { from: "C.md", to: "B.md" },
    { from: "D.md", to: "E.md" },
  ];
  it("ranks unpinned neighbours by links to pinned pages, then title; never pinned or unlinked ones", () => {
    expect(suggestions({ pages, links }, ["A.md", "B.md"])).toEqual(["C.md"]);
    expect(suggestions({ pages, links }, ["A.md"])).toEqual(["B.md", "C.md"]);
    expect(suggestions({ pages, links }, ["B.md", "A.md"]).includes("A.md")).toBe(false);
    expect(suggestions({ pages, links }, ["E.md"])).toEqual(["D.md"]);
  });
  it("puts the page with more pinned neighbours first, and caps at the limit", () => {
    const hub = { pages: ["P.md", "Q.md", "X.md", "Y.md"].map((p) => page(p)), links: [{ from: "P.md", to: "Y.md" }, { from: "Q.md", to: "Y.md" }, { from: "P.md", to: "X.md" }] };
    expect(suggestions(hub, ["P.md", "Q.md"])).toEqual(["Y.md", "X.md"]);
    expect(suggestions(hub, ["P.md", "Q.md"], 1)).toEqual(["Y.md"]);
    const many = { pages: [page("P.md"), ...Array.from({ length: 20 }, (_, i) => page(`n${i}.md`))], links: Array.from({ length: 20 }, (_, i) => ({ from: "P.md", to: `n${i}.md` })) };
    expect(suggestions(many, ["P.md"])).toHaveLength(12);
  });
});

describe("boardNotes", () => {
  const pages = [page("Projects/Plan.md", ["a"]), page("Projects/Idea.md"), page("Misc/Far.md"), page("Lone.md")];
  const links = [
    { from: "Projects/Plan.md", to: "Projects/Idea.md" },
    { from: "Misc/Far.md", to: "Projects/Plan.md" },
  ];
  const colors = { Projects: "blue" };

  it("places pinned notes at the canvas position, with colour, tags and link count", () => {
    const { notes } = boardNotes({ pages, links }, canvas("Projects/Plan.md"), colors);
    const plan = notes.find((n) => n.path === "Projects/Plan.md")!;
    expect(plan).toMatchObject({ title: "Plan", tags: ["a"], color: "blue", x: 0, y: 10, state: "pinned", links: 2, excerpt: "about Projects/Plan.md" });
  });

  it("makes a missing note for a pinned path not in the index", () => {
    const { notes } = boardNotes({ pages, links }, canvas("Gone/Old.md"), colors);
    expect(notes).toEqual([{ path: "Gone/Old.md", title: "Old", excerpt: "", tags: [], color: null, x: 0, y: 10, state: "missing", links: 0 }]);
  });

  it("ignores non-markdown file nodes", () => {
    const c = parseCanvas(JSON.stringify({ nodes: [{ id: "i", type: "file", file: "pic.png", x: 0, y: 0, width: 1, height: 1 }] }));
    expect(boardNotes({ pages, links }, c, colors).notes).toEqual([]);
  });

  it("adds suggested notes near a pinned neighbour, not on top of it or of each other, with strings only between board notes", () => {
    const { notes, strings } = boardNotes({ pages, links }, canvas("Projects/Plan.md"), colors);
    expect(notes.filter((n) => n.state === "suggested").map((n) => n.path).sort()).toEqual(["Misc/Far.md", "Projects/Idea.md"]);
    expect(notes.some((n) => n.path === "Lone.md")).toBe(false);
    const spots = new Set(notes.map((n) => `${n.x},${n.y}`));
    expect(spots.size).toBe(notes.length);
    for (const n of notes.filter((n) => n.state === "suggested")) expect(Math.hypot(n.x - 0, n.y - 10)).toBeGreaterThanOrEqual(200);
    expect(strings).toHaveLength(2);
    // One string per pair, `from` before `to` by path.
    expect(strings.every((s) => s.from < s.to)).toBe(true);
    expect(boardNotes({ pages, links }, canvas("Projects/Plan.md"), colors)).toEqual({ notes, strings });
  });

  it("draws one string for a pair linked both ways", () => {
    const g = { pages: [page("A.md"), page("B.md")], links: [{ from: "A.md", to: "B.md" }, { from: "B.md", to: "A.md" }] };
    expect(boardNotes(g, canvas("A.md", "B.md"), {}).strings).toEqual([{ from: "A.md", to: "B.md" }]);
  });
});

describe("boardNotes edge cases", () => {
  it("draws no string between two pages that are off the board, and ignores self links", () => {
    const g = { pages: [page("A.md"), page("B.md"), page("C.md")], links: [{ from: "B.md", to: "C.md" }, { from: "A.md", to: "A.md" }] };
    const { notes, strings } = boardNotes(g, canvas("A.md"), {});
    expect(strings).toEqual([]);
    expect(notes.map((n) => n.path)).toEqual(["A.md"]);
  });
  it("places a suggestion next to the pinned neighbour with more links", () => {
    const g = {
      pages: ["Big.md", "Small.md", "S.md", "T1.md", "T2.md"].map((p) => page(p)),
      links: [{ from: "S.md", to: "Big.md" }, { from: "S.md", to: "Small.md" }, { from: "Big.md", to: "T1.md" }, { from: "T2.md", to: "Big.md" }],
    };
    const c = parseCanvas(JSON.stringify({ nodes: [{ id: "a", type: "file", file: "Big.md", x: 0, y: 0, width: 1, height: 1 }, { id: "b", type: "file", file: "Small.md", x: 5000, y: 5000, width: 1, height: 1 }] }));
    const s = boardNotes(g, c, {}).notes.find((n) => n.path === "S.md")!;
    expect(Math.hypot(s.x, s.y)).toBeLessThan(Math.hypot(s.x - 5000, s.y - 5000));
  });
  it("does not crash on a link to a pinned path that is not in the index", () => {
    const g = { pages: [page("A.md")], links: [{ from: "A.md", to: "Gone.md" }] };
    const { notes } = boardNotes(g, canvas("Gone.md"), {});
    expect(notes.map((n) => [n.path, n.state])).toEqual([["Gone.md", "missing"]]);
  });
});

describe("overviewNotes", () => {
  it("makes every page a free note at its position (origin if none) and every link a string", () => {
    const g = { pages: [page("A.md"), page("B.md")], links: [{ from: "B.md", to: "A.md" }] };
    const { notes, strings } = overviewNotes(g, {}, new Map([["A.md", { x: 5, y: 6 }]]));
    expect(notes.map((n) => [n.path, n.state, n.x, n.y, n.links])).toEqual([["A.md", "free", 5, 6, 1], ["B.md", "free", 0, 0, 1]]);
    expect(strings).toEqual([{ from: "A.md", to: "B.md" }]);
  });
});
