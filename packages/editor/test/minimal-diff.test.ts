import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc, stripSourceAttrs } from "../src/index.ts";
import { blocks, paragraph, pick, rng, textOf, withContent } from "./helpers.ts";

/** Well-separated blocks in deliberately non-canonical syntax. */
const SAFE = [
  "# Title",
  "* a\n* b",
  "__bold__ para one",
  "Setext\n======",
  "> quote\n> more",
  "```js\nconst a = 1;\n```",
  "last   para  ",
].join("\n\n") + "\n";

/** Blocks whose boundaries depend on their neighbours. */
const HAZARDS = [
  "para\n# Heading\ntext",
  "- a",
  "* b",
  "    indented code",
  "  spaced para",
  "> quote\nlazy",
  "1. x",
  "2) y",
  "plain",
].join("\n\n") + "\n";

const parts = (source: string) => {
  const { doc, frontmatter } = markdownToDoc(source);
  return { doc, frontmatter, list: blocks(doc) };
};
const render = (doc: JSONContent, frontmatter = "") => docToMarkdown(doc, { frontmatter });
const withBlocks = (doc: JSONContent, content: JSONContent[]): JSONContent => ({ ...doc, content });
const srcs = (doc: JSONContent) => blocks(doc).map((b) => b.attrs?.["mdSrc"] as string);
const semanticBlocks = (doc: JSONContent) => blocks(stripSourceAttrs(doc));

/** Canonical Markdown of a single block, without separators. */
const canonOf = (node: JSONContent) => render(stripSourceAttrs({ type: "doc", content: [node] })).trimEnd();

describe("editing one block changes only that block", () => {
  for (const eol of ["\n", "\r\n"]) {
    it(`edits a paragraph in a multi-block document (${JSON.stringify(eol)})`, () => {
      const source = SAFE.replace(/\n/g, eol);
      const { doc, list } = parts(source);
      const k = list.findIndex((b) => textOf(b).includes("para one"));
      const edited = list.map((b, i) => (i === k ? withContent(b, "edited paragraph with new words") : b));
      const expected = source.replace("__bold__ para one", "edited paragraph with new words");
      expect(render(withBlocks(doc, edited))).toBe(expected);
    });
  }

  it("changes only the bytes of that block, wherever it is", () => {
    const { doc, list } = parts(SAFE);
    list.forEach((block, k) => {
      if (block.type !== "paragraph" && block.type !== "heading") return;
      const edited = withContent(block, "EDITED");
      const newText = canonOf(edited);
      const expected = list.map((b, i) => `${b.attrs?.["mdSep"] as string}${i === k ? newText : (b.attrs?.["mdSrc"] as string)}`).join("") + "\n";
      expect(render(withBlocks(doc, list.map((b, i) => (i === k ? edited : b))))).toBe(expected);
    });
  });

  it("keeps a tight neighbour tight when its sibling is edited", () => {
    const source = "para\n# Heading\ntext\n> quote\n";
    const { doc, list } = parts(source);
    const out = render(withBlocks(doc, [withContent(list[0]!, "changed"), ...list.slice(1)]));
    expect(out).toBe("changed\n# Heading\ntext\n> quote\n");
  });

  it("preserves frontmatter, BOM and trailing text while editing", () => {
    const source = "﻿---\r\ntitle:   T\r\n---\r\n\r\n# Old\r\n\r\ntext\r\n\r\n";
    const { doc, frontmatter, list } = parts(source);
    const out = render(withBlocks(doc, [withContent(list[0]!, "New"), list[1]!]), frontmatter);
    expect(out).toBe("﻿---\r\ntitle:   T\r\n---\r\n\r\n# New\r\n\r\ntext\r\n\r\n");
  });

  it("emits CRLF for new canonical blocks in a CRLF document", () => {
    const source = "a\r\n\r\nb\r\n";
    const { doc, list } = parts(source);
    const out = render(withBlocks(doc, [...list, { type: "list", attrs: { ordered: false }, content: [{ type: "listItem", content: [paragraph("x")] }, { type: "listItem", content: [paragraph("y")] }] }]));
    expect(out).toBe("a\r\n\r\nb\r\n\r\n- x\r\n- y\r\n");
  });

  it("does not rewrite blocks it did not touch even when a block is retyped", () => {
    const { doc, list } = parts(SAFE);
    const k = list.findIndex((b) => b.type === "heading");
    const retyped: JSONContent = { type: "heading", attrs: { level: 3 }, content: list[k]!.content! };
    const out = render(withBlocks(doc, list.map((b, i) => (i === k ? retyped : b))));
    expect(out).toBe(SAFE.replace("# Title", "### Title"));
  });
});

