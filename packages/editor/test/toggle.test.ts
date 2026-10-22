import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc, stripSourceAttrs, thothSchema } from "../src/index.ts";
import { blocks, canonical, roundTrip, textOf } from "./helpers.ts";

const parse = (source: string) => markdownToDoc(source);
const render = (doc: JSONContent, frontmatter = "") => docToMarkdown(doc, { frontmatter });
const withBlocks = (doc: JSONContent, content: JSONContent[]): JSONContent => ({ ...doc, content });
const callout = (md: string): JSONContent => blocks(parse(md).doc)[0]!;
const titleOf = (node: JSONContent) => textOf(node.content![0]!);

describe("toggle blocks (> [!toggle]- Title)", () => {
  it.each([
    ["collapsed", "> [!toggle]- Title\n> body\n", "-"],
    ["open (+)", "> [!toggle]+ Title\n> body\n", "+"],
    ["no marker", "> [!toggle] Title\n> body\n", ""],
  ])("parses a %s toggle: kind, fold marker, title child and body", (_name, source, fold) => {
    const node = callout(source);
    expect(node.type).toBe("callout");
    expect(node.attrs).toMatchObject({ kind: "toggle", fold });
    expect(node.content![0]!.type).toBe("calloutTitle");
    expect(titleOf(node)).toBe("Title");
    expect(textOf(node.content![1]!)).toBe("body");
    expect(() => thothSchema().nodeFromJSON(parse(source).doc).check()).not.toThrow();
  });

  it.each([
    "> [!toggle]- Title\n> body\n",
    "> [!toggle]+ Title\n> body\n",
    "> [!toggle] Title\n> body\n",
    "> [!toggle]-   odd   spacing  \n> body\n",
    ">   [!toggle]+ Title   \n>body\n",
    "> [!TOGGLE]- Upper\n> body\n",
    "> [!toggle]-\n> no title\n",
    "> [!toggle]- Only a title\n",
    "> [!toggle]+ T\n> a\n>\n> - x\n> - y\n\n> [!toggle]- U\n> b\n",
  ])("is byte-identical untouched: %j", (source) => {
    expect(roundTrip(source)).toBe(source);
    expect(roundTrip(source.replace(/\n/g, "\r\n"))).toBe(source.replace(/\n/g, "\r\n"));
  });

  it("keeps each fold marker through canonical serialization", () => {
    for (const fold of ["-", "+", ""]) {
      const md = `> [!toggle]${fold} Title\n> body\n`;
      expect(canonical(md)).toBe(md);
    }
  });

  it("canonical form is idempotent and reparses to the same document", () => {
    const source = "> [!toggle]-   Spaced  *title*  \n> body\n\n> [!toggle]+\n> > nested\n";
    const once = canonical(source);
    expect(canonical(once)).toBe(once);
    expect(stripSourceAttrs(parse(once).doc)).toEqual(stripSourceAttrs(parse(source).doc));
  });

  it("does not turn a body that starts with a non-paragraph into the title", () => {
    const source = "> [!toggle]- T\n>\n> > quoted\n";
    expect(callout(source).content!.map((n) => n.type)).toEqual(["calloutTitle", "blockquote"]);
    expect(canonical(source)).toBe(source);
  });

  it("an empty toggle body serializes as the head line only", () => {
    const empty: JSONContent = { type: "callout", attrs: { kind: "toggle", fold: "-" }, content: [{ type: "calloutTitle", content: [{ type: "text", text: "Idea" }] }, { type: "paragraph" }] };
    expect(render({ type: "doc", content: [empty] })).toBe("> [!toggle]- Idea\n");
  });

  it("gives other callout kinds the same title node", () => {
    expect(titleOf(callout("> [!note]+ Heads up\n> body\n"))).toBe("Heads up");
    expect(titleOf(callout("> [!warning]\n> body\n"))).toBe("");
  });
});

