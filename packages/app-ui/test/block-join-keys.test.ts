// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc } from "@thoth/editor";
import { createEditorContext } from "../src/editor/context.ts";
import { createEditorExtensions } from "../src/editor/extensions.ts";
import { deleteBeforeParagraph } from "../src/editor/block-join-keys.ts";

const ctx = createEditorContext({ lookup: () => ({}) as never, suggester: () => ({}) as never, openPage: () => {} } as never);
let editor: Editor;
afterEach(() => editor?.destroy());

/** An editor holding `md`, then `after` as the last paragraph (empty when ""), with the caret at its start. */
function below(md: string, after: string): Editor {
  editor = new Editor({ element: document.createElement("div"), extensions: createEditorExtensions(ctx), content: markdownToDoc(md).doc });
  editor.commands.insertContentAt(editor.state.doc.content.size, after ? { type: "paragraph", content: [{ type: "text", text: after }] } : { type: "paragraph" });
  editor.commands.setTextSelection(editor.state.doc.content.size - editor.state.doc.lastChild!.nodeSize + 1);
  return editor;
}
const md = () => docToMarkdown(editor.getJSON());
// A real keydown: Tiptap's `keyboardShortcut` command keeps a handler's steps but not the selection it sets.
const press = (key: string) => editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key }))) === true;
const caretText = () => editor.state.selection.$from.parent.textContent.slice(0, editor.state.selection.$from.parentOffset);

describe("Backspace at the start of the paragraph after a block", () => {
  it.each([
    ["bulleted", "- a\n- b\n", "- a\n- b\n"],
    ["numbered", "1. a\n2. b\n", "1. a\n2. b\n"],
    ["to-do", "- [ ] a\n- [ ] b\n", "- [ ] a\n- [ ] b\n"],
    ["nested", "- a\n  - b\n", "- a\n  - b\n"],
    ["quote", "> a\n", "> a\n"],
    ["callout", "> [!note] T\n> body\n", "> [!note] T\n> body\n"],
  ])("an empty line after a %s block goes away; the caret ends its last line", (_, source, out) => {
    below(source, "");
    expect(press("Backspace")).toBe(true);
    expect(md()).toBe(out);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.selection.$from.parentOffset).toBe(editor.state.selection.$from.parent.content.size);
  });

  it.each([
    ["list", "1. a\n2. b\n", "1. a\n2. bafter\n"],
    ["to-do", "- [ ] a\n- [x] b\n", "- [ ] a\n- [x] bafter\n"],
    ["quote", "> a\n", "> aafter\n"],
    ["callout", "> [!note] T\n> body\n", "> [!note] T\n> bodyafter\n"],
  ])("a line with text joins the last line of a %s, caret at the join", (_, source, out) => {
    below(source, "after");
    press("Backspace");
    expect(md()).toBe(out);
    expect(caretText()).toMatch(/(b|a|body)$/);
    expect(editor.state.selection.$from.parent.textContent.endsWith("after")).toBe(true);
  });

  it("joins a folded callout's title, not its hidden body", () => {
    below("> [!note]- T\n> body\n", "after");
    press("Backspace");
    expect(md()).toBe("> [!note]- Tafter\n> body\n");
  });

  it.each([
    ["picture", "![alt](x.png)\n"],
    ["divider", "---\n"],
    ["formula", "$$x$$\n"],
  ])("selects a %s first instead of deleting it", (_, source) => {
    below(source, "after");
    press("Backspace");
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(md()).toBe(`${source}\nafter\n`);
    press("Backspace");
    expect(md()).toBe("after\n");
  });

  it("an empty line after a picture goes away and selects the picture", () => {
    below("![alt](x.png)\n", "");
    press("Backspace");
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
  });

  it("leaves joins between paragraphs, headings and code to the editor", () => {
    below("# H\n", "after");
    press("Backspace");
    expect(md()).toBe("# Hafter\n");
  });

  it("Backspace inside a list item still turns the first item into text", () => {
    editor = new Editor({ element: document.createElement("div"), extensions: createEditorExtensions(ctx), content: markdownToDoc("- a\n").doc });
    editor.commands.setTextSelection(3);
    press("Backspace");
    expect(md()).toBe("a\n");
  });
});

describe("Delete at the end of a list, quote or callout", () => {
  const atEndOfFirst = () => {
    let end = 0;
    editor.state.doc.firstChild!.descendants((n, pos) => {
      if (n.isTextblock) end = pos + 1 + 1 + n.content.size;
    });
    editor.commands.setTextSelection(end);
  };

  it.each([
    ["list", "- a\n- b\n", "", "- a\n- b\n"],
    ["list", "- a\n- b\n", "after", "- a\n- bafter\n"],
    ["quote", "> a\n", "after", "> aafter\n"],
  ])("pulls in the next paragraph (%s, %j)", (_, source, after, out) => {
    below(source, after);
    atEndOfFirst();
    expect(press("Delete")).toBe(true);
    expect(md()).toBe(out);
    expect(editor.state.doc.childCount).toBe(1);
  });

  it("leaves Delete in an item that is not the last to the editor", () => {
    below("- a\n- b\n", "after");
    editor.commands.setTextSelection(4);
    expect(deleteBeforeParagraph(editor.state)).toBeNull();
  });
});
