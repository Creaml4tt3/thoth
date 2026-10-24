/**
 * Text styles for Blocks mode (ADR-0016 rule 1): the commands behind the
 * selection toolbar and the shortcuts, with no DOM.
 *
 * Each command is an `Edit`: it fills a transaction for a state and says whether
 * it changed anything. The toolbar and the keyboard run them with `runEdit`
 * (one undo step each); tests apply them with `applyEdit`.
 *
 * Marks go on text only. A wikilink, an inline image or a raw HTML atom inside
 * the selection is left as it is, so a style never reaches into something the
 * editor shows as written. Code blocks take no marks at all.
 */
import type { MarkType, Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { isTextColor, type TextColor } from "@thoth/editor";
import { applyAsOneStep } from "./block-ops.ts";

/** Marks that switch on and off. */
export const MARK_STYLES = ["bold", "italic", "underline", "strike", "inlineCode", "highlight"] as const;
export type MarkStyle = (typeof MARK_STYLES)[number];

// The shortcut table lives in `keyboard/style-keys.ts`, so the shortcuts list can read it without the editor.
export { STYLE_SHORTCUTS, WEB_STYLE_SHORTCUTS, styleShortcuts, type StyleCommand } from "../keyboard/style-keys.ts";

/** `Mod-Shift-h` as people read it: `Ctrl/Cmd+Shift+H`. */
export function shortcutLabel(key: string): string {
  return key
    .split("-")
    .map((part) => (part === "Mod" ? "Ctrl/Cmd" : part.length === 1 ? part.toUpperCase() : part))
    .join("+");
}

export type Edit = (state: EditorState, tr: Transaction) => boolean;

/** Applies `edit` to `state` and returns the next state, or null when it changed nothing. */
export function applyEdit(state: EditorState, edit: Edit): EditorState | null {
  const tr = state.tr;
  return edit(state, tr) ? state.apply(tr) : null;
}

/** Runs `edit` on the live editor as one undo step. */
export function runEdit(view: EditorView, edit: Edit): boolean {
  return applyAsOneStep(view, (tr) => edit(view.state, tr));
}

// ---------------------------------------------------------------------------
// Where a style applies

interface Span {
  from: number;
  to: number;
  node: PMNode;
}

/** The text nodes inside the selection, clipped to it, that can carry `type`. */
function spansFor(state: EditorState, type: MarkType): Span[] {
  const out: Span[] = [];
  for (const range of state.selection.ranges) {
    state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos, parent) => {
      if (!node.isText || !parent?.type.allowsMarkType(type)) return;
      const from = Math.max(pos, range.$from.pos);
      const to = Math.min(pos + node.nodeSize, range.$to.pos);
      if (to > from) out.push({ from, to, node });
    });
  }
  return out;
}

const markType = (state: EditorState, name: string): MarkType | undefined => state.schema.marks[name];

/** True when the selection is non-empty text that the toolbar may style: no code block, no raw or atom block, and some text. */
export function toolbarApplies(state: EditorState): boolean {
  const { selection } = state;
  if (selection.empty || selection instanceof NodeSelection) return false;
  let ok = true;
  let text = false;
  for (const range of selection.ranges) {
    state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node) => {
      if (!ok) return false;
      if (node.isTextblock && (node.type.spec.code || node.type.spec.marks === "")) ok = false;
      else if (node.isBlock && node.isAtom) ok = false;
      else if (node.isText) text = true;
      return ok;
    });
  }
  return ok && text;
}

// ---------------------------------------------------------------------------
// Reading the state

const allHave = (spans: Span[], type: MarkType) => spans.length > 0 && spans.every((s) => type.isInSet(s.node.marks));

/** True when every text node in the selection has the mark (or, for a caret, when typing would add it). */
export function isStyleActive(state: EditorState, name: MarkStyle | "link"): boolean {
  const type = markType(state, name);
  if (!type) return false;
  if (state.selection.empty) return !!type.isInSet(state.storedMarks ?? state.selection.$from.marks());
  return allHave(spansFor(state, type), type);
}

