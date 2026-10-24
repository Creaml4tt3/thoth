import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { TEXT_COLORS, docToMarkdown, markdownToDoc, stripSourceAttrs } from "../src/index.ts";
import { canonical, roundTrip, semantic } from "./helpers.ts";

/** Text styles of ADR-0016 rule 1: highlight `==x==`, underline `<u>x</u>`, colour `<span data-color="NAME">x</span>`. */

const para = (...content: JSONContent[]): JSONContent => ({ type: "doc", content: [{ type: "paragraph", content }] });
const text = (t: string, ...marks: JSONContent["marks"] & object): JSONContent => ({ type: "text", text: t, ...(marks.length ? { marks } : {}) });
const write = (doc: JSONContent) => docToMarkdown(doc, { frontmatter: "" });
const inlineOf = (source: string) => semantic(source)[0]?.content ?? [];

describe("text styles", () => {
  it("reads the three styles as marks", () => {
    expect(inlineOf('a ==b== <u>c</u> <span data-color="red">d</span>\n')).toEqual([
      text("a "),
      text("b", { type: "highlight" }),
      text(" "),
      text("c", { type: "underline" }),
      text(" "),
      text("d", { type: "textColor", attrs: { color: "red" } }),
    ]);
  });

  it("writes every palette colour by name, never as CSS", () => {
    for (const color of TEXT_COLORS) {
      const md = write(para(text("x", { type: "textColor", attrs: { color } })));
      expect(md).toBe(`<span data-color="${color}">x</span>\n`);
      expect(inlineOf(md)).toEqual([text("x", { type: "textColor", attrs: { color } })]);
    }
  });

  it("drops a colour outside the palette instead of writing it", () => {
    expect(write(para(text("x", { type: "textColor", attrs: { color: "#ff0000" } })))).toBe("x\n");
  });

  it("keeps other spans and unknown colours as raw HTML", () => {
    const nodes = inlineOf('<span class="k">a</span> <span data-color="pink">b</span>\n');
    expect(nodes.filter((n) => n.type === "inlineRaw").map((n) => n.attrs?.["source"])).toEqual([
      '<span class="k">',
      "</span>",
      '<span data-color="pink">',
      "</span>",
    ]);
    expect(nodes.some((n) => n.marks?.some((m) => m.type === "textColor"))).toBe(false);
  });

  it("does not read `==` in code, around spaces, or escaped as a highlight", () => {
    for (const source of ["`==a==`\n", "a == b\n", "\\==a==\n", "a===b===\n"]) {
      expect(JSON.stringify(inlineOf(source)), source).not.toContain("highlight");
    }
  });

  it("round-trips untouched styled text byte for byte", () => {
    const sources = [
      "Mixed ==hi== and <U>upper tag</U> and <span data-color='blue'>quoted</span>.\n",
      "<span data-color=green>bare</span> and **==nested==** and ==**other**==\n",
      "a == b and ==unpaired\r\n\r\nnext <u>para</u>\r\n",
    ];
    for (const source of sources) expect(roundTrip(source), source).toBe(source);
  });

  it("serializes an edit to canonical Markdown that reads back the same", () => {
    const doc = para(
      text("plain "),
      text("both", { type: "bold" }, { type: "highlight" }),
      text(" "),
      text("blue under", { type: "underline" }, { type: "textColor", attrs: { color: "blue" } }),
      text(" a == b"),
    );
    const md = write(doc);
    expect(md).toBe('plain ==**both**== <span data-color="blue"><u>blue under</u></span> a \\== b\n');
    expect(stripSourceAttrs(markdownToDoc(md).doc).content?.[0]?.content).toEqual([
      text("plain "),
      text("both", { type: "highlight" }, { type: "bold" }),
      text(" "),
      text("blue under", { type: "textColor", attrs: { color: "blue" } }, { type: "underline" }),
      text(" a == b"),
    ]);
    expect(canonical(md)).toBe(md);
  });

  it("escapes `=` that touches a highlight so the run does not grow", () => {
    const md = write(para(text("=a=", { type: "highlight" })));
    expect(md).toBe("==\\=a\\===\n");
    expect(inlineOf(md)).toEqual([text("=a=", { type: "highlight" })]);
  });
});