describe("deleting, moving and inserting blocks never glues blocks together", () => {
  it("deletes any single block and keeps the others byte-identical", () => {
    const { doc, list } = parts(SAFE);
    list.forEach((_, i) => {
      const out = render(withBlocks(doc, list.filter((__, j) => j !== i)));
      expect(srcs(markdownToDoc(out).doc)).toEqual(srcs(doc).filter((__, j) => j !== i));
    });
  });

  it("moves any block to any position and keeps all blocks byte-identical", () => {
    const { doc, list } = parts(SAFE);
    for (let from = 0; from < list.length; from++) {
      for (let to = 0; to < list.length; to++) {
        const next = [...list];
        next.splice(to, 0, ...next.splice(from, 1));
        const out = render(withBlocks(doc, next));
        const expected = next.map((b) => b.attrs?.["mdSrc"] as string);
        expect(srcs(markdownToDoc(out).doc), `${from}->${to}`).toEqual(expected);
      }
    }
  });

  it("keeps a block's own separator when it is deleted next to it", () => {
    const source = "one\n\ntwo\n\n\n\nthree\n";
    const { doc, list } = parts(source);
    expect(render(withBlocks(doc, [list[0]!, list[2]!]))).toBe("one\n\n\n\nthree\n");
    expect(render(withBlocks(doc, [list[1]!, list[2]!]))).toBe("two\n\n\n\nthree\n");
  });

  it("inserts a block between tightly joined blocks without gluing", () => {
    const source = "para\n# Heading\ntext\n";
    const { doc, list } = parts(source);
    const out = render(withBlocks(doc, [list[0]!, paragraph("new"), ...list.slice(1)]));
    expect(srcs(markdownToDoc(out).doc).slice(0, 2)).toEqual(["para", "new"]);
    expect(blocks(markdownToDoc(out).doc)).toHaveLength(4);
  });

  it("separates two lists that would merge after the text between them is deleted", () => {
    const source = "- a\n\ntext\n\n- b\n";
    const { doc, list } = parts(source);
    const out = render(withBlocks(doc, [list[0]!, list[2]!]));
    expect(blocks(markdownToDoc(out).doc)).toHaveLength(2);
    expect(semanticBlocks(markdownToDoc(out).doc)).toEqual(semanticBlocks(withBlocks(doc, [list[0]!, list[2]!])));
  });

  it("needs the boundary check: without it the same deletion merges the lists", () => {
    const { doc, list } = parts("- a\n\ntext\n\n- b\n");
    const next = withBlocks(doc, [list[0]!, list[2]!]);
    expect(blocks(markdownToDoc(docToMarkdown(next, { verify: false })).doc)).toHaveLength(1);
    expect(blocks(markdownToDoc(docToMarkdown(next)).doc)).toHaveLength(2);
  });

  it("does not let an indented block be absorbed by a list it is moved behind", () => {
    const source = "text\n\n   indented para\n\n- item\n";
    const { doc, list } = parts(source);
    const out = render(withBlocks(doc, [list[2]!, list[1]!]));
    expect(blocks(markdownToDoc(out).doc)).toHaveLength(2);
  });

  it("keeps every permutation of hazardous blocks valid and semantically identical", () => {
    const { doc, list } = parts(HAZARDS);
    const r = rng(7);
    for (let n = 0; n < 300; n++) {
      const order = [...list];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      const keep = order.filter(() => r() < 0.85);
      if (keep.length === 0) continue;
      const out = render(withBlocks(doc, keep));
      expect(semanticBlocks(markdownToDoc(out).doc), JSON.stringify(out)).toEqual(keep.map((b) => stripSourceAttrs(b)));
    }
  });

  it("inserts new canonical blocks at every position of a hazardous document", () => {
    const { doc, list } = parts(HAZARDS);
    const inserts: JSONContent[] = [
      paragraph("new paragraph"),
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "New" }] },
      { type: "list", attrs: { ordered: false }, content: [{ type: "listItem", content: [paragraph("n")] }] },
      { type: "code", attrs: {}, content: [{ type: "text", text: "x" }] },
    ];
    for (const insert of inserts) {
      for (let at = 0; at <= list.length; at++) {
        const next = [...list.slice(0, at), insert, ...list.slice(at)];
        const out = render(withBlocks(doc, next));
        const expected = next.map((b) => (b === insert ? stripSourceAttrs(markdownToDoc(canonOf(b)).doc).content![0]! : stripSourceAttrs(b)));
        expect(semanticBlocks(markdownToDoc(out).doc), `${insert.type}@${at}`).toEqual(expected);
      }
    }
  });

  it("survives 300 random edit/delete/move/insert sequences", () => {
    const r = rng(2024);
    const { doc, list } = parts(HAZARDS + "\n" + SAFE);
    for (let n = 0; n < 300; n++) {
      let cur = [...list];
      for (let step = 0; step < 4; step++) {
        const i = Math.floor(r() * cur.length);
        const op = pick(r, ["edit", "delete", "move", "insert"] as const);
        if (op === "edit" && (cur[i]!.type === "paragraph" || cur[i]!.type === "heading")) cur[i] = withContent(cur[i]!, pick(r, ["x", "- y", "# z", "1. w", "a_b *c*"]));
        else if (op === "delete" && cur.length > 1) cur.splice(i, 1);
        else if (op === "move") cur.splice(Math.floor(r() * cur.length), 0, ...cur.splice(i, 1));
        else if (op === "insert") cur.splice(i, 0, paragraph(pick(r, ["new", "- new", "> new"])));
      }
      const out = render(withBlocks(doc, cur));
      const reparsed = semanticBlocks(markdownToDoc(out).doc);
      expect(reparsed, JSON.stringify(out)).toEqual(cur.map((b) => stripSourceAttrs(b)));
    }
  });
});
