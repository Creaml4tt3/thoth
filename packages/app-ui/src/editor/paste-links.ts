/**
 * Paste makes links (ADR-0020 rule 1), Blocks mode only (Plain mode inserts what was pasted).
 *
 * - One `http(s)` link (or `www.` or `mailto:`) pasted over selected text links that text; with no selection it is
 *   inserted as a link whose text is the link.
 * - Pasted text with links in it: each bare `http(s)://…` or `www.…` becomes a link, found by GitHub's rules
 *   (trailing punctuation and an unmatched `)` stay outside); the rest stays text.
 * - Nothing happens inside code (a code block, inline code) or for Cmd/Ctrl+Shift+V (plain text).
 * - The paste and the linking are two undo steps: one undo turns the link back into the pasted text.
 * - Only `http:`, `https:` and `mailto:` become links. Links in pasted HTML with any other scheme (`javascript:`,
 *   `data:`, `file:` …) lose their link and keep their text.
 *
 * The Markdown written is the serializer's usual link form (`<https://…>` when the text is the address).
 */
import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Slice, type MarkType, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { EditorContext } from "./context.ts";

/** Schemes a paste may turn into a link. */
const PASTE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** True for an address a paste may link: `http(s)` with a host, or `mailto:`. */
export function isPasteLinkHref(href: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(href)) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (!PASTE_SCHEMES.has(url.protocol)) return false;
  return url.protocol === "mailto:" ? url.pathname !== "" : url.hostname !== "";
}

export interface FoundUrl {
  /** Offsets in the text searched. */
  from: number;
  to: number;
  /** The address to link to (`www.` links get `https://`). */
  href: string;
}

// GitHub's extended autolinks: at the start, after white space or after `*`, `_`, `~` or `(`.
const START = /(^|[\s*_~(])(https?:\/\/|www\.)/gi;
// A valid domain: segments of letters, digits, `_` and `-`, at least one dot, no `_` in the last two segments.
const DOMAIN = /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/u;
const TRAILING = /[?!.,:*_~]$/;

/** Cuts what GitHub leaves out at the end of an autolink: punctuation, an unmatched `)`, an entity-like `&x;`. */
function trimEnd(candidate: string): string {
  let s = candidate;
  for (;;) {
    if (TRAILING.test(s)) {
      s = s.slice(0, -1);
      continue;
    }
    if (s.endsWith(")")) {
      const open = (s.match(/\(/g) ?? []).length;
      const close = (s.match(/\)/g) ?? []).length;
      if (close > open) {
        s = s.slice(0, -1);
        continue;
      }
    }
    const entity = /&[A-Za-z0-9]+;$/.exec(s);
    if (entity) {
      s = s.slice(0, entity.index);
      continue;
    }
    return s;
  }
}

/** The bare `http(s)://` and `www.` links in `text`, by GitHub's autolink rules. */
export function findUrls(text: string): FoundUrl[] {
  const out: FoundUrl[] = [];
  START.lastIndex = 0;
  for (let m = START.exec(text); m; m = START.exec(text)) {
    const from = m.index + m[1]!.length;
    const raw = /^[^\s<]+/.exec(text.slice(from))![0];
    const www = /^www\./i.test(m[2]!);
    const afterScheme = www ? raw : raw.slice(m[2]!.length);
    const domain = DOMAIN.exec(afterScheme);
    if (!domain || domain[0].split(".").slice(-2).some((part) => part.includes("_"))) {
      START.lastIndex = from + m[2]!.length;
      continue;
    }
    const kept = trimEnd(raw);
    const prefix = www ? 0 : m[2]!.length;
    if (kept.length < prefix + domain[0].length) {
      START.lastIndex = from + m[2]!.length;
      continue;
    }
    const href = www ? `https://${kept}` : kept;
    if (isPasteLinkHref(href)) out.push({ from, to: from + kept.length, href });
    START.lastIndex = from + kept.length;
  }
  return out;
}

/** The address when `text` (trimmed) is exactly one link a paste may make: `http(s)`, `www.` or `mailto:`. */
export function pastedLink(text: string): string | null {
  const value = text.trim();
  // eslint-disable-next-line no-control-regex
  if (value === "" || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  if (/^mailto:/i.test(value)) return isPasteLinkHref(value) ? value : null;
  const found = findUrls(value);
  return found.length === 1 && found[0]!.from === 0 && found[0]!.to === value.length ? found[0]!.href : null;
}

/** Is the selection in code: a code block, or text that has (or would get) inline code? */
function inCode(state: EditorState): boolean {
  const { $from, $to, empty } = state.selection;
  if ($from.parent.type.spec.code || $to.parent.type.spec.code) return true;
  const isCode = (marks: readonly { type: { name: string; spec: { code?: boolean } } }[]) => marks.some((m) => m.type.name === "inlineCode" || m.type.spec.code);
  if (empty) return isCode(state.storedMarks ?? $from.marks());
  let code = false;
  state.doc.nodesBetween($from.pos, $to.pos, (node) => {
    if (node.isText && isCode(node.marks)) code = true;
  });
  return code;
}

/** Links every URL in the text of `tr.doc` between `from` and `to`, outside code and existing links. Returns the hrefs. */
function linkify(tr: Transaction, from: number, to: number, link: MarkType): string[] {
  const hrefs: string[] = [];
  const found: { from: number; to: number; href: string }[] = [];
  tr.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (node.isTextblock && node.type.spec.code) return false;
    if (!node.isText || !parent?.type.allowsMarkType(link)) return;
    if (link.isInSet(node.marks) || node.marks.some((m) => m.type.name === "inlineCode" || m.type.spec.code)) return;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    const text = node.text!.slice(start - pos, end - pos);
    for (const u of findUrls(text)) found.push({ from: start + u.from, to: start + u.to, href: u.href });
  });
  for (const u of found) {
    tr.addMark(u.from, u.to, link.create({ href: u.href }));
    hrefs.push(u.href);
  }
  return hrefs;
}

