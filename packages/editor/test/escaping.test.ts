import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc, stripSourceAttrs } from "../src/index.ts";
import { blocks, paragraph, pick, rng, textOf } from "./helpers.ts";

const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });
const heading = (level: number, text: string): JSONContent => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
const serialize = (d: JSONContent) => docToMarkdown(d);
const reparse = (md: string) => stripSourceAttrs(markdownToDoc(md).doc);

/** Metacharacters, block starters, delimiters and ordinary words. */
const TOKENS = [
  "*", "**", "_", "__", "`", "``", "~", "~~", "[", "]", "[[", "]]", "(", ")", "![", "](", "<", ">", "<b>", "&", "&amp;", "&#35;", "&copy",
  "#", "##", "###", "> ", "- ", "+ ", "* ", "1. ", "2) ", "10. ", "---", "***", "___", "===", "|", "| a |", "\\", "\\\\", "\\*", "\\#",
  "http://x.y/a_b", "https://z.org", "www.example.com", "a@b.co", ":", ";", "!", "?", ".", ",", "$$", "^id", "{", "}", "^", "%", "@",
  "word", "snake_case", "foo", "Thai ไทย", "🚀", "é", "1", "42", " ", " ", " ", "  ", "\t",
];

function generate(r: () => number, { newlines }: { newlines: boolean }): string {
  const n = 1 + Math.floor(r() * 9);
  let text = "";
  for (let i = 0; i < n; i++) {
    text += pick(r, TOKENS);
    if (newlines && r() < 0.15) text += "\n";
  }
  return text;
}

/** What the text of a paragraph is after Markdown reads it: no blank lines, no edge line breaks. */
const clean = (s: string) => s.replace(/\n{2,}/g, "\n").replace(/^\n+|\n+$/g, "");

describe("canonical escaping preserves text", () => {
  it("round-trips 800 random paragraphs full of metacharacters", () => {
    const r = rng(1);
    for (let i = 0; i < 800; i++) {
      const text = generate(r, { newlines: true });
      if (text.trim() === "") continue;
      const md = serialize(doc(paragraph(text)));
      const back = blocks(reparse(md));
      const message = `${JSON.stringify(text)} -> ${JSON.stringify(md)}`;
      expect(back, message).toHaveLength(1);
      expect(back[0]!.type, message).toBe("paragraph");
      expect(textOf(back[0]!), message).toBe(clean(text));
    }
  });

  it("round-trips 500 random headings full of metacharacters", () => {
    const r = rng(2);
    for (let i = 0; i < 500; i++) {
      const text = generate(r, { newlines: false });
      if (text.trim() === "") continue;
      const level = 1 + Math.floor(r() * 6);
      const md = serialize(doc(heading(level, text)));
      const back = blocks(reparse(md));
      const message = `${JSON.stringify(text)} -> ${JSON.stringify(md)}`;
      expect(back, message).toHaveLength(1);
      expect(back[0]!.type, message).toBe("heading");
      expect(back[0]!.attrs?.["level"], message).toBe(level);
      expect(textOf(back[0]!), message).toBe(text);
    }
  });

  it("is idempotent: serialize(parse(serialize(doc))) equals serialize(doc), 800 cases", () => {
    const r = rng(3);
    for (let i = 0; i < 800; i++) {
      const text = generate(r, { newlines: true });
      if (text.trim() === "") continue;
      const d = r() < 0.7 ? doc(paragraph(text)) : doc(heading(1 + Math.floor(r() * 6), text.replace(/\n/g, " ")));
      const once = serialize(d);
      const twice = serialize(reparse(once));
      expect(twice, `${JSON.stringify(text)} -> ${JSON.stringify(once)}`).toBe(once);
    }
  });

  it("round-trips metacharacters inside list items, quotes, callouts and table cells", () => {
    const r = rng(4);
    for (let i = 0; i < 300; i++) {
      const text = generate(r, { newlines: false });
      if (text.trim() === "") continue;
      const item = (t: string) => ({ type: "listItem", content: [paragraph(t)] });
      const cell = (type: string): JSONContent => ({ type, content: [{ type: "text", text }] });
      const wrappers: [string, JSONContent][] = [
        ["list", { type: "list", attrs: { ordered: false }, content: [item(text)] }],
        ["ordered list", { type: "list", attrs: { ordered: true, start: 1 }, content: [item(text)] }],
        ["blockquote", { type: "blockquote", content: [paragraph(text)] }],
        ["callout", { type: "callout", attrs: { kind: "note", fold: "", title: "T" }, content: [paragraph(text)] }],
        ["table", { type: "table", attrs: { align: [null] }, content: [{ type: "tableRow", content: [cell("tableHeader")] }, { type: "tableRow", content: [cell("tableCell")] }] }],
      ];
      for (const [name, node] of wrappers) {
        const md = serialize(doc(node));
        const back = blocks(reparse(md));
        const message = `${name}: ${JSON.stringify(text)} -> ${JSON.stringify(md)}`;
        expect(back, message).toHaveLength(1);
        expect(back[0]!.type, message).toBe(node.type);
        const texts = (n: JSONContent): string[] => (n.type === "paragraph" || n.type === "tableCell" || n.type === "tableHeader" ? [textOf(n)] : (n.content ?? []).flatMap(texts));
        expect(texts(back[0]!).filter((t) => name !== "table" || t !== "").at(-1), message).toBe(text.trim() === text ? text : text);
        expect(serialize(reparse(md)), message).toBe(md);
      }
    }
  });
});

describe("specific escapes", () => {
  const cases: [string, string][] = [
    ["# not heading", "\\# not heading"],
    ["> not quote", "\\> not quote"],
    ["- not list", "\\- not list"],
    ["+ not list", "\\+ not list"],
    ["1. not ordered", "1\\. not ordered"],
    ["12) not ordered", "12\\) not ordered"],
    ["===", "\\==="],
    ["---", "\\---"],
    ["***", "\\*\\*\\*"],
    ["```js", "\\`\\`\\`js"],
    ["~~~", "\\~\\~\\~"],
    ["a | b", "a \\| b"],
    ["*a* _b_ `c`", "\\*a\\* \\_b\\_ \\`c\\`"],
    ["[a](b) ![c](d)", "\\[a\\](b) !\\[c\\](d)"],
    ["<b>x</b>", "\\<b>x\\</b>"],
    ["&amp; & &x", "\\&amp; & &x"],
    ["snake_case a_ _b", "snake_case a\\_ \\_b"],
    ["back\\slash", "back\\\\slash"],
    ["line one\n- line two", "line one\n\\- line two"],
    ["  leading", "&#x20; leading"],
    ["trailing  ", "trailing &#x20;"],
    ["tab\tinside", "tab\tinside"],
  ];
  it.each(cases)("%j", (text, expected) => {
    expect(serialize(doc(paragraph(text)))).toBe(`${expected}\n`);
  });

  it("escapes a trailing # in headings so it is not a closing sequence", () => {
    expect(serialize(doc(heading(2, "C#")))).toBe("## C#\n");
    expect(serialize(doc(heading(2, "Issue #")))).toBe("## Issue \\#\n");
    expect(serialize(doc(heading(2, "a ##")))).toBe("## a #\\#\n");
  });

  it("drops empty paragraphs and trailing hard breaks, which have no Markdown form", () => {
    const withBreak: JSONContent = { type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }] };
    expect(serialize(doc(paragraph("x"), paragraph(""), withBreak))).toBe("x\n\na\n");
  });
});
