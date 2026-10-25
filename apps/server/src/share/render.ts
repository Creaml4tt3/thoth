/**
 * Markdown to HTML for shared pages (ADR-0023 rule 5), on the repository's own parser (`@thoth/content`: mdast with
 * GFM). This is an allowlist renderer: every tag and attribute in the output is written here, and every piece of the
 * page's text goes through `escapeHtml`. Raw HTML in the Markdown is shown as escaped text, never passed through; the
 * only tags taken from it are Thoth's own text styles (`<u>`, and `<span data-color>` with a palette name), which are
 * re-written as fixed tags.
 *
 * Links: a page of the shared subtree goes to its share address; any other `thoth:` link and every wikilink become
 * plain text (a page outside is never looked up, so its title cannot show); `http`, `https` and `mailto` links keep
 * their address with `rel="noopener noreferrer nofollow"`; every other scheme and every relative path is text.
 * Pictures load only from the share's own attachment route; an outside image becomes a link.
 */
import { parseMarkdownTree, splitFrontmatter } from "@thoth/content";
import type { Nodes, PhrasingContent, RootContent, Table, List, ListItem, Definition, FootnoteDefinition } from "mdast";
import { escapeHtml as esc } from "../signin/html.ts";

export interface SharedPageRef {
  href: string;
  title: string;
}

export interface SharedAttachmentRef {
  href: string;
  /** A raster image the browser may show inline; anything else is offered as a download. */
  inline: boolean;
  name: string;
}

export interface RenderContext {
  /** A page of the shared subtree, or `null` for any other page (which then stays text). */
  page(id: string): SharedPageRef | null;
  /** An attachment the share may serve, or `null`. */
  attachment(id: string): SharedAttachmentRef | null;
}

