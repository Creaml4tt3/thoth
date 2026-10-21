/**
 * Editor extensions for the app: the schema from `@thoth/editor`, plus node
 * views, history, keymaps and a few Markdown input rules. The schema itself is
 * never changed here (it defines the round-trip guarantees).
 */
import { Extension, textblockTypeInputRule, wrappingInputRule, type AnyExtension, type NodeViewRenderer } from "@tiptap/core";
import { toggleMark } from "@tiptap/pm/commands";
import { history, redo, undo } from "@tiptap/pm/history";
import { thothExtensions } from "@thoth/editor";
import type { EditorContext } from "./context.ts";
import { calloutView, embedView, inlineRawView, preservedView, taskItemView, wikilinkView } from "./node-views.ts";

const Editing = Extension.create({
  name: "thothEditing",
  addProseMirrorPlugins: () => [history()],
  addKeyboardShortcuts() {
    const mark = (name: string) => () => toggleMark(this.editor.schema.marks[name]!)(this.editor.state, this.editor.view.dispatch);
    return {
      "Mod-z": () => undo(this.editor.state, this.editor.view.dispatch),
      "Mod-y": () => redo(this.editor.state, this.editor.view.dispatch),
      "Mod-Shift-z": () => redo(this.editor.state, this.editor.view.dispatch),
      "Mod-b": mark("bold"),
      "Mod-i": mark("italic"),
      "Mod-e": mark("inlineCode"),
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
    ];
  },
});

/** Replaces schema extensions by name with versions that have node views. */
export function createEditorExtensions(ctx: EditorContext): AnyExtension[] {
  const views: Record<string, NodeViewRenderer> = {
    callout: calloutView,
    html: preservedView,
    math: preservedView,
    raw: preservedView,
    inlineRaw: inlineRawView,
    wikilink: wikilinkView(ctx),
    embed: embedView(ctx),
    taskItem: taskItemView,
  };
  const base = thothExtensions().map((ext) => {
    const view = views[ext.name];
    return view ? ext.extend({ addNodeView: () => view }) : ext;
  });
  return [...base, Editing];
}
