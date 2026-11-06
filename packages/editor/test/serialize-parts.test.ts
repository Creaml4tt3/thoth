import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc } from "../src/index.ts";
import { serialize } from "../src/serialize.ts";
import { blocks, paragraph, pick, rng, withContent } from "./helpers.ts";

/**
 * 0.8.0 checks a long page in parts, cut after its ATX headings, and remembers the parts it has checked. It must give
 * exactly what checking the whole page every time gives (`serialize(…, false)`), byte for byte, for any edit.
 */

/** Blocks, among them ones whose boundaries depend on their neighbours, and ones that look like a heading but are not. */
const SNIPPETS = [
  "# Title",
  "## Section two",
  "###### Six",
  "#not a heading",
  "    # indented, so code",
  "Setext\n======",
  "para\n# Heading\ntext",
  "- a\n- b",
  "* b",
  "1. x",
  "2) y",
  "    indented code",
  "> quote\nlazy",
  "> # quoted heading",
  "- # heading in a list",
  "```\nunclosed fence\n# not a heading",
  "```js\nconst a = 1;\n```",
  "~~~\n# inside tildes\n~~~",
  "<div>\n# in html\n</div>",
  "<!-- comment\n# still comment -->",
  "| a | b |\n| - | - |\n| 1 | 2 |",
  "[ref]: /url",
  "[^1]: footnote\n    # continued",
  "---",
  "plain para",
  "  spaced para",
  "line one\nline two",
];
const SEPS = ["\n\n", "\n", "\n\n\n"];
const EDITS = ["# x", "- y", "===", "```", "    z", "1. a", "<div>", "plain", "", "> q", "#", "| a |"];

function source(r: () => number): string {
  const n = 1 + Math.floor(r() * 14);
  let out = "";
  for (let i = 0; i < n; i++) out += (i === 0 ? "" : pick(r, SEPS)) + pick(r, SNIPPETS);
  return out + (r() < 0.8 ? "\n" : "");
}

/** Moves, deletes, retypes and adds blocks, the way the editor's drag, Backspace and typing do. */
function edit(r: () => number, doc: JSONContent): JSONContent {
  let list = [...blocks(doc)];
  const steps = 1 + Math.floor(r() * 4);
  for (let s = 0; s < steps && list.length > 0; s++) {
    const i = Math.floor(r() * list.length);
    const roll = r();
    if (roll < 0.3) {
      const [moved] = list.splice(i, 1);
      list.splice(Math.floor(r() * (list.length + 1)), 0, moved!);
    } else if (roll < 0.5) list.splice(i, 1);
    else if (roll < 0.8 && list[i]!.type === "paragraph") list[i] = withContent(list[i]!, pick(r, EDITS));
    else list.splice(i, 0, paragraph(pick(r, EDITS)));
  }
  if (list.length === 0) list = [paragraph("only")];
  return { ...doc, content: list };
}

describe("checking a page in parts", () => {
  it("gives exactly what checking the whole page gives, for random pages and edits", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      const { doc, frontmatter } = markdownToDoc(source(r));
      // Twice per page, so the second run takes parts remembered from the first.
      for (const next of [edit(r, doc), edit(r, doc)]) {
        const whole = serialize(next, { frontmatter }, false);
        expect(docToMarkdown(next, { frontmatter }), `seed ${seed}`).toBe(whole);
      }
    }
  });

  it("re-parses only the part that changed on a long page", () => {
    const sections = Array.from({ length: 200 }, (_, i) => `## Section ${i}\n\n${"Some text in this section. ".repeat(20)}\n\n- item\n- item`);
    const { doc, frontmatter } = markdownToDoc(sections.join("\n\n") + "\n");
    const first = docToMarkdown(doc, { frontmatter });
    // One paragraph retyped, as a keystroke does.
    const list = [...blocks(doc)];
    const at = list.findIndex((b, i) => i > 300 && b.type === "paragraph");
    list[at] = withContent(list[at]!, "Changed text.");
    const changed = { ...doc, content: list };
    const t0 = performance.now();
    const text = docToMarkdown(changed, { frontmatter });
    const inParts = performance.now() - t0;
    const t1 = performance.now();
    expect(serialize(changed, { frontmatter }, false)).toBe(text);
    const whole = performance.now() - t1;
    expect(text).not.toBe(first);
    expect(text).toContain("Changed text.");
    console.log(`long page, one block changed: ${inParts.toFixed(1)} ms in parts, ${whole.toFixed(1)} ms whole`);
    expect(inParts).toBeLessThan(whole / 3);
  });
});