export interface Rendered {
  html: string;
  /** Every attachment the page refers to (in links, images and wikilinks, not in code): what the share may serve. */
  attachmentIds: Set<string>;
  /** True when the page opens with a level-1 heading (the page then needs no separate title heading). */
  opensWithTitle: boolean;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAGE_PREFIX = "thoth:page/";
const ATTACHMENT_PREFIX = "thoth:attachment/";
const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const HIGHLIGHT = /==([^=\n](?:[^\n]*?[^=\n])?)==/g;
const TEXT_COLORS = new Set(["gray", "brown", "orange", "yellow", "green", "blue", "purple", "red"]);
const COLOR_OPEN = /^<span[ \t]+data-color[ \t]*=[ \t]*(?:"([a-z]+)"|'([a-z]+)'|([a-z]+))[ \t]*>$/;
const SIZE_LABEL = /^\d+(x\d+)?$/;
const LANGUAGE = /^[A-Za-z0-9_+.#-]{1,40}$/;
const OUTSIDE_PAGE = "a page that is not shared";

/** `thoth:page/<uuidv7>` or `thoth:attachment/<uuidv7>`, else undefined. */
function thothLink(target: string): { kind: "page" | "attachment"; id: string } | undefined {
  const t = target.trim();
  const kind = t.startsWith(PAGE_PREFIX) ? "page" : t.startsWith(ATTACHMENT_PREFIX) ? "attachment" : undefined;
  if (!kind) return undefined;
  const id = t.slice(kind === "page" ? PAGE_PREFIX.length : ATTACHMENT_PREFIX.length).split("#")[0]!.toLowerCase();
  return UUID_V7.test(id) ? { kind, id } : undefined;
}

/** The address of an external link, if it is one the page may carry: absolute http(s) or mailto, nothing hidden in it. */
export function safeExternalUrl(raw: string): string | null {
  if (/[\u0000-\u0020\u007f-\u009f]/.test(raw)) return null;
  if (!/^(https?:\/\/|mailto:)/i.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? raw : null;
  } catch {
    return null;
  }
}

const external = (href: string, label: string) => `<a href="${esc(href)}" rel="noopener noreferrer nofollow">${label}</a>`;

export function renderShareMarkdown(source: string, ctx: RenderContext): Rendered {
  const body = source.slice(splitFrontmatter(source).bodyOffset);
  const tree = parseMarkdownTree(body);
  const attachmentIds = new Set<string>();
  const definitions = new Map<string, Definition>();
  const footnotes = new Map<string, FootnoteDefinition>();
  const footnoteOrder: string[] = [];
  const collect = (node: Nodes) => {
    if (node.type === "definition") definitions.set(node.identifier, node);
    if (node.type === "footnoteDefinition") footnotes.set(node.identifier, node);
    if ("children" in node) for (const child of node.children) collect(child);
  };
  collect(tree);

  const attachmentRef = (id: string): SharedAttachmentRef | null => {
    attachmentIds.add(id);
    return ctx.attachment(id);
  };

  /** A link to an attachment: inline types open in place, the rest download. */
  const attachmentLink = (ref: SharedAttachmentRef, label: string) => (ref.inline ? `<a href="${esc(ref.href)}">${label}</a>` : `<a href="${esc(ref.href)}" download>${label}</a>`);

  const wikilink = (embed: boolean, inner: string): string => {
    const pipe = inner.indexOf("|");
    let target = pipe === -1 ? inner : inner.slice(0, pipe);
    const label = pipe === -1 ? undefined : inner.slice(pipe + 1);
    if (target.endsWith("\\")) target = target.slice(0, -1); // `\|` inside tables
    const link = thothLink(target);
    if (link?.kind === "page") {
      const page = ctx.page(link.id);
      return page ? `<a href="${esc(page.href)}">${esc(label ?? page.title)}</a>` : esc(label ?? OUTSIDE_PAGE);
    }
    if (link?.kind === "attachment") {
      const ref = attachmentRef(link.id);
      const shown = label !== undefined && !(embed && SIZE_LABEL.test(label)) ? label : undefined;
      if (!ref) return esc(shown ?? "attachment");
      if (embed && ref.inline) return `<img src="${esc(ref.href)}" alt="${esc(shown ?? ref.name)}">`;
      return attachmentLink(ref, esc(shown ?? ref.name));
    }
    // A wikilink by name (Obsidian style) is not resolved: it stays text.
    return esc(label ?? target.split("#")[0]!.trim());
  };

  const highlighted = (text: string) => {
    let out = "";
    let at = 0;
    for (const m of text.matchAll(HIGHLIGHT)) {
      out += esc(text.slice(at, m.index)) + `<mark>${esc(m[1]!)}</mark>`;
      at = m.index + m[0].length;
    }
    return out + esc(text.slice(at));
  };

  const text = (value: string) => {
    let out = "";
    let at = 0;
    for (const m of value.matchAll(WIKILINK)) {
      out += highlighted(value.slice(at, m.index)) + wikilink(m[1] === "!", m[2]!);
      at = m.index + m[0].length;
    }
    return out + highlighted(value.slice(at));
  };

  const linkTo = (url: string, label: string): string => {
    const link = thothLink(url);
    if (link?.kind === "page") {
      const page = ctx.page(link.id);
      return page ? `<a href="${esc(page.href)}">${label}</a>` : label;
    }
    if (link?.kind === "attachment") {
      const ref = attachmentRef(link.id);
      return ref ? attachmentLink(ref, label) : label;
    }
    const href = safeExternalUrl(url);
    return href ? external(href, label) : label;
  };

  const imageOf = (url: string, alt: string): string => {
    const link = thothLink(url);
    if (link?.kind === "attachment") {
      const ref = attachmentRef(link.id);
      if (!ref) return esc(alt);
      return ref.inline ? `<img src="${esc(ref.href)}" alt="${esc(alt)}">` : attachmentLink(ref, esc(alt || ref.name));
    }
    if (link?.kind === "page") return linkTo(url, esc(alt));
    // The CSP allows images from the server only: an outside picture would not load (and would track the reader).
    const href = safeExternalUrl(url);
    return href ? external(href, esc(alt || url)) : esc(alt);
  };

  /** Thoth's text-style tags from inline HTML, as the fixed tags written here; `null` for any other HTML. */
  const styleTag = (raw: string): { name: "u" | "span"; open: boolean; html: string } | null => {
    const value = raw.trim();
    if (/^<u>$/i.test(value)) return { name: "u", open: true, html: "<u>" };
    if (/^<\/u>$/i.test(value)) return { name: "u", open: false, html: "</u>" };
    if (/^<\/span>$/i.test(value)) return { name: "span", open: false, html: "</span>" };
    const color = COLOR_OPEN.exec(value);
    const name = color?.[1] ?? color?.[2] ?? color?.[3];
    if (name && TEXT_COLORS.has(name)) return { name: "span", open: true, html: `<span class="tc tc-${name}">` };
    return null;
  };

  const inlines = (nodes: readonly PhrasingContent[]): string => {
    const open: ("u" | "span")[] = [];
    let out = "";
    for (const node of nodes) {
      if (node.type === "html") {
        const tag = styleTag(node.value);
        if (tag?.open) {
          open.push(tag.name);
          out += tag.html;
        } else if (tag && open.at(-1) === tag.name) {
          open.pop();
          out += tag.html;
        } else out += esc(node.value);
        continue;
      }
      out += inline(node);
    }
    while (open.length > 0) out += `</${open.pop()}>`;
    return out;
  };

  const inline = (node: PhrasingContent): string => {
    switch (node.type) {
      case "text":
        return text(node.value);
      case "emphasis":
        return `<em>${inlines(node.children)}</em>`;
      case "strong":
        return `<strong>${inlines(node.children)}</strong>`;
      case "delete":
        return `<del>${inlines(node.children)}</del>`;
      case "inlineCode":
        return `<code>${esc(node.value)}</code>`;
      case "break":
        return "<br>\n";
      case "link":
        return linkTo(node.url, inlines(node.children));
      case "image":
        return imageOf(node.url, node.alt ?? "");
      case "linkReference": {
        const def = definitions.get(node.identifier);
        return def ? linkTo(def.url, inlines(node.children)) : inlines(node.children);
      }
      case "imageReference": {
        const def = definitions.get(node.identifier);
        return def ? imageOf(def.url, node.alt ?? "") : esc(node.alt ?? "");
      }
      case "footnoteReference": {
        if (!footnotes.has(node.identifier)) return esc(`[^${node.label ?? node.identifier}]`);
        if (!footnoteOrder.includes(node.identifier)) footnoteOrder.push(node.identifier);
        const n = footnoteOrder.indexOf(node.identifier) + 1;
        return `<sup><a href="#fn-${n}" id="fnref-${n}">${n}</a></sup>`;
      }
      case "html":
        return esc(node.value);
      default:
        return "";
    }
  };

  const listItem = (item: ListItem, tight: boolean): string => {
    const box = typeof item.checked === "boolean" ? `<input type="checkbox" disabled${item.checked ? " checked" : ""} aria-label="${item.checked ? "Done" : "Not done"}"> ` : "";
    if (tight) return `<li>${box}${item.children.map((c) => (c.type === "paragraph" ? inlines(c.children) : `\n${block(c)}`)).join("")}</li>\n`;
    return `<li>${box}\n${blocks(item.children)}</li>\n`;
  };

  const list = (node: List): string => {
    const tag = node.ordered ? "ol" : "ul";
    const start = node.ordered && typeof node.start === "number" && node.start !== 1 ? ` start="${node.start}"` : "";
    const tasks = node.children.some((i) => typeof i.checked === "boolean") ? ' class="tasks"' : "";
    const tight = node.spread !== true && node.children.every((i) => i.spread !== true);
    return `<${tag}${start}${tasks}>\n${node.children.map((i) => listItem(i, tight)).join("")}</${tag}>\n`;
  };

  const table = (node: Table): string => {
    const align = (i: number) => {
      const a = node.align?.[i];
      return a ? ` class="${a}"` : "";
    };
    const row = (cells: Table["children"][number], tag: "th" | "td") => `<tr>${cells.children.map((c, i) => `<${tag}${align(i)}>${inlines(c.children)}</${tag}>`).join("")}</tr>\n`;
    const [head, ...rows] = node.children;
    const thead = head ? `<thead>\n${row(head, "th")}</thead>\n` : "";
    const tbody = rows.length > 0 ? `<tbody>\n${rows.map((r) => row(r, "td")).join("")}</tbody>\n` : "";
    // Focusable, so a table wider than a phone can be scrolled from the keyboard.
    return `<div class="table" tabindex="0"><table>\n${thead}${tbody}</table></div>\n`;
  };

  const block = (node: RootContent): string => {
    switch (node.type) {
      case "paragraph":
        return `<p>${inlines(node.children)}</p>\n`;
      case "heading":
        return `<h${node.depth}>${inlines(node.children)}</h${node.depth}>\n`;
      case "thematicBreak":
        return "<hr>\n";
      case "blockquote":
        return `<blockquote>\n${blocks(node.children)}</blockquote>\n`;
      case "list":
        return list(node);
      case "table":
        return table(node);
      case "code": {
        const lang = node.lang && LANGUAGE.test(node.lang) ? ` class="language-${esc(node.lang)}"` : "";
        return `<pre><code${lang}>${esc(node.value)}\n</code></pre>\n`;
      }
      case "html":
        // Raw HTML is never passed through: it is shown as the text it is.
        return `<p class="raw">${esc(node.value)}</p>\n`;
      case "definition":
      case "footnoteDefinition":
        return "";
      default:
        if ("children" in node && Array.isArray(node.children)) return blocks(node.children as RootContent[]);
        return "value" in node && typeof node.value === "string" ? `<p>${esc(node.value)}</p>\n` : "";
    }
  };

  const blocks = (nodes: readonly RootContent[]): string => nodes.map(block).join("");

  let html = blocks(tree.children);
  if (footnoteOrder.length > 0) {
    // Footnotes may refer to further footnotes; render until no new one appears.
    const items: string[] = [];
    for (let i = 0; i < footnoteOrder.length; i++) {
      const def = footnotes.get(footnoteOrder[i]!)!;
      items.push(`<li id="fn-${i + 1}">\n${blocks(def.children)}<p><a href="#fnref-${i + 1}" aria-label="Back to the text">↩</a></p>\n</li>\n`);
    }
    html += `<section class="footnotes">\n<ol>\n${items.join("")}</ol>\n</section>\n`;
  }
  const first = tree.children.find((n) => n.type !== "definition" && n.type !== "footnoteDefinition");
  return { html, attachmentIds, opensWithTitle: first?.type === "heading" && first.depth === 1 };
}
