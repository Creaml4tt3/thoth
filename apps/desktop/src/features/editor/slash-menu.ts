/**
 * `/` block menu for Blocks mode. Typing `/` at the start of a text block, or
 * after a space, opens a menu of block types that filters as you type. Arrow
 * keys move, Enter or Tab (or a click) pick, Escape dismisses. Picking replaces
 * the `/query` text: an empty block is converted, otherwise the new block is
 * inserted after it, and the caret goes inside. The whole pick is one undo step.
 *
 * No trigger in code blocks, inline code, callout titles, or inside a word
 * (`a/b`, URLs).
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { filterBlockKinds, type BlockKindInfo } from "./block-kinds.ts";
import { applyAsOneStep, insertAfter, slashTarget, turnInto } from "./block-ops.ts";
import { createSuggestMenu, type SuggestMenu } from "./suggest-menu.ts";

export interface SlashTrigger {
  /** Document position of the `/`. */
  from: number;
  /** The caret. */
  to: number;
  query: string;
}

const key = new PluginKey<{ dismissedAt: number | null }>("thothSlashMenu");

const leafText = (leaf: { type: { name: string } }) => (leaf.type.name === "hardBreak" ? "\n" : "￼");

/** `/query` directly before an empty selection, after a space or at the start of a non-code textblock. */
export function findSlashTrigger(state: EditorState): SlashTrigger | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$from;
  const parent = $pos.parent;
  if (!parent.isTextblock || parent.type.spec.code || parent.type.name === "calloutTitle") return null;
  if (state.schema.marks["inlineCode"]?.isInSet($pos.marks())) return null;
  const before = parent.textBetween(0, $pos.parentOffset, undefined, leafText);
  const match = /(?:^|[ \t\n])\/([^/\n￼]{0,30})$/.exec(before);
  if (!match) return null;
  const query = match[1]!;
  return { from: $pos.pos - query.length - 1, to: $pos.pos, query };
}

/** Replaces `/query` with the block: converts an empty block, otherwise inserts after it. One undo step. */
export function pickBlock(view: EditorView, trigger: SlashTrigger, info: BlockKindInfo): void {
  applyAsOneStep(view, (tr) => {
    // `text /toggle`: the space that opened the menu would be left dangling at the end of the line (and saved as `&#x20;`).
    const $from = tr.doc.resolve(trigger.from);
    const lead = $from.parentOffset > 0 && trigger.to === $from.end() && /[ \t]/.test($from.parent.textBetween($from.parentOffset - 1, $from.parentOffset)) ? 1 : 0;
    tr.delete(trigger.from - lead, trigger.to);
    const $at = tr.doc.resolve(trigger.from - lead);
    const target = slashTarget($at);
    // Picking the block's own type just removes the `/query`.
    if ($at.parent.content.size === 0) turnInto(tr, target, info.kind);
    else insertAfter(tr, target, info.kind);
    return true;
  });
}

export function slashExtension() {
  return Extension.create({
    name: "thothSlashMenu",
    addProseMirrorPlugins() {
      let menu: SuggestMenu<BlockKindInfo> | null = null;
      let current: SlashTrigger | null = null;
      let editorView: EditorView | null = null;

      const pick = (info: BlockKindInfo) => {
        if (!editorView || !current) return;
        const trigger = current;
        menu?.hide();
        current = null;
        pickBlock(editorView, trigger, info);
        editorView.focus();
      };

      const refresh = (view: EditorView) => {
        const dismissedAt = key.getState(view.state)?.dismissedAt ?? null;
        current = view.editable && view.hasFocus() ? findSlashTrigger(view.state) : null;
        const items = current ? filterBlockKinds(current.query) : [];
        // Nothing matches: close, so Enter and spaces behave as plain typing.
        if (!current || items.length === 0 || dismissedAt === current.from) {
          current = null;
          menu?.hide();
          return;
        }
        const caret = view.coordsAtPos(current.to);
        menu?.show(items, current.query, new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top));
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
              // Escape dismisses this `/`; it stays dismissed until the slash itself is gone.
              const mapped = tr.mapping.map(value.dismissedAt);
              return { dismissedAt: tr.doc.textBetween(mapped, Math.min(mapped + 1, tr.doc.content.size), undefined, "￼") === "/" ? mapped : null };
            },
          },
          view(view) {
            editorView = view;
            menu = createSuggestMenu<BlockKindInfo>(view.dom, {
              prefix: "slash",
              label: "Insert block",
              width: 300,
              render: (info) => ({ title: info.title, meta: info.description, icon: info.icon }),
              empty: () => "No matching blocks",
              onPick: pick,
            });
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
                event.preventDefault();
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
