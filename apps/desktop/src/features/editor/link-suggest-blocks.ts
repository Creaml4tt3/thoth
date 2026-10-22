/**
 * `[[` autocomplete for Blocks mode. Typing `[[` opens the menu; the text
 * typed after it is the query. Enter or Tab (or a click) replaces `[[query`
 * with a wikilink node. Typing `]]` instead turns `[[query]]` into a wikilink
 * node too, so a link typed by hand is a real link and not escaped text.
 * Code blocks and inline code are left alone.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { parseWikiInner } from "@thoth/editor";
import type { EditorContext } from "./context.ts";
import { createLinkMenu, type LinkMenu } from "./link-menu.ts";
import type { LinkSuggestion } from "./link-suggest.ts";

interface Trigger {
  /** Document position of the first `[`. */
  from: number;
  /** The caret. */
  to: number;
  query: string;
}

const key = new PluginKey<{ dismissedAt: number | null }>("thothLinkSuggest");

/** `[[query` directly before an empty selection, in a non-code textblock, with no `]`, `[` or newline in the query. */
export function findTrigger(state: EditorState): Trigger | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$from;
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return null;
  if (state.schema.marks["inlineCode"]?.isInSet($pos.marks())) return null;
  // Text before the caret in this block; atoms count as one placeholder character.
  const before = $pos.parent.textBetween(0, $pos.parentOffset, undefined, "\uFFFC");
  const match = /(?:^|[^\\[])\[\[([^[\]\n\uFFFC]*)$/.exec(before);
  if (!match) return null;
  const query = match[1]!;
  const from = $pos.pos - query.length - 2;
  return { from, to: $pos.pos, query };
}

function insertLink(view: EditorView, trigger: Trigger, item: LinkSuggestion, typed: string): void {
  const { fragment, label } = parseWikiInner(typed.includes("#") || typed.includes("|") ? `${item.target}${typed.slice(typed.search(/[#|]/))}` : item.target);
  const node = view.state.schema.nodes["wikilink"]!.create({ target: item.target, fragment, label });
  view.dispatch(view.state.tr.replaceWith(trigger.from, trigger.to, node).scrollIntoView());
}

export function linkSuggestExtension(ctx: EditorContext) {
  return Extension.create({
    name: "thothLinkSuggest",
    addProseMirrorPlugins() {
      let menu: LinkMenu | null = null;
      let current: Trigger | null = null;
      let editorView: EditorView | null = null;

      const pick = (item: LinkSuggestion) => {
        if (!editorView || !current) return;
        insertLink(editorView, current, item, current.query);
        menu?.hide();
        editorView.focus();
      };

      const refresh = (view: EditorView) => {
        const dismissedAt = key.getState(view.state)?.dismissedAt ?? null;
        current = view.editable && view.hasFocus() ? findTrigger(view.state) : null;
        if (!current || dismissedAt === current.from) {
          current = null;
          menu?.hide();
          return;
        }
        const caret = view.coordsAtPos(current.to);
        const rect = new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top);
        menu?.show(ctx.suggester().suggest(current.query), current.query, rect);
      };

      return [
        new Plugin<{ dismissedAt: number | null }>({
          key,
          state: {
            init: () => ({ dismissedAt: null }),
            apply(tr, value) {
              const meta = tr.getMeta(key) as { dismissedAt: number | null } | undefined;
              if (meta) return meta;
              if (value.dismissedAt === null) return value;
              // Escape dismisses this `[[`; it stays dismissed until the trigger itself is gone.
              const mapped = tr.mapping.map(value.dismissedAt);
              const text = tr.doc.textBetween(mapped, Math.min(mapped + 2, tr.doc.content.size), undefined, "\uFFFC");
              return { dismissedAt: text === "[[" ? mapped : null };
            },
          },
          view(view) {
            editorView = view;
            menu = createLinkMenu(view.dom, pick);
            return {
              update: (v) => refresh(v),
              destroy: () => {
                menu?.destroy();
                menu = null;
                editorView = null;
              },
            };
          },
          props: {
            handleKeyDown(view, event) {
              if (!current || !menu?.isOpen()) return false;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                menu.move(event.key === "ArrowDown" ? 1 : -1);
                return true;
              }
              if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                const item = menu.selected();
                if (!item) return false;
                pick(item);
                return true;
              }
              if (event.key === "Escape") {
                view.dispatch(view.state.tr.setMeta(key, { dismissedAt: current.from }));
                menu.hide();
                return true;
              }
              return false;
            },
            handleTextInput(view, from, to, text) {
              // The second `]` typed by hand closes the link: `[[Target]]` becomes a wikilink node, not escaped text.
              if (text !== "]" || from !== to) return false;
              const $pos = view.state.doc.resolve(from);
              if (!$pos.parent.isTextblock || $pos.parent.type.spec.code || view.state.schema.marks["inlineCode"]?.isInSet($pos.marks())) return false;
              const before = $pos.parent.textBetween(0, $pos.parentOffset, undefined, "\uFFFC");
              const closed = /(?:^|[^\\[])\[\[([^[\]\n\uFFFC]+)\]$/.exec(before);
              if (!closed) return false;
              const inner = closed[1]!;
              const start = from - inner.length - 3;
              const attrs = parseWikiInner(inner);
              if (attrs.target === "" && attrs.fragment === null) return false;
              view.dispatch(view.state.tr.replaceWith(start, to, view.state.schema.nodes["wikilink"]!.create(attrs)));
              return true;
            },
            handleDOMEvents: {
              blur: () => {
                menu?.hide();
                return false;
              },
            },
          },
        }),
      ];
    },
  });
}
