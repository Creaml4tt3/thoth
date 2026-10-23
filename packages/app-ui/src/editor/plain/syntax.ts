/**
 * Markdown language for Plain mode: CommonMark + GFM (as in `@thoth/content`),
 * YAML frontmatter, and wikilinks. Only used for highlighting and live preview;
 * it never decides what is written to disk.
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";

const BANG = 33;
const OPEN = 91;
const CLOSE = 93;
const NEWLINE = 10;

/** `[[Target]]`, `[[Target|alias]]` and `![[embed]]`, matching `@thoth/editor`'s rule: no brackets or newlines inside. */
export const wikilinkSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "Wikilink", style: tags.link },
    { name: "WikilinkMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Wikilink",
      before: "Link",
      parse(cx, next, pos) {
        const open = next === BANG ? pos + 1 : pos;
        if ((next !== OPEN && next !== BANG) || cx.char(open) !== OPEN || cx.char(open + 1) !== OPEN) return -1;
        for (let i = open + 2; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === NEWLINE || c === OPEN) return -1;
          if (c !== CLOSE) continue;
          if (i === open + 2 || cx.char(i + 1) !== CLOSE) return -1;
          return cx.addElement(cx.elt("Wikilink", pos, i + 2, [cx.elt("WikilinkMark", pos, open + 2), cx.elt("WikilinkMark", i, i + 2)]));
        }
        return -1;
      },
    },
  ],
};

export function markdownSupport() {
  // No URL-to-link paste rewriting and no tag completion: Plain mode inserts exactly what was typed or pasted.
  return yamlFrontmatter({ content: markdown({ base: markdownLanguage, extensions: [wikilinkSyntax], completeHTMLTags: false, pasteURLAsLink: false }) });
}

/** Token classes; colours and sizes live in plain.css (tokens only). */
export const markdownHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading1, class: "md-heading md-h1" },
    { tag: tags.heading2, class: "md-heading md-h2" },
    { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], class: "md-heading md-h3" },
    { tag: tags.emphasis, class: "md-em" },
    { tag: tags.strong, class: "md-strong" },
    { tag: tags.strikethrough, class: "md-strike" },
    { tag: tags.link, class: "md-link" },
    { tag: tags.url, class: "md-url" },
    { tag: tags.monospace, class: "md-code" },
    { tag: tags.processingInstruction, class: "md-mark" },
    { tag: tags.quote, class: "md-quote" },
    { tag: [tags.meta, tags.comment], class: "md-meta" },
    { tag: tags.labelName, class: "md-label" },
    { tag: tags.contentSeparator, class: "md-mark" },
    { tag: [tags.propertyName, tags.definition(tags.propertyName)], class: "md-key" },
  ]),
);
