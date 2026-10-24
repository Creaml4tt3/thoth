/**
 * Live preview for Plain mode (Obsidian-style): Markdown markup is hidden on
 * lines the cursor is not on, wikilinks become chips, task markers become
 * checkboxes and a callout's `[!kind]` marker becomes its label. `==x==`, `<u>x</u>` and palette colour spans
 * (`<span data-color="red">x</span>`, ADR-0016) show as highlighted, underlined and coloured text with their
 * markers hidden. It is display only. The document is never rewritten to show it,
 * and the line being edited always shows its exact source.
 */
import { RangeSet, StateEffect, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNodeRef } from "@lezer/common";
import { isTextColor, parseWikiInner, type TextColor } from "@thoth/editor";
import type { EditorContext } from "../context.ts";
import type { LinkTarget } from "../links.ts";
import { kindClass, kindIcon, kindLabel } from "../callout-kinds.ts";

/** Dispatched when the link index changes, so chips re-resolve. */
export const refreshLinks = StateEffect.define<null>();

const hide = Decoration.replace({});
const line = (cls: string, attributes?: Record<string, string>) => Decoration.line({ class: cls, ...(attributes ? { attributes } : {}) });

class WikilinkChip extends WidgetType {
  readonly ctx: EditorContext;
  readonly target: string;
  readonly label: string;
  readonly embed: boolean;
  readonly result: LinkTarget;
  constructor(ctx: EditorContext, target: string, label: string, embed: boolean, result: LinkTarget) {
    super();
    this.ctx = ctx;
    this.target = target;
    this.label = label;
    this.embed = embed;
    this.result = result;
  }
  override eq(other: WikilinkChip): boolean {
    return other.target === this.target && other.label === this.label && other.embed === this.embed && JSON.stringify(other.result) === JSON.stringify(this.result);
  }
  toDOM(): HTMLElement {
    const chip = document.createElement("a");
    chip.className = "wikilink";
    chip.dataset["state"] = this.result.state;
    chip.dataset["target"] = this.result.state === "resolved" ? this.result.path : "";
    const t = this.ctx.strings;
    chip.textContent = this.embed ? `${t.embed}${this.label}` : this.label;
    chip.setAttribute("role", "link");
    chip.title = this.result.state === "resolved" ? this.result.path : this.result.state === "ambiguous" ? t.linkAmbiguous(this.result.candidates.join(", ")) : t.linkUnresolved(this.target);
    chip.addEventListener("mousedown", (event) => {
      event.preventDefault();
      if (this.result.state === "resolved") this.ctx.openPage(this.result.path);
    });
    return chip;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

class TaskBox extends WidgetType {
  readonly checked: boolean;
  readonly at: number;
  readonly label: string;
  constructor(checked: boolean, at: number, label: string) {
    super();
    this.checked = checked;
    this.at = at;
    this.label = label;
  }
  override eq(other: TaskBox): boolean {
    return other.checked === this.checked && other.at === this.at;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "task-box";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.label);
    box.disabled = view.state.readOnly;
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      if (view.state.readOnly) return;
      // The one character between the brackets: a real, undoable edit.
      view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? " " : "x" }, userEvent: "input.toggle" });
    });
    return box;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

class Bullet extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const dot = document.createElement("span");
    dot.className = "md-bullet";
    dot.textContent = "•";
    return dot;
  }
}

class Rule extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const hr = document.createElement("span");
    hr.className = "md-hr";
    return hr;
  }
}

/** A callout's label (icon and kind) in place of its `[!kind]+` marker, as Blocks mode shows it. */
class CalloutLabel extends WidgetType {
  readonly kind: string;
  constructor(kind: string) {
    super();
    this.kind = kind;
  }
  override eq(other: CalloutLabel): boolean {
    return other.kind === this.kind;
  }
  toDOM(): HTMLElement {
    const label = document.createElement("span");
    label.className = "md-callout-label";
    const icon = document.createElement("span");
    icon.className = "md-callout-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = kindIcon(this.kind);
    label.append(icon, kindLabel(this.kind));
    return label;
  }
}

const HEADING = /^(?:ATX|Setext)Heading([1-6])$/;

// Inline HTML tags that make a text style, read like `@thoth/editor` reads them (case-insensitive `u`, exact `data-color`).
const U_OPEN = /^<u>$/i;
const U_CLOSE = /^<\/u[ \t]*>$/i;
const SPAN_OPEN = /^<span[\s>]/i;
const COLOR_OPEN = /^<span[ \t]+data-color[ \t]*=[ \t]*(?:"([a-z]+)"|'([a-z]+)'|([a-z]+))[ \t]*>$/;
const SPAN_CLOSE = /^<\/span[ \t]*>$/i;
/** Inline nodes that can wrap a tag without being the block it belongs to. */
const INLINE_WRAPPERS = new Set(["Emphasis", "StrongEmphasis", "Strikethrough", "Highlight", "Link", "Image"]);

