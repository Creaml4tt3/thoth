import { describe, expect, it } from "vitest";
import {
  FrontmatterError,
  PageDocumentSchema,
  parseFrontmatter,
  parsePage,
  rewriteTargets,
  splitFrontmatter,
  updateFrontmatter,
} from "../src/index.ts";

const SAMPLE = `---
# keep this comment
title: Overview
aliases: [Home, Start]
tags:
  - project
custom_plugin_key: { nested: true }
---
# Overview

See [[Architecture]] and [[Architecture#Goals|the goals]] or [[Notes/Daily#^abc123]].

> [!warning] Careful
> Mind the [link](../Other%20Page.md#Intro "title").

- [ ] open task
- [x] done task

![[diagram.svg]]

![alt](<Assets/my image.png>)

| col | link |
|-----|------|
| a   | [[Table Target\\|alias]] |

\`\`\`ts
const x = "[[NotALink]]";
\`\`\`

Inline \`[[AlsoNot]]\` and #inline-tag and https://example.com/#nottag.

Paragraph with anchor ^para-1

[ref-def]: Reference%20Target.md

<details><summary>[[InHtml]]</summary></details>
`;

describe("frontmatter", () => {
  it("splits fenced frontmatter and reports body offset", () => {
    const split = splitFrontmatter(SAMPLE);
    expect(split.present).toBe(true);
    expect(SAMPLE.slice(split.bodyOffset).startsWith("# Overview")).toBe(true);
  });

  it("treats an unclosed fence as body", () => {
    expect(splitFrontmatter("---\ntitle: x\nno close").present).toBe(false);
  });

  it("preserves unknown keys, order, comments, and body when updating", () => {
    const out = updateFrontmatter(SAMPLE, { thoth_id: "0190f5c2-0000-7000-8000-000000000000" });
    expect(out).toContain("# keep this comment");
    expect(out).toContain("custom_plugin_key: { nested: true }");
    expect(out.indexOf("title:")).toBeLessThan(out.indexOf("custom_plugin_key"));
    expect(out.indexOf("custom_plugin_key")).toBeLessThan(out.indexOf("thoth_id"));
    const body = SAMPLE.slice(splitFrontmatter(SAMPLE).bodyOffset);
    expect(out.endsWith(body)).toBe(true);
    expect(parseFrontmatter(out).data["thoth_id"]).toBe("0190f5c2-0000-7000-8000-000000000000");
  });

  it("adds frontmatter to a file without any and leaves the body intact", () => {
    const out = updateFrontmatter("Hello\n", { thoth_id: "x" });
    expect(out).toBe("---\nthoth_id: x\n---\nHello\n");
  });

  it("preserves CRLF line endings and BOM", () => {
    const src = "﻿---\r\na: 1\r\n---\r\nBody\r\n";
    const out = updateFrontmatter(src, { b: 2 });
    expect(out).toBe("﻿---\r\na: 1\r\nb: 2\r\n---\r\nBody\r\n");
  });

  it("refuses to rewrite malformed frontmatter", () => {
    const bad = "---\na: [unclosed\n---\nbody";
    expect(parseFrontmatter(bad).error).toBeDefined();
    expect(() => updateFrontmatter(bad, { x: 1 })).toThrow(FrontmatterError);
  });
});

describe("parsePage", () => {
  const doc = parsePage("Projects/Overview.md", SAMPLE);

  it("produces a schema-valid PageDocument", () => {
    expect(() => PageDocumentSchema.parse(doc)).not.toThrow();
    expect(doc.title).toBe("Overview");
    expect(doc.aliases).toEqual(["Home", "Start"]);
  });

  it("extracts wikilinks with fragments and aliases, skipping code and HTML", () => {
    const wiki = doc.references.filter((r) => r.syntax === "wikilink").map((r) => [r.target, r.fragment, r.label]);
    expect(wiki).toEqual([
      ["Architecture", undefined, undefined],
      ["Architecture", "Goals", "the goals"],
      ["Notes/Daily", "^abc123", undefined],
      ["Table Target", undefined, "alias"],
    ]);
  });

  it("extracts embeds, markdown links, images, and definitions with decoded targets", () => {
    const rest = doc.references.filter((r) => r.syntax !== "wikilink").map((r) => [r.syntax, r.target, r.fragment ?? null]);
    expect(rest).toEqual([
      ["markdown-link", "../Other Page.md", "Intro"],
      ["embed", "diagram.svg", null],
      ["markdown-image", "Assets/my image.png", null],
      ["definition", "Reference Target.md", null],
    ]);
  });

  it("classifies blocks including callouts, task lists, embeds, and raw-preserving html", () => {
    const types = doc.blocks.map((b) => b.type);
    expect(types).toEqual([
      "heading",
      "paragraph",
      "callout",
      "taskList",
      "embed",
      "image",
      "table",
      "code",
      "paragraph",
      "paragraph",
      "raw",
      "html",
    ]);
    expect(doc.blocks[2]!.calloutKind).toBe("warning");
    expect(doc.blocks[3]!.tasks).toEqual([
      { checked: false, text: "open task" },
      { checked: true, text: "done task" },
    ]);
    expect(doc.blockAnchors).toEqual(["para-1"]);
  });

  it("covers the whole body with block ranges and never loses text", () => {
    for (const b of doc.blocks) expect(SAMPLE.slice(b.range.start, b.range.end).length).toBeGreaterThan(0);
  });

  it("collects frontmatter and inline tags, ignoring URL fragments", () => {
    expect(doc.tags.sort()).toEqual(["inline-tag", "project"]);
  });

  it("reports line numbers relative to the whole file", () => {
    const first = doc.references[0]!;
    expect(SAMPLE.split("\n")[first.range.startLine - 1]).toContain("[[Architecture]]");
  });

  it("handles a file without frontmatter and derives title from filename", () => {
    const d = parsePage("Inbox/บันทึก 🚀.md", "Just text with [[Link]].\n");
    expect(d.title).toBe("บันทึก 🚀");
    expect(d.references).toHaveLength(1);
  });
});

