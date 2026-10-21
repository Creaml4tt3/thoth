import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc } from "../src/index.ts";
import { blocks, roundTrip, withContent } from "./helpers.ts";

/** Constructs the editor cannot model, with the node type they must become. */
const CONSTRUCTS: [name: string, source: string, type: string][] = [
  ["link reference definition", '[ref]: http://example.com "Title"', "raw"],
  ["footnote definition", "[^1]: The footnote\n    continues here", "raw"],
  ["html block", '<div class="x">\n  <p>hi</p>\n</div>', "html"],
  ["html comment", "<!-- a\n\ncomment -->", "html"],
  ["math fence", "```math\n\\int_0^1 x\\,dx\n```", "math"],
  ["dollar math", "$$\nE = mc^2\n$$", "math"],
  ["html inside a list item", "- item\n  <div>x</div>\n- other", "raw"],
  ["definition inside a blockquote", "> quote\n>\n> [d]: /url", "raw"],
  ["footnote inside a blockquote", "> a[^n]\n>\n> [^n]: note", "raw"],
  ["math fence inside a list", "- item\n\n  ```math\n  x\n  ```", "raw"],
  ["table with excess cells", "| a |\n|---|\n| x | extra |", "raw"],
];

describe("unsupported constructs become raw nodes", () => {
  it.each(CONSTRUCTS)("%s", (_name, source, type) => {
    const input = `before\n\n${source}\n\nafter\n`;
    const { doc, frontmatter } = markdownToDoc(input);
    const list = blocks(doc);
    expect(list.map((b) => b.type)).toEqual(["paragraph", type, "paragraph"]);
    expect(docToMarkdown(doc, { frontmatter })).toBe(input);
  });

  it.each(CONSTRUCTS)("%s survives an edit of each neighbour", (_name, source, type) => {
    const input = `before\n\n${source}\n\nafter\n`;
    const { doc } = markdownToDoc(input);
    const [first, middle, last] = blocks(doc) as [JSONContent, JSONContent, JSONContent];
    const edited = docToMarkdown({ ...doc, content: [withContent(first, "changed before"), middle, withContent(last, "changed after")] });
    expect(edited).toBe(`changed before\n\n${source}\n\nchanged after\n`);
    expect(markdownToDoc(edited).doc.content?.[1]?.type).toBe(type);
  });

  it.each(CONSTRUCTS)("%s survives being moved and when its neighbours are deleted", (_name, source) => {
    const input = `before\n\n${source}\n\nafter\n`;
    const { doc } = markdownToDoc(input);
    const [first, middle, last] = blocks(doc) as [JSONContent, JSONContent, JSONContent];
    expect(docToMarkdown({ ...doc, content: [last, middle, first] })).toBe(`after\n\n${source}\n\nbefore\n`);
    expect(docToMarkdown({ ...doc, content: [middle] })).toBe(`${source}\n`);
  });

  it("keeps raw source with CRLF byte-for-byte", () => {
    const input = "a\r\n\r\n[^1]: note\r\n    more\r\n\r\n<div>\r\nx\r\n</div>\r\n";
    expect(roundTrip(input)).toBe(input);
  });
});

describe("inline constructs the editor cannot model become inline raw atoms", () => {
  const INLINE = [
    ["inline html", "a <b>bold</b> b"],
    ["reference link", "see [text][ref] now\n\n[ref]: /url"],
    ["reference image", "see ![alt][ref] now\n\n[ref]: /img.png"],
    ["footnote reference", "claim[^1] here\n\n[^1]: note"],
    ["inline embed", "text ![[img.png]] text"],
    ["wikilink destination", "[x](a[[b]]c)"],
  ] as const;

  it.each(INLINE)("%s", (_name, source) => {
    const input = `${source}\n`;
    expect(roundTrip(input)).toBe(input);
    const first = blocks(markdownToDoc(input).doc)[0]!;
    expect(JSON.stringify(first)).toContain('"inlineRaw"');
  });

  it("re-emits inline raw source verbatim when its paragraph is rewritten", () => {
    const input = "a <b>bold</b> [t][ref] x[^1] ![[e.png]]\n\n[ref]: /u\n\n[^1]: n\n";
    const { doc } = markdownToDoc(input);
    const first = blocks(doc)[0]!;
    // Rewrite the paragraph canonically (a text change elsewhere in the same block).
    const content = [{ type: "text", text: "A " }, ...first.content!.slice(1)];
    const out = docToMarkdown({ ...doc, content: [{ ...first, content }, ...blocks(doc).slice(1)] });
    expect(out).toBe(input.replace("a <b>", "A <b>"));
  });

  it("keeps ordinary wikilinks as atoms with their parts", () => {
    const first = blocks(markdownToDoc("[[T]] [[T|a]] [[T#H]] [[T#^b]]\n").doc)[0]!;
    const links = first.content!.filter((n) => n.type === "wikilink").map((n) => n.attrs);
    expect(links).toEqual([
      { target: "T", fragment: null, label: null },
      { target: "T", fragment: null, label: "a" },
      { target: "T", fragment: "H", label: null },
      { target: "T", fragment: "^b", label: null },
    ]);
  });
});
