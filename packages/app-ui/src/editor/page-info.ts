/**
 * The line under a page's title: when it was made and last edited, and by whom on a server. Blocks mode: a widget
 * after the first block when that is a level-1 heading (the title), else at the top. Not part of the text: never
 * saved, not editable, skipped by the caret. The page frame says what it reads (`ctx.pageInfo`) and redraws it
 * through `ctx.views`.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorContext, Refreshable } from "./context.ts";

const key = new PluginKey<number>("thothPageInfo");

export function pageInfoExtension(ctx: EditorContext) {
  return Extension.create({
    name: "thothPageInfo",
    addProseMirrorPlugins() {
      return [
        new Plugin<number>({
          key,
          // A counter: each redraw asked by the page frame makes new decorations.
          state: { init: () => 0, apply: (tr, n) => (tr.getMeta(key) ? n + 1 : n) },
          view(view) {
            const handle: Refreshable = { refresh: () => !view.isDestroyed && view.dispatch(view.state.tr.setMeta(key, true).setMeta("addToHistory", false)) };
            ctx.views.add(handle);
            return { destroy: () => void ctx.views.delete(handle) };
          },
          props: {
            decorations(state) {
              const text = ctx.pageInfo?.();
              if (!text) return null;
              const first = state.doc.firstChild;
              const at = first && first.type.name === "heading" && first.attrs["level"] === 1 ? first.nodeSize : 0;
              const n = key.getState(state) ?? 0;
              const widget = Decoration.widget(
                at,
                () => {
                  const line = document.createElement("p");
                  line.className = "page-info";
                  line.contentEditable = "false";
                  line.textContent = text;
                  return line;
                },
                { side: at === 0 ? -1 : 1, ignoreSelection: true, key: `page-info-${n}-${text}` },
              );
              return DecorationSet.create(state.doc, [widget]);
            },
          },
        }),
      ];
    },
  });
}
