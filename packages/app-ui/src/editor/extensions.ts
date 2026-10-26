/**
 * Editor extensions for the app: the schema from `@thoth/editor`, plus node
 * views, history, keymaps, Markdown input rules, the `/` menu, the block
 * handle and the text style toolbar and shortcuts. The schema itself is
 * never changed here (it defines the round-trip guarantees).
 */
import { Extension, InputRule, textblockTypeInputRule, wrappingInputRule, type AnyExtension, type NodeViewRenderer } from "@tiptap/core";
import { history, redo, undo } from "@tiptap/pm/history";
import { thothExtensions } from "@thoth/editor";
import type { EditorContext } from "./context.ts";
import { calloutView, embedView, inlineRawView, preservedView, taskItemView, wikilinkView } from "./node-views.ts";
import { imageView } from "./image-views.ts";
import { imageInsertExtension } from "./image-insert.ts";
import { linkSuggestExtension } from "./link-suggest-blocks.ts";
import { slashExtension } from "./slash-menu.ts";
import { blockHandleExtension } from "./block-handle.ts";
import { textStylesExtension } from "./selection-toolbar.ts";
import { calloutKeysExtension } from "./callout-keys.ts";
import { listKeysExtension } from "./list-keys.ts";
import { pasteLinksExtension } from "./paste-links.ts";
import { linkCardsExtension } from "./link-cards.ts";
import { slashTarget, turnInto } from "./block-ops.ts";
import type { BlockKind } from "./block-kinds.ts";

/** Converts the text block around the match into `kind` when the typed text was all the block held. */
const blockRule = (find: RegExp, kind: BlockKind) =>
  new InputRule({
    find,
    handler: ({ state, range }) => {
      const { tr } = state;
      const $from = tr.doc.resolve(range.from);
      if (!$from.parent.isTextblock || $from.parent.type.name !== "paragraph") return null;
      tr.delete(range.from, range.to);
      const $at = tr.doc.resolve(range.from);
      if ($at.parent.content.size !== 0 || !turnInto(tr, slashTarget($at), kind)) return null;
    },
  });

const Editing = Extension.create({
  name: "thothEditing",
  addProseMirrorPlugins: () => [history()],
  addKeyboardShortcuts() {
    return {
      "Mod-z": () => undo(this.editor.state, this.editor.view.dispatch),
      "Mod-y": () => redo(this.editor.state, this.editor.view.dispatch),
      "Mod-Shift-z": () => redo(this.editor.state, this.editor.view.dispatch),
      "Shift-Enter": () => this.editor.commands.insertContent({ type: "hardBreak" }),
    };
  },
  addInputRules() {
    const { nodes } = this.editor.schema;
    return [
      textblockTypeInputRule({ find: /^(#{1,6})\s$/, type: nodes["heading"]!, getAttributes: (match) => ({ level: match[1]!.length }) }),
      wrappingInputRule({ find: /^\s*[-*+]\s$/, type: nodes["list"]!, getAttributes: { ordered: false, tight: true } }),
      wrappingInputRule({ find: /^(\d+)\.\s$/, type: nodes["list"]!, getAttributes: (match) => ({ ordered: true, start: Number(match[1]), tight: true }) }),
      wrappingInputRule({ find: /^\s*>\s$/, type: nodes["blockquote"]! }),
      textblockTypeInputRule({ find: /^```([a-z0-9+-]*)\s$/, type: nodes["code"]!, getAttributes: (match) => ({ lang: match[1] || null }) }),
      // `> ` stays a quote; `>> ` is a toggle (the second `>` is typed before the space, so the quote rule never fires).
      blockRule(/^>>\s$/, "toggle"),
      blockRule(/^\[\s?\]\s$/, "todo"),
      blockRule(/^---$/, "divider"),
    ];
  },
});

/** Replaces schema extensions by name with versions that have node views. */
export function createEditorExtensions(ctx: EditorContext): AnyExtension[] {
  const views: Record<string, NodeViewRenderer> = {
    callout: calloutView(ctx),
    html: preservedView(ctx),
    math: preservedView(ctx),
    raw: preservedView(ctx),
    inlineRaw: inlineRawView(ctx),
    wikilink: wikilinkView(ctx),
    embed: embedView(ctx),
    taskItem: taskItemView(ctx),
    image: imageView(ctx, false),
    inlineImage: imageView(ctx, true),
  };
  const base = thothExtensions().map((ext) => {
    const view = views[ext.name];
    return view ? ext.extend({ addNodeView: () => view }) : ext;
  });
  const links = ctx.links;
  return [
    ...base,
    Editing,
    calloutKeysExtension(),
    listKeysExtension(),
    slashExtension(ctx),
    blockHandleExtension(ctx.strings),
    textStylesExtension(ctx.strings, ctx.client),
    linkSuggestExtension(ctx),
    imageInsertExtension(ctx),
    pasteLinksExtension(ctx),
    ...(links ? [linkCardsExtension({ ...ctx, links })] : []),
  ];
}