/** The palette colour shared by all selected text, or null when there is none or the text has several. */
export function activeTextColor(state: EditorState): TextColor | null {
  const type = markType(state, "textColor");
  if (!type) return null;
  const colors = state.selection.empty
    ? [(state.storedMarks ?? state.selection.$from.marks()).find((m) => m.type === type)?.attrs["color"]]
    : spansFor(state, type).map((s) => s.node.marks.find((m) => m.type === type)?.attrs["color"]);
  const first = colors[0];
  return colors.length > 0 && isTextColor(first) && colors.every((c) => c === first) ? first : null;
}

/** The link address shared by all selected text, or null when there is none or the text has several. */
export function activeLinkHref(state: EditorState): string | null {
  const type = markType(state, "link");
  if (!type || state.selection.empty) return null;
  const spans = spansFor(state, type);
  const hrefs = spans.map((s) => s.node.marks.find((m) => m.type === type)?.attrs["href"]);
  const first = hrefs[0];
  return typeof first === "string" && hrefs.every((h) => h === first) ? first : null;
}

// ---------------------------------------------------------------------------
// Commands

/** Switches a mark on for the whole selection, or off when all of it already has it. With a caret, changes what is typed next. */
export const toggleStyle =
  (name: MarkStyle): Edit =>
  (state, tr) => {
    const type = markType(state, name);
    if (!type) return false;
    if (state.selection.empty) {
      const { $from } = state.selection;
      if (!$from.parent.inlineContent || !$from.parent.type.allowsMarkType(type)) return false;
      if (type.isInSet(state.storedMarks ?? $from.marks())) tr.removeStoredMark(type);
      else tr.addStoredMark(type.create());
      return true;
    }
    const spans = spansFor(state, type);
    if (spans.length === 0) return false;
    const off = allHave(spans, type);
    for (const { from, to } of spans) {
      if (off) tr.removeMark(from, to, type);
      else tr.addMark(from, to, type.create());
    }
    return true;
  };

/** Sets the text colour of the selection to a palette colour, or clears it with null ("default"). */
export const setTextColor =
  (color: TextColor | null): Edit =>
  (state, tr) => {
    const type = markType(state, "textColor");
    if (!type || (color !== null && !isTextColor(color))) return false;
    if (state.selection.empty) {
      const { $from } = state.selection;
      if (!$from.parent.inlineContent || !$from.parent.type.allowsMarkType(type)) return false;
      tr.removeStoredMark(type);
      if (color) tr.addStoredMark(type.create({ color }));
      return true;
    }
    const spans = spansFor(state, type);
    if (spans.length === 0) return false;
    for (const { from, to } of spans) {
      tr.removeMark(from, to, type);
      if (color) tr.addMark(from, to, type.create({ color }));
    }
    return true;
  };

/** Links the selected text to `href`, or removes the link with null. Needs a selection. */
export const setLink =
  (href: string | null): Edit =>
  (state, tr) => {
    const type = markType(state, "link");
    if (!type || state.selection.empty) return false;
    const spans = spansFor(state, type);
    if (spans.length === 0) return false;
    for (const { from, to } of spans) {
      tr.removeMark(from, to, type);
      if (href) tr.addMark(from, to, type.create({ href }));
    }
    return true;
  };

// ---------------------------------------------------------------------------
// Link addresses

const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/**
 * Cleans what was typed in the link field. Returns "" for an empty field (remove the link), the address to store,
 * or null when it is not acceptable: another scheme (`javascript:`, `data:`), a protocol-relative `//host` or
 * a control character. A bare `example.com` becomes `https://example.com`; a page path or `#heading` is kept.
 */
export function normalizeHref(input: string): string | null {
  const value = input.trim();
  if (value === "") return "";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value) || value.startsWith("//")) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (scheme) return SAFE_SCHEMES.has(scheme[1]!.toLowerCase()) ? value : null;
  // `notes.md` is a page, not the Moldovan domain; everything else that looks like a host gets https.
  if (!/\.(?:md|markdown)(?:[#?]|$)/i.test(value) && !/\s/.test(value) && /^(?:www\.|[^/#?]+\.[a-z]{2,}(?:[/?#]|$))/i.test(value)) return `https://${value}`;
  return value;
}
