import { BlockTypeSchema } from "@thoth/content";
import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { V1_BLOCK_NODES, markdownToDoc, thothExtensions, thothSchema } from "../src/index.ts";

describe("thothSchema", () => {
  const schema = thothSchema();

  it("has a node for every v1 block type of @thoth/content", () => {
    const v1 = BlockTypeSchema.options;
    expect(Object.keys(V1_BLOCK_NODES).sort()).toEqual([...v1].sort());
    for (const type of v1) {
      for (const node of V1_BLOCK_NODES[type]) expect(schema.nodes[node], `${type} -> ${node}`).toBeDefined();
    }
  });

  it("models blocks, inline nodes and marks", () => {
    for (const node of ["doc", "text", "paragraph", "heading", "list", "listItem", "taskList", "taskItem", "blockquote", "callout", "code", "table", "tableRow", "tableCell", "tableHeader", "thematicBreak", "image", "embed", "html", "math", "raw", "hardBreak", "wikilink", "inlineImage", "inlineRaw"]) {
      expect(schema.nodes[node], node).toBeDefined();
    }
    expect(Object.keys(schema.marks).sort()).toEqual(["bold", "highlight", "inlineCode", "italic", "link", "strike", "textColor", "underline"]);
  });

  it("is built from the extensions without a DOM", () => {
    expect("document" in globalThis).toBe(false);
    expect(Object.keys(getSchema(thothExtensions()).nodes)).toEqual(Object.keys(schema.nodes));
  });

  it("makes raw, html, math, embed and wikilink atoms", () => {
    for (const node of ["raw", "html", "math", "embed", "image", "wikilink", "inlineRaw", "inlineImage"]) {
      expect(schema.nodes[node]!.isAtom, node).toBe(true);
    }
  });

  it("keeps code blocks mark-free and table cells inline-only", () => {
    expect(schema.nodes["code"]!.spec.marks).toBe("");
    const cell = schema.nodes["tableCell"]!;
    expect(cell.contentMatch.matchType(schema.nodes["wikilink"]!)).not.toBeNull();
    expect(cell.contentMatch.matchType(schema.nodes["hardBreak"]!)).toBeNull();
  });

  it("accepts the documents it produces, node by node", () => {
    const source = "# T\n\n- [ ] a\n- b\n\n> [!note] x\n> y\n\n| a |\n|---|\n| b |\n\n![[e.png]]\n\n```js\nx\n```\n\n[^1]: n\n";
    const { doc } = markdownToDoc(source);
    expect(() => schema.nodeFromJSON(doc).check()).not.toThrow();
  });
});
