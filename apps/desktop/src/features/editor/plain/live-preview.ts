/**
 * Live preview for Plain mode (Obsidian-style): Markdown markup is hidden on
 * lines the cursor is not on, wikilinks become chips and task markers become
 * checkboxes. It is display only. The document is never rewritten to show it,
 * and the line being edited always shows its exact source.
 */
import { RangeSet, StateEffect, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNodeRef } from "@lezer/common";
import { parseWikiInner } from "@thoth/editor";
import type { EditorContext } from "../context.ts";
import type { LinkTarget } from "../links.ts";

/** Dispatched when the link index changes, so chips re-resolve. */
export const refreshLinks = StateEffect.define<null>();

const hide = Decoration.replace({});
const line = (cls: string) => Decoration.line({ class: cls });

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
    chip.textContent = this.embed ? `Embed · ${this.label}` : this.label;
    chip.setAttribute("role", "link");
    chip.title = this.result.state === "resolved" ? this.result.path : this.result.state === "ambiguous" ? `Ambiguous: ${this.result.candidates.join(", ")}` : `No page named "${this.target}" yet`;
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
  constructor(checked: boolean, at: number) {
    super();
    this.checked = checked;
    this.at = at;
  }
  override eq(other: TaskBox): boolean {
    return other.checked === this.checked && other.at === this.at;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "task-box";
    box.checked = this.checked;
    box.setAttribute("aria-label", "Done");
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

const HEADING = /^(?:ATX|Setext)Heading([1-6])$/;
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
  const styleLines = (from: number, end: number, cls: string) => {
    // A node that ends at the start of a line (frontmatter ends after its closing fence's line break) does not cover that line.
    const to = end > from && doc.lineAt(end).from === end ? end - 1 : end;
    for (let pos = from; pos <= to; ) {
      const l = doc.lineAt(pos);
      const key = `${l.from}:${cls}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(line(cls).range(l.from));
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
            if (node.node.parent?.name === "Link") replace(node.from, node.to);
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
            replace(node.from, node.to + after, Decoration.replace({ widget: new TaskBox(checked, node.from) }));
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
