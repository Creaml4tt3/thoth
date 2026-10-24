import { describe, expect, it } from "vitest";
import type { TreeNode } from "@thoth/workspace-protocol";
import { dropZone } from "../src/order/dnd.ts";
import { compareSiblings, childrenOf, isWithin, nestWorkspaceTree } from "../src/workspace/tree.ts";
import { renameInMarkdown, titleFromMarkdown } from "../src/workspace/workspace-store.ts";
import { folderMarkdown, isFolderMarkdown } from "../src/workspace/folders.ts";

const T = "2026-10-24T00:00:00Z";
const node = (id: string, title: string, over: Partial<TreeNode> = {}): TreeNode => ({ id, parentId: null, title, revisionId: "r", updatedAt: T, ...over });

describe("sibling order (protocol page-order)", () => {
  it("puts positioned pages first, by key as bytes, then the rest A–Z, then by id", () => {
    const nodes = [node("1", "Mid"), node("2", "Abe"), node("3", "Zed", { position: "B" }), node("4", "Yan", { position: "A" }), node("5", "Abe")];
    expect(nestWorkspaceTree(nodes).map((i) => `${i.id}:${i.title}`)).toEqual(["4:Yan", "3:Zed", "2:Abe", "5:Abe", "1:Mid"]);
    // ASCII, not locale: "B" < "a".
    expect([node("a", "x", { position: "a" }), node("b", "y", { position: "B" })].sort((p, q) => compareSiblings(p, q)).map((n) => n.id)).toEqual(["b", "a"]);
  });

  it("ignores positions when the server keeps no order (A–Z only)", () => {
    const nodes = [node("1", "Zed", { position: "A" }), node("2", "Abe", { position: "B" })];
    expect(nestWorkspaceTree(nodes, { ordered: false }).map((i) => i.title)).toEqual(["Abe", "Zed"]);
    expect(childrenOf(nodes, null, false).map((n) => n.title)).toEqual(["Abe", "Zed"]);
  });

  it("treats a malformed or null position as none", () => {
    const nodes = [node("1", "Zed", { position: "has space" }), node("2", "Abe", { position: null }), node("3", "Mid", { position: "A" })];
    expect(nestWorkspaceTree(nodes).map((i) => i.title)).toEqual(["Mid", "Abe", "Zed"]);
  });

  it("orders each level on its own, marks folder pages, and survives a cycle", () => {
    const nodes = [node("p", "Parent"), node("c1", "Second", { parentId: "p", position: "B" }), node("c2", "First", { parentId: "p", position: "A" }), node("x", "Loop", { parentId: "y" }), node("y", "Loop2", { parentId: "x" })];
    const tree = nestWorkspaceTree(nodes, { isFolder: (id) => id === "p" });
    const parent = tree.find((i) => i.id === "p")!;
    expect(parent.folder).toBe(true);
    expect(parent.children.map((c) => c.title)).toEqual(["First", "Second"]);
    expect(parent.children.every((c) => !c.folder)).toBe(true);
    expect(tree.map((i) => i.id)).toContain("p"); // the cycle did not hang
  });

  it("finds a page's children in display order, and whether a page is below another", () => {
    const nodes = [node("p", "P"), node("a", "A", { parentId: "p" }), node("b", "B", { parentId: "a" }), node("orphan", "O", { parentId: "gone" })];
    expect(childrenOf(nodes, "p").map((n) => n.id)).toEqual(["a"]);
    expect(childrenOf(nodes, null).map((n) => n.id)).toEqual(["orphan", "p"]);
    expect(isWithin(nodes, "b", "p")).toBe(true);
    expect(isWithin(nodes, "p", "p")).toBe(true);
    expect(isWithin(nodes, "p", "b")).toBe(false);
  });
});

describe("rename in the page's text", () => {
  it("changes the first heading, and the title reads back as the new name", () => {
    const next = renameInMarkdown("# Plan\n\nBody.\n", "Roadmap");
    expect(next).toBe("# Roadmap\n\nBody.\n");
    expect(titleFromMarkdown(next, "")).toBe("Roadmap");
  });

  it("changes frontmatter `title:` rather than the heading, and keeps the rest of the file", () => {
    const source = "---\nthoth_id: 01HX\ntitle: Old\n---\n# Heading\n\nBody\n";
    const next = renameInMarkdown(source, "New: name");
    expect(titleFromMarkdown(next, "")).toBe("New: name");
    expect(next).toContain("thoth_id: 01HX");
    expect(next.endsWith("# Heading\n\nBody\n")).toBe(true);
  });

  it("leaves text without a title alone (the server's title carries the name)", () => {
    expect(renameInMarkdown("Just words.\n", "Notes")).toBe("Just words.\n");
    expect(renameInMarkdown(folderMarkdown("01890000-0000-7000-8000-000000000001"), "Research")).toBe(folderMarkdown("01890000-0000-7000-8000-000000000001"));
  });

  it("keeps CRLF files and the heading's own line ending", () => {
    expect(renameInMarkdown("# Plan\r\n\r\nBody\r\n", "Roadmap")).toBe("# Roadmap\r\n\r\nBody\r\n");
  });

  it("does not write a title that would not read back the same (a trailing #)", () => {
    expect(renameInMarkdown("# Plan\n", "C#")).toBe("# Plan\n");
  });

  it("does not touch malformed frontmatter", () => {
    const source = "---\ntitle: [unclosed\n---\n# Plan\n";
    expect(renameInMarkdown(source, "Other")).toBe(source);
  });
});

describe("folder pages", () => {
  it("are recognised by frontmatter alone, with the same text @thoth/transfer writes", () => {
    const id = "01890000-0000-7000-8000-000000000001";
    expect(folderMarkdown(id)).toBe(`---\nthoth_id: ${id}\nthoth_kind: folder\n---\n`);
    expect(isFolderMarkdown(folderMarkdown(id))).toBe(true);
    expect(isFolderMarkdown("---\nthoth_kind: page\n---\n# x\n")).toBe(false);
    expect(isFolderMarkdown("# thoth_kind: folder\n")).toBe(false);
    expect(isFolderMarkdown("---\nthoth_kind: folder\nthoth_kind: folder\n---\n")).toBe(false);
  });
});

describe("where a drop lands", () => {
  const both = { canContain: true, canOrder: true };
  it("splits a row that can hold others into edges and a middle", () => {
    expect(dropZone(2, 100, both)).toBe("before");
    expect(dropZone(50, 100, both)).toBe("inside");
    expect(dropZone(98, 100, both)).toBe("after");
  });
  it("splits a row that cannot hold others in two", () => {
    expect(dropZone(10, 100, { canContain: false, canOrder: true })).toBe("before");
    expect(dropZone(90, 100, { canContain: false, canOrder: true })).toBe("after");
  });
  it("without order only the middle of a row that can hold others counts", () => {
    expect(dropZone(2, 100, { canContain: true, canOrder: false })).toBeNull();
    expect(dropZone(50, 100, { canContain: true, canOrder: false })).toBe("inside");
    expect(dropZone(50, 100, { canContain: false, canOrder: false })).toBeNull();
  });
});
