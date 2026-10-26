import { decodeText, encodeText } from "@thoth/content";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc } from "../src/index.ts";
import { FIXTURES, GOLDEN, markdownFiles, pick, rng, roundTrip } from "./helpers.ts";

describe("untouched round-trip is byte-identical", () => {
  const files = [...markdownFiles(FIXTURES), ...markdownFiles(GOLDEN)];

  it("finds the corpus", () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it.each(files)("%s", (file) => {
    const bytes = new Uint8Array(readFileSync(file));
    const { text } = decodeText(bytes);
    expect(Buffer.from(encodeText(roundTrip(text)))).toEqual(Buffer.from(bytes));
  });

  const cases: Record<string, string> = {
    empty: "",
    "only newline": "\n",
    "only blank lines": "\n\n  \n",
    "no trailing newline": "# Title\n\ntext",
    "star bullets": "* a\n* b\n    * c\n",
    "plus bullets and odd indent": "+ a\n\n\n+ b\n   continued\n",
    "__bold__ and _it_": "__bold__ and _it_ and ***x***\n",
    "setext headings": "Title\n=====\n\nSub\n---\n",
    "odd spacing": "  indented para\n\n\n\n   * spaced   \n\ttab\n\ntrailing spaces   \n",
    crlf: "# Title\r\n\r\nText line\r\nmore  \r\n\r\n- a\r\n- b\r\n\r\n```js\r\ncode\r\n```\r\n",
    "mixed line endings": "a\r\n\r\nb\n\nc\r\n",
    bom: "﻿# Title\n\ntext\n",
    "bom + frontmatter crlf": "﻿---\r\ntitle: T\r\n---\r\n\r\n# Body\r\n",
    thai: "# บันทึกการประชุม\n\nข้อความภาษาไทย [[หน้าอื่น|ชื่อ]] และ **ตัวหนา**\n",
    emoji: "# 🚀 Launch 👩‍👩‍👧‍👦\n\n- ✅ done\n- 🧪 `code 🧪`\n",
    frontmatter: "---\ntitle:   Odd   spacing\ntags: [a,  b]\n# comment\n---\n# Body\n",
    "frontmatter only": "---\ntitle: T\n---\n",
    "frontmatter, no blank line": "---\na: 1\n---\ntext\n",
    "unclosed frontmatter is a thematic break": "---\ntitle: T\n\ntext\n",
    "leading blank lines": "\n\n\n# Title\n",
    "unclosed fence": "```js\nconst a = 1;\n",
    "html comment": "<!-- c -->\n\ntext\n",
    "tight glue": "para\n# Heading\ntext\n> quote\n",
    "wikilinks": "[[T]] [[T|a]] [[T#H]] [[T#^b]] ![[img.png]]\n",
    // ADR-0028: the spellings images are written in, by people, agents and importers.
    images:
      "# Birds\n\n![Uric acid crystals](bird-uric-acid.svg)\n\n![](my%20photo.png \"Title\")\n\n![Notion](../attachments/0f3a2b/Screen%20Shot.png)\n\n" +
      "![spaces](<my photo (1).png>)\n\ntext ![inline](a.png) text\n\n![web](https://example.com/a.png)\n\n![ws](thoth:attachment/01920000-0000-7000-8000-000000000001)\n",
    "table with excess cells": "| a |\n|---|\n| x | y |\n",
    "thematic break first": "***\n\ntext\n",
    "nul and controls": "a\u0000b\u0007c\n",
  };
  it.each(Object.entries(cases))("%s", (_name, source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it("carries frontmatter and BOM through as the exact prefix", () => {
    const source = "﻿---\r\ntitle:   X\r\n---\r\n\r\n# Body\r\n";
    const { doc, frontmatter } = markdownToDoc(source);
    expect(frontmatter).toBe("﻿---\r\ntitle:   X\r\n---\r\n");
    expect(docToMarkdown(doc, { frontmatter }).startsWith(frontmatter)).toBe(true);
  });

  it("round-trips 300 random snippet concatenations", () => {
    const snippets = [
      "# Heading", "Setext\n======", "para text", "* a\n* b", "1. a\n2. b", "- [ ] t", "> quote", "> [!note] T\n> body",
      "```js\ncode\n```", "    indented", "| a | b |\n|---|---|\n| 1 | 2 |", "![[e.png]]", "[[W]] link", "[r]: /u", "<div>x</div>",
      "$$\nx\n$$", "***", "text[^1]\n\n[^1]: n", "tight\nlazy", "  spaced  ", "ไทย 🚀", "__b__ _i_ ~~s~~",
    ];
    const r = rng(42);
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(r() * 7);
      const eol = r() < 0.2 ? "\r\n" : "\n";
      let source = r() < 0.15 ? "---\na: 1\n---\n" : "";
      for (let k = 0; k < n; k++) {
        source += pick(r, snippets).replace(/\n/g, eol) + pick(r, [eol, eol + eol, eol + eol + eol, eol + " " + eol, ""]);
      }
      expect(roundTrip(source), JSON.stringify(source)).toBe(source);
    }
  });
});