interface OpenTag {
  tag: "u" | "span";
  from: number;
  to: number;
  /** The palette colour of a `span`, null for any other span (its `</span>` is still consumed). */
  color: TextColor | null;
}

/** What follows a quote's first `>` on a callout's first line, as `@thoth/editor` reads it (`> [!kind]+ title`). */
const CALLOUT = /^([ \t]*)\[!([A-Za-z0-9_-]+)\][+-]?[ \t]*/;
const BLOCK_LINE: Record<string, string> = { FencedCode: "md-line-code", CodeBlock: "md-line-code", Blockquote: "md-line-quote", Frontmatter: "md-line-meta" };

/** Lines (by start offset) that hold a cursor or selection: those show their source. */
function activeLines(view: EditorView): Set<number> {
  const active = new Set<number>();
  if (!view.hasFocus) return active;
  for (const range of view.state.selection.ranges) {
    for (let pos = range.from; ; ) {
      const l = view.state.doc.lineAt(pos);
      active.add(l.from);
      if (l.to >= range.to) break;
      pos = l.to + 1;
    }
  }
  return active;
}

function build(view: EditorView, ctx: EditorContext): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const active = activeLines(view);
  const out: Range<Decoration>[] = [];
  const seen = new Set<string>();
  const onActiveLine = (pos: number) => active.has(doc.lineAt(pos).from);
  const styleLines = (from: number, end: number, cls: string, attributes?: Record<string, string>) => {
    // A node that ends at the start of a line (frontmatter ends after its closing fence's line break) does not cover that line.
    const to = end > from && doc.lineAt(end).from === end ? end - 1 : end;
    for (let pos = from; pos <= to; ) {
      const l = doc.lineAt(pos);
      const key = `${l.from}:${cls}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(line(cls, attributes).range(l.from));
      }
      if (l.to >= to) break;
      pos = l.to + 1;
    }
  };
  // Replaced ranges never cross a line. Visible ranges can overlap one node, so each range is added once.
  const replace = (from: number, to: number, deco: Decoration = hide) => {
    const key = `${from}-${to}`;
    if (to <= from || seen.has(key) || doc.lineAt(from).number !== doc.lineAt(to).number) return;
    seen.add(key);
    out.push(deco.range(from, to));
  };
  // Style marks (highlight, underline, colour). A tag pairs with the nearest earlier opener of its kind in the same block.
  const openTags = new Map<number, OpenTag[]>();
  const style = (from: number, to: number, cls: string, attributes?: Record<string, string>) => {
    const key = `${from}-${to}:${cls}`;
    if (to <= from || seen.has(key)) return;
    seen.add(key);
    out.push(Decoration.mark({ class: cls, ...(attributes ? { attributes } : {}) }).range(from, to));
  };
  const blockKey = (node: SyntaxNodeRef): number => {
    let parent = node.node.parent;
    while (parent && INLINE_WRAPPERS.has(parent.name)) parent = parent.parent;
    return parent?.from ?? -1;
  };
  const htmlTag = (node: SyntaxNodeRef) => {
    const text = doc.sliceString(node.from, node.to);
    const key = blockKey(node);
    const stack = openTags.get(key) ?? [];
    openTags.set(key, stack);
    if (U_OPEN.test(text)) return void stack.push({ tag: "u", from: node.from, to: node.to, color: null });
    if (SPAN_OPEN.test(text)) {
      const m = COLOR_OPEN.exec(text);
      const color = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
      return void stack.push({ tag: "span", from: node.from, to: node.to, color: isTextColor(color) ? color : null });
    }
    const tag = U_CLOSE.test(text) ? "u" : SPAN_CLOSE.test(text) ? "span" : null;
    if (!tag) return;
    const at = stack.findLastIndex((o) => o.tag === tag);
    if (at < 0) return;
    const open = stack[at]!;
    stack.length = at; // openers above it stay unpaired, as in the serializer
    if (tag === "span" && !open.color) return;
    if (tag === "u") style(open.to, node.from, "md-underline");
    else style(open.to, node.from, "text-color", { "data-color": open.color! });
    for (const [from, to] of [[open.from, open.to], [node.from, node.to]] as const) if (!onActiveLine(from)) replace(from, to);
  };
  // Markers shown as labels: lezer reads `[!kind]` as a link, whose brackets must not be hidden on their own.
  const markers: [number, number][] = [];
  const inMarker = (pos: number) => markers.some(([from, to]) => pos >= from && pos < to);
  /** A quote whose first line starts with `[!kind]` is a callout: its lines take the kind's look, the marker becomes a label. */
  const callout = (node: SyntaxNodeRef) => {
    const quote = node.node.getChild("QuoteMark");
    const first = doc.lineAt(node.from);
    if (!quote || quote.to > first.to) return;
    const m = CALLOUT.exec(doc.sliceString(quote.to, first.to));
    if (!m) return;
    const kind = m[2]!;
    styleLines(node.from, node.to, "md-line-callout", { "data-callout": kindClass(kind) });
    styleLines(first.from, first.from, "md-line-callout-title");
    if (active.has(first.from)) return;
    const from = quote.to + m[1]!.length;
    const to = quote.to + m[0].length;
    markers.push([from, to]);
    replace(from, to, Decoration.replace({ widget: new CalloutLabel(kind) }));
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node: SyntaxNodeRef) => {
        const name = node.name;
        const blockClass = BLOCK_LINE[name];
        if (blockClass) styleLines(node.from, node.to, blockClass);
        const heading = HEADING.exec(name);
        if (heading) styleLines(node.from, node.to, `md-line-h${Math.min(Number(heading[1]), 3)}`);
        if (name === "Blockquote") callout(node);
        if (name === "HTMLTag") return void htmlTag(node);
        if (name === "Highlight") {
          const marks = node.node.getChildren("HighlightMark");
          if (marks.length >= 2) style(marks[0]!.to, marks[marks.length - 1]!.from, "md-highlight");
        }
        if (name === "FencedCode" || name === "CodeBlock" || name === "Frontmatter") return false;
        if (onActiveLine(node.from)) return;

        switch (name) {
          case "HeaderMark": {
            const parent = node.node.parent?.name ?? "";
            if (!parent.startsWith("ATX")) break;
            // Leading marks also take the space after them; closing marks (`## Title ##`) take the space before.
            const after = doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
            replace(node.from, node.to + after);
            break;
          }
          case "EmphasisMark":
          case "StrikethroughMark":
          case "HighlightMark":
          case "Escape":
            replace(node.from, name === "Escape" ? node.from + 1 : node.to);
            break;
          case "CodeMark":
            if (node.node.parent?.name === "InlineCode") replace(node.from, node.to);
            break;
          case "QuoteMark": {
            const after = doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
            replace(node.from, node.to + after);
            break;
          }
          case "LinkMark":
          case "URL":
          case "LinkTitle":
            if (node.node.parent?.name === "Link" && !inMarker(node.from)) replace(node.from, node.to);
            break;
          case "ListMark": {
            const item = node.node.parent;
            const task = item?.getChild("Task");
            if (task) replace(node.from, task.from);
            else if (item?.parent?.name === "BulletList") replace(node.from, node.to, Decoration.replace({ widget: new Bullet() }));
            break;
          }
          case "TaskMarker": {
            const checked = /x/i.test(doc.sliceString(node.from, node.to));
            const after = doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
            replace(node.from, node.to + after, Decoration.replace({ widget: new TaskBox(checked, node.from, ctx.strings.done) }));
            if (checked) styleLines(node.from, node.from, "md-line-done");
            break;
          }
          case "HorizontalRule":
            replace(node.from, node.to, Decoration.replace({ widget: new Rule() }));
            break;
          case "Wikilink": {
            const raw = doc.sliceString(node.from, node.to);
            const embed = raw.startsWith("!");
            const { target, fragment, label } = parseWikiInner(raw.slice(embed ? 3 : 2, -2));
            const shown = label ?? (fragment ? `${target}#${fragment}` : target);
            replace(node.from, node.to, Decoration.replace({ widget: new WikilinkChip(ctx, target, shown, embed, ctx.lookup().resolve(target)) }));
            return false;
          }
        }
        return;
      },
    });
  }
  return RangeSet.of(out, true);
}

/** Live preview as a view plugin. Decorations are rebuilt for the visible part of the document only. */
export function livePreview(ctx: EditorContext): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, ctx);
      }
      update(update: ViewUpdate) {
        const relinked = update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLinks)));
        if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || relinked || syntaxTree(update.startState) !== syntaxTree(update.state))
          this.decorations = build(update.view, ctx);
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [plugin, EditorView.contentAttributes.of({ "data-preview": "live" })];
}