describe("editing a callout title", () => {
  const source = "intro\n\n> [!toggle]-   Old   title \n> body\n\noutro\n";

  it("rewrites only that block and keeps the neighbours' bytes", () => {
    const { doc } = parse(source);
    const list = blocks(doc);
    const edited: JSONContent = { ...list[1]!, content: [{ type: "calloutTitle", content: [{ type: "text", text: "New title" }] }, ...list[1]!.content!.slice(1)] };
    expect(render(withBlocks(doc, [list[0]!, edited, list[2]!]))).toBe("intro\n\n> [!toggle]- New title\n> body\n\noutro\n");
  });

  it("keeps formatting, wikilinks and escapes in an edited title", () => {
    const { doc } = parse("> [!note] x\n> y\n");
    const node = blocks(doc)[0]!;
    const title: JSONContent[] = [
      { type: "text", text: "A " },
      { type: "text", text: "bold", marks: [{ type: "bold" }] },
      { type: "text", text: " *star* " },
      { type: "wikilink", attrs: { target: "Page", fragment: null, label: null } },
    ];
    const md = render(withBlocks(doc, [{ ...node, content: [{ type: "calloutTitle", content: title }, ...node.content!.slice(1)] }]));
    expect(md).toBe("> [!note] A **bold** \\*star\\* [[Page]]\n> y\n");
    const back = callout(md).content![0]!.content!;
    expect(back.map((n) => (n.type === "wikilink" ? `[[${n.attrs!["target"] as string}]]` : n.text))).toEqual(["A ", "bold", " *star* ", "[[Page]]"]);
  });

  it("flattens breaks and trims edge blanks, so a title stays one line", () => {
    const { doc } = parse("> [!note] x\n> y\n");
    const node = blocks(doc)[0]!;
    const title: JSONContent[] = [{ type: "text", text: "  one" }, { type: "hardBreak" }, { type: "text", text: "two  " }];
    const md = render(withBlocks(doc, [{ ...node, content: [{ type: "calloutTitle", content: title }, ...node.content!.slice(1)] }]));
    expect(md).toBe("> [!note] one two\n> y\n");
  });

  it("an emptied title drops the title text and keeps the marker", () => {
    const { doc } = parse("> [!toggle]+ Gone\n> body\n");
    const node = blocks(doc)[0]!;
    const md = render(withBlocks(doc, [{ ...node, content: [{ type: "calloutTitle" }, ...node.content!.slice(1)] }]));
    expect(md).toBe("> [!toggle]+\n> body\n");
  });

  it("title text that looks like Markdown block syntax stays in the title", () => {
    const { doc } = parse("> [!note] x\n> y\n");
    const node = blocks(doc)[0]!;
    for (const text of ["# heading", "- item", "> quote", "1. one", "[!toggle]- x"]) {
      const md = render(withBlocks(doc, [{ ...node, content: [{ type: "calloutTitle", content: [{ type: "text", text }] }, ...node.content!.slice(1)] }]));
      const back = callout(md);
      expect(back.type, text).toBe("callout");
      expect(titleOf(back), text).toBe(text);
      expect(render(withBlocks(parse(md).doc, blocks(parse(md).doc))), text).toBe(md);
    }
  });
});

describe("moving and duplicating toggles", () => {
  const source = "# Top\n\n> [!toggle]-   Odd   spacing  \n> body line\n\n* star bullet\n\nlast  para  \n";

  it("a moved, otherwise untouched toggle keeps its original source and the neighbours stay byte-identical", () => {
    const { doc } = parse(source);
    const list = blocks(doc);
    const moved = [list[0]!, list[2]!, list[1]!, list[3]!];
    const out = render(withBlocks(doc, moved));
    expect(out).toBe("# Top\n\n* star bullet\n\n> [!toggle]-   Odd   spacing  \n> body line\n\nlast  para  \n");
  });

  it("moving a toggle to the very top and bottom keeps every block's bytes", () => {
    const { doc } = parse(source);
    const list = blocks(doc);
    const srcs = (d: JSONContent) => blocks(d).map((b) => b.attrs?.["mdSrc"] as string);
    for (const order of [[1, 0, 2, 3], [0, 2, 3, 1]]) {
      const out = render(withBlocks(doc, order.map((i) => list[i]!)));
      expect(srcs(parse(out).doc)).toEqual(order.map((i) => srcs(doc)[i]));
    }
  });

  it("duplicating a block (copy without source attributes) writes the copy canonically and leaves the original untouched", () => {
    const { doc } = parse(source);
    const list = blocks(doc);
    const copy = stripSourceAttrs(list[1]!);
    const out = render(withBlocks(doc, [list[0]!, list[1]!, copy, list[2]!, list[3]!]));
    expect(out).toBe("# Top\n\n> [!toggle]-   Odd   spacing  \n> body line\n\n> [!toggle]- Odd   spacing\n> body line\n\n* star bullet\n\nlast  para  \n");
  });

  it("duplicating a plain paragraph keeps the original and its neighbours byte-identical", () => {
    const { doc } = parse(source);
    const list = blocks(doc);
    const out = render(withBlocks(doc, [...list, stripSourceAttrs(list[3]!)]));
    expect(out).toBe(`${source}\nlast  para\n`);
  });

  it("a moved paragraph is not changed when a toggle moves next to it", () => {
    const { doc } = parse("a\n\n> [!toggle]+ T\n> b\n\n- x\n");
    const list = blocks(doc);
    const out = render(withBlocks(doc, [list[1]!, list[0]!, list[2]!]));
    expect(out).toBe("> [!toggle]+ T\n> b\n\na\n\n- x\n");
  });
});
