/**
 * `[[` autocomplete for Plain mode. Typing `[[` opens the menu; the text after
 * it is the query. Picking a page replaces `[[query` with `[[Target]]` (keeping
 * a typed `#heading` or `|label`) as one ordinary, undoable text edit. Code,
 * inline code and frontmatter are left alone.
 */
import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { EditorContext } from "../context.ts";
import { createLinkMenu, type LinkMenu } from "../link-menu.ts";
import type { LinkSuggestion } from "../link-suggest.ts";

interface Trigger {
  /** Offset of the first `[`. */
  from: number;
  /** The caret. */
  to: number;
  query: string;
}

const NO_LINKS = new Set(["FencedCode", "CodeBlock", "InlineCode", "CodeText", "Frontmatter", "HTMLBlock", "CommentBlock"]);

export function findTrigger(state: EditorState): Trigger | null {
  const range = state.selection.main;
  if (!range.empty || state.selection.ranges.length > 1) return null;
  const line = state.doc.lineAt(range.head);
  const before = line.text.slice(0, range.head - line.from);
  const match = /(?:^|[^\\[])\[\[([^[\]]*)$/.exec(before);
  if (!match) return null;
  const query = match[1]!;
  const from = range.head - query.length - 2;
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(from, 1); node; node = node.parent) {
    if (NO_LINKS.has(node.name)) return null;
  }
  return { from, to: range.head, query };
}

/** The text that replaces `[[query`: the chosen target, any typed `#heading`/`|label`, and the closing `]]` unless it is already there. */
export function completion(state: EditorState, trigger: Trigger, item: LinkSuggestion): { from: number; to: number; insert: string; cursor: number } {
  const cut = trigger.query.search(/[#|]/);
  const suffix = cut < 0 ? "" : trigger.query.slice(cut);
  const closed = state.sliceDoc(trigger.to, trigger.to + 2) === "]]";
  const insert = `[[${item.target}${suffix}${closed ? "" : "]]"}`;
  return { from: trigger.from, to: trigger.to, insert, cursor: trigger.from + insert.length + (closed ? 2 : 0) };
}

const dismiss = StateEffect.define<number | null>();

/** Position of a `[[` the user dismissed with Escape; it stays dismissed while that `[[` exists. */
const dismissed = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(dismiss)) return effect.value;
    if (value === null) return null;
    const mapped = tr.changes.mapPos(value, 1);
    return tr.state.sliceDoc(mapped, mapped + 2) === "[[" ? mapped : null;
  },
});

export function plainLinkSuggest(ctx: EditorContext): Extension {
  let menu: LinkMenu | null = null;
  let current: Trigger | null = null;

  const pick = (view: EditorView, item: LinkSuggestion): boolean => {
    if (!current) return false;
    const { from, to, insert, cursor } = completion(view.state, current, item);
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: cursor }, userEvent: "input.complete", scrollIntoView: true });
    menu?.hide();
    current = null;
    view.focus();
    return true;
  };

  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        menu = createLinkMenu(view.contentDOM, (item) => pick(view, item), ctx.strings);
      }
      update(update: ViewUpdate) {
        if (!(update.docChanged || update.selectionSet || update.focusChanged || update.transactions.some((tr) => tr.effects.some((e) => e.is(dismiss))))) return;
        const view = update.view;
        current = view.hasFocus && !view.state.readOnly ? findTrigger(view.state) : null;
        if (!current || view.state.field(dismissed) === current.from) {
          current = null;
          menu?.hide();
          return;
        }
        const trigger = current;
        // Coordinates are only readable after the update cycle.
        view.requestMeasure({
          // The caret, or (when it has no layout yet) the top of the text, so a valid trigger always shows the menu.
          read: (v) => v.coordsAtPos(trigger.to) ?? v.contentDOM.getBoundingClientRect(),
          write: (caret) => {
            if (current !== trigger) return;
            menu?.show(ctx.suggester().suggest(trigger.query), trigger.query, new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top));
          },
        });
      }
      destroy() {
        menu?.destroy();
        menu = null;
        current = null;
      }
    },
  );

  const open = () => current !== null && menu?.isOpen() === true;
  return [
    dismissed,
    plugin,
    Prec.highest(
      keymap.of([
        { key: "ArrowDown", run: () => (open() ? (menu!.move(1), true) : false) },
        { key: "ArrowUp", run: () => (open() ? (menu!.move(-1), true) : false) },
        { key: "Enter", run: (view) => (open() && menu!.selected() ? pick(view, menu!.selected()!) : false) },
        { key: "Tab", run: (view) => (open() && menu!.selected() ? pick(view, menu!.selected()!) : false) },
        {
          key: "Escape",
          run: (view) => {
            if (!open() || !current) return false;
            view.dispatch({ effects: dismiss.of(current.from) });
            return true;
          },
        },
      ]),
    ),
    EditorView.domEventHandlers({ blur: () => void menu?.hide() }),
  ];
}