describe("rewriteTargets", () => {
  it("splices only the target ranges and keeps fragments, aliases, and titles", () => {
    const doc = parsePage("Projects/Overview.md", SAMPLE);
    const edits = doc.references
      .filter((r) => r.target === "Architecture" || r.target === "../Other Page.md" || r.target === "Assets/my image.png")
      .map((reference) => ({
        reference,
        newTarget:
          reference.target === "Architecture"
            ? "Projects/Architecture"
            : reference.target === "Assets/my image.png"
              ? "Assets/renamed image.png"
              : "../Moved Page.md",
      }));
    const out = rewriteTargets(SAMPLE, edits);
    expect(out).toContain("[[Projects/Architecture]] and [[Projects/Architecture#Goals|the goals]]");
    expect(out).toContain("[link](../Moved%20Page.md#Intro \"title\")");
    expect(out).toContain("![alt](<Assets/renamed image.png>)");
    // Everything else unchanged.
    expect(out.replace(/Projects\/Architecture/g, "Architecture").replace("Moved%20Page", "Other%20Page").replace("renamed image", "my image")).toBe(SAMPLE);
  });

  it("rejects wikilink targets that cannot be represented", () => {
    const doc = parsePage("a.md", "[[x]]");
    expect(() => rewriteTargets("[[x]]", [{ reference: doc.references[0]!, newTarget: "a|b" }])).toThrow();
  });
});

describe("updateFrontmatter splicing", () => {
  it("keeps untouched keys byte-identical, including flow lists and quoting", () => {
    const src = "---\naliases: [Start]\ntitle: 'Quoted'\nlist:\n    - deep indent\n---\nBody\n";
    const out = updateFrontmatter(src, { thoth_id: "x", thoth_source: { system: "obsidian", sourcePath: "a.md" } });
    expect(out).toBe(
      "---\naliases: [Start]\ntitle: 'Quoted'\nlist:\n    - deep indent\nthoth_id: x\nthoth_source:\n  system: obsidian\n  sourcePath: a.md\n---\nBody\n",
    );
  });

  it("replaces and deletes existing keys in place, including block values", () => {
    const src = "---\na: 1\nnested:\n  x: 1\n  y: 2\nb: [1, 2]\n---\nBody\n";
    expect(updateFrontmatter(src, { nested: "flat" })).toBe("---\na: 1\nnested: flat\nb: [1, 2]\n---\nBody\n");
    expect(updateFrontmatter(src, { nested: undefined })).toBe("---\na: 1\nb: [1, 2]\n---\nBody\n");
    expect(updateFrontmatter("---\na: 1\n---\nBody", { a: undefined })).toBe("Body");
  });
});

describe("frontmatter edge cases from review", () => {
  it("treats duplicate keys as malformed so the written ID is the one that is read", () => {
    const src = "---\nthoth_id: a\nthoth_id: b\n---\nBody\n";
    expect(parseFrontmatter(src).error).toMatch(/duplicate/);
    expect(() => updateFrontmatter(src, { thoth_id: "c" })).toThrow(FrontmatterError);
  });

  it("uses the frontmatter's own line ending when the body differs", () => {
    // LF frontmatter, CRLF body: new YAML lines use LF; the body is untouched.
    expect(updateFrontmatter("---\na: 1\n---\nBody\r\nMore\r\n", { b: 2 })).toBe("---\na: 1\nb: 2\n---\nBody\r\nMore\r\n");
    // CRLF frontmatter, LF body: new YAML lines use CRLF.
    expect(updateFrontmatter("---\r\na: 1\r\n---\r\nBody\nMore\n", { b: 2 })).toBe("---\r\na: 1\r\nb: 2\r\n---\r\nBody\nMore\n");
  });
});