/** Removes link marks whose address a paste may not make (`javascript:`, `data:`, `file:`, relative …). */
function dropUnsafeLinks(fragment: Fragment, link: MarkType): Fragment {
  const out: PMNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      const bad = node.marks.find((m) => m.type === link && !isPasteLinkHref(String(m.attrs["href"] ?? "")));
      out.push(bad ? node.mark(bad.removeFromSet(node.marks)) : node);
    } else {
      out.push(node.copy(dropUnsafeLinks(node.content, link)));
    }
  });
  return Fragment.fromArray(out);
}

function sliceText(slice: Slice): string {
  return slice.content.textBetween(0, slice.content.size, "\n", " ");
}

const pasteMeta = (tr: Transaction) => tr.setMeta("paste", true).setMeta("uiEvent", "paste").scrollIntoView();

/** One link pasted: over a selection inside one text block it links that text, otherwise it is inserted as its own text. */
function pasteOneLink(view: EditorView, href: string, link: MarkType): void {
  const { state } = view;
  const { from, to, empty, $from, $to } = state.selection;
  const overText = !empty && $from.sameParent($to) && $from.parent.inlineContent;
  const original = overText ? state.doc.slice(from, to) : null;
  view.dispatch(pasteMeta(closeHistory(state.tr).insertText(href, from, to)));
  const tr = closeHistory(view.state.tr);
  if (original) {
    tr.replace(from, from + href.length, original);
    tr.addMark(from, from + original.size, link.create({ href }));
    tr.setSelection(TextSelection.create(tr.doc, from + original.size));
  } else {
    tr.addMark(from, from + href.length, link.create({ href }));
  }
  view.dispatch(tr.scrollIntoView());
  view.dispatch(closeHistory(view.state.tr));
}

/** Pasted content with links in its text: the paste as it is (one undo step), then its links (another). */
function pasteAndLinkify(view: EditorView, slice: Slice, link: MarkType): string[] {
  const start = view.state.selection.from;
  const first = closeHistory(view.state.tr).replaceSelection(slice);
  const from = first.mapping.map(start, -1);
  view.dispatch(pasteMeta(first));
  const to = view.state.selection.to;
  const tr = closeHistory(view.state.tr);
  const hrefs = linkify(tr, from, to, link);
  if (hrefs.length > 0) {
    view.dispatch(tr);
    view.dispatch(closeHistory(view.state.tr));
  }
  return hrefs;
}

const pasteLinksKey = new PluginKey("thothPasteLinks");

export function pasteLinksExtension(ctx: EditorContext) {
  return Extension.create({
    name: "thothPasteLinks",
    addProseMirrorPlugins() {
      // Shift held at paste time is Cmd/Ctrl+Shift+V: plain text, no links (ProseMirror reads it the same way).
      let shift = false;
      return [
        new Plugin({
          key: pasteLinksKey,
          props: {
            handleDOMEvents: {
              keydown: (_view, event) => {
                shift = event.shiftKey;
                return false;
              },
              keyup: (_view, event) => {
                shift = event.shiftKey;
                return false;
              },
              blur: () => {
                shift = false;
                return false;
              },
            },
            transformPasted: (slice, view) => {
              const link = view.state.schema.marks["link"];
              return link ? new Slice(dropUnsafeLinks(slice.content, link), slice.openStart, slice.openEnd) : slice;
            },
            handlePaste: (view, event, slice) => {
              const link = view.state.schema.marks["link"];
              if (!link || shift || !view.editable || inCode(view.state)) return false;
              const text = event.clipboardData?.getData("text/plain") ?? "";
              const href = pastedLink(text);
              if (href) {
                pasteOneLink(view, href, link);
                ctx.links?.pasted([href]);
                return true;
              }
              if (findUrls(sliceText(slice)).length === 0) return false;
              const hrefs = pasteAndLinkify(view, slice, link);
              if (hrefs.length > 0) ctx.links?.pasted(hrefs);
              return true;
            },
          },
        }),
      ];
    },
  });
}
