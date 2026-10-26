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
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { filterBlockKinds, localizedBlockKinds, type BlockKindInfo } from "./block-kinds.ts";
import { applyAsOneStep, insertAfter, slashTarget, turnInto } from "./block-ops.ts";
import type { EditorContext } from "./context.ts";
import { canAddImages, pickAndInsertImage } from "./image-insert.ts";
import { createSuggestMenu, type SuggestMenu } from "./suggest-menu.ts";

/** `/` Image (ADR-0028): not a block type to convert to, but a file to add, so it is offered by the `/` menu only. */
export type ImageItem = Omit<BlockKindInfo, "kind"> & { kind: "image" };
export type SlashItem = BlockKindInfo | ImageItem;

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

/** Deletes `/query` (and the space that opened the menu at the end of a line); returns where it was. */
function removeTrigger(tr: Transaction, trigger: SlashTrigger): number {
  // `text /toggle`: the space that opened the menu would be left dangling at the end of the line (and saved as `&#x20;`).
  const $from = tr.doc.resolve(trigger.from);
  const lead = $from.parentOffset > 0 && trigger.to === $from.end() && /[ \t]/.test($from.parent.textBetween($from.parentOffset - 1, $from.parentOffset)) ? 1 : 0;
  tr.delete(trigger.from - lead, trigger.to);
  return trigger.from - lead;
}

/** `/` Image: removes `/query` (one undo step), then asks for a file and puts its image there (another). */
export function pickImageItem(view: EditorView, trigger: SlashTrigger, ctx: EditorContext): void {
  let at = trigger.from;
  applyAsOneStep(view, (tr) => {
    at = removeTrigger(tr, trigger);
    return true;
  });
  void pickAndInsertImage(view, ctx, at);
}

/** Replaces `/query` with the block: converts an empty block, otherwise inserts after it. One undo step. */
export function pickBlock(view: EditorView, trigger: SlashTrigger, info: BlockKindInfo): void {
  applyAsOneStep(view, (tr) => {
    const lead = trigger.from - removeTrigger(tr, trigger);
    const $at = tr.doc.resolve(trigger.from - lead);
    const target = slashTarget($at);
    // Picking the block's own type just removes the `/query`.
    if ($at.parent.content.size === 0) turnInto(tr, target, info.kind);
    else insertAfter(tr, target, info.kind);
    return true;
  });
}

export function slashExtension(ctx: EditorContext) {
  const strings = ctx.strings;
  const kinds = localizedBlockKinds(strings.blocks);
  const image: ImageItem = {
    kind: "image",
    title: strings.image.slash.title,
    description: strings.image.slash.description,
    aliases: ["image", "picture", "photo", "img", "png", "jpg", "svg", "gif", "file", "upload"],
    icon: "▣",
  };
  return Extension.create({
    name: "thothSlashMenu",
    addProseMirrorPlugins() {
      let menu: SuggestMenu<SlashItem> | null = null;
      let current: SlashTrigger | null = null;
      let editorView: EditorView | null = null;

      const pick = (info: SlashItem) => {
        if (!editorView || !current) return;
        const trigger = current;
        menu?.hide();
        current = null;
        editorView.focus();
        if (info.kind === "image") pickImageItem(editorView, trigger, ctx);
        else pickBlock(editorView, trigger, info);
      };
      /** The catalog, plus Image where the page can take files and there is a picker. */
      const items = (view: EditorView): readonly SlashItem[] => (ctx.pickImage && canAddImages(view, ctx) ? [...kinds, image] : kinds);

      const refresh = (view: EditorView) => {
        const dismissedAt = key.getState(view.state)?.dismissedAt ?? null;
        current = view.editable && view.hasFocus() ? findSlashTrigger(view.state) : null;
        const found = current ? filterBlockKinds<SlashItem>(current.query, items(view)) : [];
        // Nothing matches: close, so Enter and spaces behave as plain typing.
        if (!current || found.length === 0 || dismissedAt === current.from) {
          current = null;
          menu?.hide();
          return;
        }
        const caret = view.coordsAtPos(current.to);
        menu?.show(found, current.query, new DOMRect(caret.left, caret.top, 0, caret.bottom - caret.top));
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
            menu = createSuggestMenu<SlashItem>(view.dom, {
              prefix: "slash",
              label: strings.insertBlock,
              width: 300,
              render: (info) => ({ title: info.title, meta: info.description, icon: info.icon }),
              empty: () => strings.noMatchingBlocks,
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
