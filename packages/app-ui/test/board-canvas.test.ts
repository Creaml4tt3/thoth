// Board file (JSON Canvas 1.0): read, merge and write without losing what other apps put in the file.
import { describe, expect, it } from "vitest";
import { applyChanges, CanvasError, newNodeId, parseCanvas, pinnedPaths, serializeCanvas, type CanvasNode } from "../src/board/canvas.ts";

// What Obsidian writes: every node type, an edge, a colour, and a top-level key Thoth does not know.
const OBSIDIAN = JSON.stringify(
  {
    nodes: [
      { id: "a1", type: "text", text: "# Idea", x: 0, y: 0, width: 250, height: 60, color: "4" },
      { id: "b2", type: "link", url: "https://example.com", x: 300, y: 0, width: 250, height: 60 },
      { id: "c3", type: "group", label: "Cluster", x: -50, y: -50, width: 700, height: 300 },
      { id: "d4", type: "file", file: "Notes/Plan.md", subpath: "#Goals", x: 20, y: 100, width: 400, height: 400 },
    ],
    edges: [{ id: "e1", fromNode: "a1", fromSide: "right", toNode: "d4", toSide: "left", label: "see" }],
    metadata: { version: "1.0", frontmatter: {} },
  },
  null,
  2,
) + "\n";

const file = (id: string, path: string, x = 0, y = 0): CanvasNode => ({ id, type: "file", file: path, x, y, width: 160, height: 120 });

describe("round trip", () => {
  it("writes back exactly what Obsidian wrote", () => {
    expect(serializeCanvas(parseCanvas(OBSIDIAN))).toBe(OBSIDIAN);
  });
  it("keeps the top-level key order and unknown keys", () => {
    const text = JSON.stringify({ zeta: 1, edges: [], nodes: [], alpha: { b: 1, a: 2 } }, null, 2) + "\n";
    expect(serializeCanvas(parseCanvas(text))).toBe(text);
  });
  it("reads a file with no nodes or edges as empty, and writes nothing it did not have", () => {
    const c = parseCanvas("{}");
    expect(c.nodes).toEqual([]);
    expect(c.edges).toEqual([]);
    expect(serializeCanvas(c)).toBe("{}\n");
  });
});

describe("applyChanges", () => {
  it("moves one note and changes only its x and y", () => {
    const before = parseCanvas(OBSIDIAN);
    const after = applyChanges(before, [{ kind: "move", id: "d4", x: 21.6, y: 99.4 }]);
    expect(after.nodes.find((n) => n.id === "d4")).toEqual({ id: "d4", type: "file", file: "Notes/Plan.md", subpath: "#Goals", x: 22, y: 99, width: 400, height: 400 });
    expect(Object.keys(after.nodes[3]!)).toEqual(Object.keys(before.nodes[3]!));
    expect(after.nodes.slice(0, 3)).toEqual(before.nodes.slice(0, 3));
    expect(after.edges).toEqual(before.edges);
    expect(after.raw.metadata).toEqual(before.raw.metadata);
  });
  it("does not change its input", () => {
    const before = parseCanvas(OBSIDIAN);
    applyChanges(before, [{ kind: "move", id: "a1", x: 5, y: 5 }, { kind: "unpin", id: "b2" }, { kind: "pin", node: file("n", "X.md") }]);
    expect(serializeCanvas(before)).toBe(OBSIDIAN);
  });
  it("pins at the end", () => {
    const after = applyChanges(parseCanvas(OBSIDIAN), [{ kind: "pin", node: file("n1", "New.md", 10.4, 20.5) }]);
    expect(after.nodes.at(-1)).toMatchObject({ id: "n1", file: "New.md", x: 10, y: 21 });
    expect(after.nodes).toHaveLength(5);
  });
  it("ignores a pin whose id is already on the board", () => {
    const after = applyChanges(parseCanvas(OBSIDIAN), [{ kind: "pin", node: file("a1", "New.md") }]);
    expect(after.nodes).toHaveLength(4);
    expect(after.nodes[0]).toMatchObject({ type: "text" });
  });
  it("unpins one note and leaves every edge, even one that points at it", () => {
    const before = parseCanvas(OBSIDIAN);
    const after = applyChanges(before, [{ kind: "unpin", id: "d4" }]);
    expect(after.nodes.map((n) => n.id)).toEqual(["a1", "b2", "c3"]);
    expect(after.edges).toEqual(before.edges);
  });
  it("drops a move or unpin for a note another app deleted", () => {
    const before = parseCanvas(OBSIDIAN);
    const after = applyChanges(before, [{ kind: "move", id: "gone", x: 1, y: 1 }, { kind: "unpin", id: "gone" }]);
    expect(serializeCanvas(after)).toBe(OBSIDIAN);
  });
  it("applies changes in order", () => {
    const after = applyChanges(parseCanvas("{}"), [{ kind: "pin", node: file("n", "A.md") }, { kind: "move", id: "n", x: 7, y: 8 }]);
    expect(after.nodes[0]).toMatchObject({ x: 7, y: 8 });
  });
});

describe("pinnedPaths", () => {
  it("lists Markdown file nodes in order, once each", () => {
    const c = applyChanges(parseCanvas(OBSIDIAN), [
      { kind: "pin", node: file("n1", "Deep/Two.MD") },
      { kind: "pin", node: file("n2", "Notes/Plan.md") },
      { kind: "pin", node: file("n3", "pic.png") },
      { kind: "pin", node: file("n4", "Long.markdown") },
    ]);
    expect(pinnedPaths(c)).toEqual(["Notes/Plan.md", "Deep/Two.MD", "Long.markdown"]);
  });
});

describe("newNodeId", () => {
  it("is 16 lowercase hex characters and differs each time", () => {
    const a = newNodeId();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(newNodeId()).not.toBe(a);
  });
});

describe("parseCanvas refuses what is not a canvas", () => {
  const node = { id: "a", type: "text", x: 0, y: 0, width: 1, height: 1 };
  it.each([
    ["invalid JSON", "{"],
    ["an array", "[]"],
    ["null", "null"],
    ["nodes that is not an array", '{"nodes":{}}'],
    ["edges that is not an array", '{"edges":"x"}'],
    ["a node without id", JSON.stringify({ nodes: [{ ...node, id: undefined }] })],
    ["a node without type", JSON.stringify({ nodes: [{ ...node, type: 3 }] })],
    ["a node without a number", JSON.stringify({ nodes: [{ ...node, width: "1" }] })],
    ["a node that is null", '{"nodes":[null]}'],
  ])("%s", (_name, text) => {
    expect(() => parseCanvas(text)).toThrow(CanvasError);
  });
});
