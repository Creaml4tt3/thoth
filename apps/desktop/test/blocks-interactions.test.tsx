// @vitest-environment jsdom
/**
 * Notion-style block interactions in Blocks mode, end to end through the app:
 * the `/` menu, the block menu and keyboard moves, toggles, and callout titles.
 * Every scenario ends in what is saved on disk, and guards that untouched
 * neighbours keep their exact bytes.
 *
 * jsdom has no layout, drag events or text input, so typing goes through
 * ProseMirror's `handleTextInput` (what a keypress does) and keys through
 * user-event; real mouse and drag run in the Playwright scenario.
 */
import { EditorView as CodeMirrorView } from "@codemirror/view";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import { undo, redo } from "@tiptap/pm/history";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, editorBox, openApp, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";
import { guardWrites } from "./support/write-guard.ts";
import { setDefaultEditorMode } from "@thoth/app-ui/editor/mode.ts";
import { filterBlockKinds } from "@thoth/app-ui/editor/block-kinds.ts";

const dirs = tempDirs();
let root: string;

const PAGE = `# Blocks

First paragraph.

* odd bullet one
* odd bullet two

Second paragraph with __emphasis__ kept.

> [!toggle]- Folded   title
> hidden body

> [!note]+ Open note
> note body

\`\`\`js
const  spaced   =  1;
\`\`\`

Last paragraph   
`;

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Page.md": PAGE });
});
afterEach(async () => {
  vi.restoreAllMocks();
  setDefaultEditorMode("blocks");
  localStorage.clear();
  cleanup();
  await dirs.cleanup();
});

type Box = HTMLElement & { editor?: Editor };
const editorOf = (box: HTMLElement): Editor => (box as Box).editor!;

async function openPage(file = "Page.md", name = "Page") {
  const guard = guardWrites();
  const app = await openApp(root);
  await app.user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name }));
  const box = await editorBox();
  await waitFor(() => expect(box.textContent).not.toBe(""));
  const editor = editorOf(box);
  const save = async () => {
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(() => expect(editor.view.dom.isConnected).toBe(true));
  };
  const saved = async (expected: string) => {
    await save();
    await waitFor(async () => expect(await app.read(file)).toBe(expected));
  };
  return { app, box, editor, guard, save, saved };
}

/** Document position at the end of the text block whose text is `text`. */
function endOf(editor: Editor, text: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1 + node.content.size;
  });
  if (found < 0) throw new Error(`No text block "${text}"`);
  return found;
}

function caretAt(editor: Editor, pos: number): void {
  editor.view.focus();
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
}

/** Types the way a keypress does: handleTextInput props first, plain insertion otherwise. */
function type(editor: Editor, text: string): void {
  const { view } = editor;
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

/** The open menu; `queryByRole` skips hidden elements, so a closed menu is null. */
const slashMenu = () => screen.queryByRole("listbox", { name: "Insert block" });
const slashOpen = () => slashMenu() !== null;
const slashOptions = () => within(slashMenu()!).getAllByRole("option").map((o) => o.querySelector(".slash-option-title")!.textContent);
const blockMenu = () => screen.queryByRole("menu", { name: "Block menu" });
const menuOpen = () => blockMenu() !== null;

/** An empty paragraph after `text`, as typing Enter at its end makes it. */
async function newLineAfter(ctx: Awaited<ReturnType<typeof openPage>>, text: string) {
  caretAt(ctx.editor, endOf(ctx.editor, text));
  await ctx.app.user.keyboard("{Enter}");
}

const KEY = {
  moveUp: "{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}",
  moveDown: "{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}",
  menu: "{Control>}{Alt>}m{/Alt}{/Control}",
};

describe("the block catalog", () => {
  it("finds items by title, alias and description", () => {
    expect(filterBlockKinds("").map((k) => k.title)).toEqual(["Text", "Heading 1", "Heading 2", "Heading 3", "Bulleted list", "Numbered list", "To-do list", "Toggle", "Callout", "Quote", "Code", "Divider"]);
    const first = (q: string) => filterBlockKinds(q)[0]?.title;
    expect(first("h1")).toBe("Heading 1");
    expect(first("todo")).toBe("To-do list");
    expect(first("check")).toBe("To-do list");
    expect(first("bullet")).toBe("Bulleted list");
    expect(first("ul")).toBe("Bulleted list");
    expect(first("ol")).toBe("Numbered list");
    expect(first("hr")).toBe("Divider");
    expect(first("fold")).toBe("Toggle");
    expect(filterBlockKinds("zzz")).toEqual([]);
  });
});

describe("/ menu", () => {
  it("opens at the start of an empty block, filters, and Escape dismisses it without changing text", async () => {
    const ctx = await openPage();
    await newLineAfter(ctx, "First paragraph.");
    type(ctx.editor, "/");
    await waitFor(() => expect(slashOpen()).toBe(true));
    // The 12 block types, and Image (ADR-0028): this page's space takes files and the host has a picker.
    expect(slashOptions()).toHaveLength(13);
    expect(slashOptions().at(-1)).toBe("Image");
    expect(ctx.box.getAttribute("aria-controls")).toBe(slashMenu()!.id);
    type(ctx.editor, "head");
    expect(slashOptions()).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
    await ctx.app.user.keyboard("{ArrowDown}");
    expect(within(slashMenu()!).getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    expect(ctx.box.getAttribute("aria-activedescendant")).toBe(within(slashMenu()!).getAllByRole("option")[1]!.id);
    await ctx.app.user.keyboard("{Escape}");
    await waitFor(() => expect(slashOpen()).toBe(false));
    expect(ctx.editor.state.doc.textContent).toContain("/head");
    type(ctx.editor, "x");
    expect(slashOpen()).toBe(false); // stays dismissed for this slash
  });

  it("also opens after a space, and closes when nothing matches", async () => {
    const ctx = await openPage();
    caretAt(ctx.editor, endOf(ctx.editor, "First paragraph."));
    type(ctx.editor, " /");
    await waitFor(() => expect(slashOpen()).toBe(true));
    type(ctx.editor, "zzz");
    await waitFor(() => expect(slashOpen()).toBe(false));
  });

  it.each([
    ["in the middle of a word", "a/", "First paragraph."],
    ["in a URL", "see https:/", "First paragraph."],
    ["in a code block", "/", "const  spaced   =  1;"],
    ["in a callout title", "/", "Open note"],
  ])("does not open %s", async (_name, typed, anchor) => {
    const ctx = await openPage();
    caretAt(ctx.editor, endOf(ctx.editor, anchor));
    type(ctx.editor, typed);
    await new Promise((r) => setTimeout(r, 20));
    expect(slashOpen()).toBe(false);
  });

  it("does not open in inline code", async () => {
    await seed(root, { "Code.md": "Use `ls` here\n" });
    const ctx = await openPage("Code.md", "Code");
    caretAt(ctx.editor, endOf(ctx.editor, "Use ls here") - " here".length);
    type(ctx.editor, "/");
    await new Promise((r) => setTimeout(r, 20));
    expect(slashOpen()).toBe(false);
  });

  const CASES: [string, string, string][] = [
    ["Text", "text", "\n\n"],
    ["Heading 1", "h1", "# "],
    ["Heading 2", "h2", "## "],
    ["Heading 3", "h3", "### "],
    ["Bulleted list", "bullet", "- "],
    ["Numbered list", "numbered", "1. "],
    ["To-do list", "todo", "- [ ] "],
    ["Toggle", "toggle", "> [!toggle]+"],
    ["Callout", "callout", "> [!note]\n>"],
    ["Quote", "quote", ">"],
    ["Code", "code", "```\n```"],
    ["Divider", "divider", "***"],
  ];

  it.each(CASES)("%s: converts the empty block, puts the caret inside, saves the Markdown and keeps the neighbours byte-identical", async (title, query, md) => {
    const ctx = await openPage();
    await newLineAfter(ctx, "First paragraph.");
    type(ctx.editor, `/${query === "text" ? "text" : query}`);
    await waitFor(() => expect(slashOpen()).toBe(true));
    expect(slashOptions()[0]).toBe(title);
    await ctx.app.user.keyboard("{Enter}");
    await waitFor(() => expect(slashOpen()).toBe(false));
    expect(ctx.editor.state.doc.textContent).not.toContain("/");
    // the caret is inside the new block: typing lands there (a divider's caret is the empty block after it)
    type(ctx.editor, "X");
    await ctx.save();
    await waitFor(async () => {
      const saved = await ctx.app.read("Page.md");
      expect(saved.startsWith("# Blocks\n\nFirst paragraph.\n\n")).toBe(true);
      expect(saved.endsWith("\n\n* odd bullet one\n* odd bullet two\n\nSecond paragraph with __emphasis__ kept.\n\n> [!toggle]- Folded   title\n> hidden body\n\n> [!note]+ Open note\n> note body\n\n```js\nconst  spaced   =  1;\n```\n\nLast paragraph   \n")).toBe(true);
      const middle = saved.slice("# Blocks\n\nFirst paragraph.\n\n".length, saved.indexOf("\n\n* odd bullet one"));
      expect(middle.includes("X"), `${title}: ${JSON.stringify(middle)}`).toBe(true);
      if (md !== "\n\n") expect(middle.startsWith(md.replace(/\n$/, "")) || middle.includes(md.split("\n")[0]!), `${title}: ${JSON.stringify(middle)}`).toBe(true);
    });
  });

  it("a click on an item picks it", async () => {
    const ctx = await openPage();
    await newLineAfter(ctx, "First paragraph.");
    type(ctx.editor, "/");
    await waitFor(() => expect(slashOpen()).toBe(true));
    const option = within(slashMenu()!).getAllByRole("option").find((o) => o.querySelector(".slash-option-title")!.textContent === "Heading 2")!;
    option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(ctx.editor.state.doc.child(2).type.name).toBe("heading");
    expect(ctx.editor.state.doc.child(2).attrs["level"]).toBe(2);
  });

  it("inserts after a block that has text, instead of converting it", async () => {
    const ctx = await openPage();
    caretAt(ctx.editor, endOf(ctx.editor, "First paragraph."));
    type(ctx.editor, " /toggle");
    await waitFor(() => expect(slashOpen()).toBe(true));
    await ctx.app.user.keyboard("{Tab}");
    type(ctx.editor, "Title");
    await ctx.saved(PAGE.replace("First paragraph.\n\n", "First paragraph.\n\n> [!toggle]+ Title\n\n"));
  });

  it("is one undo step: one undo takes the block back and restores the typed /query, one redo reapplies it", async () => {
    const ctx = await openPage();
    await newLineAfter(ctx, "First paragraph.");
    type(ctx.editor, "/h2");
    await ctx.app.user.keyboard("{Enter}");
    expect(ctx.editor.state.doc.child(2).type.name).toBe("heading");
    expect(ctx.editor.state.doc.child(2).textContent).toBe("");
    expect(undo(ctx.editor.state, ctx.editor.view.dispatch)).toBe(true);
    expect(ctx.editor.state.doc.child(2).type.name).toBe("paragraph");
    expect(ctx.editor.state.doc.child(2).textContent).toBe("/h2");
    expect(redo(ctx.editor.state, ctx.editor.view.dispatch)).toBe(true);
    expect(ctx.editor.state.doc.child(2).type.name).toBe("heading");
    expect(ctx.editor.state.doc.child(2).textContent).toBe("");
  });

  it("a read-only page never opens the menu", async () => {
    await seed(root, { "Binary.md": Buffer.from([0x41, 0xff, 0xfe, 0x42, 0x0a]) });
    const ctx = await openPage("Binary.md", "Binary");
    expect(ctx.box.getAttribute("contenteditable")).toBe("false");
    ctx.editor.view.focus();
    type(ctx.editor, "/");
    expect(slashOpen()).toBe(false);
  });
});

describe("block menu and keyboard", () => {
  const SECOND = "Second paragraph with emphasis kept.";

  it("Alt+Shift+Arrow moves the block at the cursor; every move is one undo step; neighbours keep their bytes", async () => {
    const ctx = await openPage();
    caretAt(ctx.editor, endOf(ctx.editor, SECOND));
    await ctx.app.user.keyboard(KEY.moveUp);
    // the bullet list is now after "Second paragraph", which moved above it
    await ctx.saved(PAGE.replace("* odd bullet one\n* odd bullet two\n\nSecond paragraph with __emphasis__ kept.\n", "Second paragraph with __emphasis__ kept.\n\n* odd bullet one\n* odd bullet two\n"));
    // the caret stayed in the moved block: moving again continues from there
    await ctx.app.user.keyboard(KEY.moveDown);
    await ctx.saved(PAGE);
    expect(undo(ctx.editor.state, ctx.editor.view.dispatch)).toBe(true);
    await ctx.saved(PAGE.replace("* odd bullet one\n* odd bullet two\n\nSecond paragraph with __emphasis__ kept.\n", "Second paragraph with __emphasis__ kept.\n\n* odd bullet one\n* odd bullet two\n"));
    expect(undo(ctx.editor.state, ctx.editor.view.dispatch)).toBe(true);
    await ctx.saved(PAGE);
  });

  it("does nothing at the edges", async () => {
    const ctx = await openPage();
    caretAt(ctx.editor, endOf(ctx.editor, "Blocks"));
    await ctx.app.user.keyboard(KEY.moveUp);
    expect(ctx.editor.state.doc.child(0).type.name).toBe("heading");
    expect(ctx.guard.calls).toHaveLength(0);
  });

  it("moves a list item within its list", async () => {
    const ctx = await openPage();
    caretAt(ctx.editor, endOf(ctx.editor, "odd bullet two"));
    await ctx.app.user.keyboard(KEY.moveUp);
    await ctx.saved(PAGE.replace("* odd bullet one\n* odd bullet two\n", "- odd bullet two\n- odd bullet one\n"));
  });

  it("opens the block menu with Ctrl+Alt+M: an ARIA menu with roving focus, and Escape returns to the text", async () => {
    const ctx = await openPage();
    caretAt(ctx.editor, endOf(ctx.editor, "First paragraph."));
    await ctx.app.user.keyboard(KEY.menu);
    await waitFor(() => expect(menuOpen()).toBe(true));
    const items = within(blockMenu()!).getAllByRole("menuitem");
    expect(items.map((i) => i.querySelector(".block-menu-label")!.textContent)).toEqual(["Turn into", "Duplicate", "Delete", "Move up", "Move down"]);
    expect(document.activeElement).toBe(items[0]);
    expect(items.map((i) => i.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    await ctx.app.user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(items[2]);
    expect(items.map((i) => i.tabIndex)).toEqual([-1, -1, 0, -1, -1]);
    await ctx.app.user.keyboard("{End}");
    expect(document.activeElement).toBe(items[4]);
    await ctx.app.user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[0]); // wraps
    await ctx.app.user.keyboard("{Escape}");
    expect(menuOpen()).toBe(false);
    expect(document.activeElement).toBe(ctx.box);
    expect(ctx.guard.calls).toHaveLength(0);
    // the caret is where it was: typing continues there
    type(ctx.editor, "!");
    expect(ctx.editor.state.doc.child(1).textContent).toBe("First paragraph.!");
  });

  it("Move up is disabled on the first block, Move down on the last", async () => {
    const ctx = await openPage();
    caretAt(ctx.editor, endOf(ctx.editor, "Blocks"));
    await ctx.app.user.keyboard(KEY.menu);
    await waitFor(() => expect(menuOpen()).toBe(true));
    expect(within(blockMenu()!).getByRole("menuitem", { name: /Move up/ }).getAttribute("aria-disabled")).toBe("true");
    await ctx.app.user.keyboard("{Escape}");
    caretAt(ctx.editor, endOf(ctx.editor, "Last paragraph"));
    await ctx.app.user.keyboard(KEY.menu);
    await waitFor(() => expect(menuOpen()).toBe(true));
    expect(within(blockMenu()!).getByRole("menuitem", { name: /Move down/ }).getAttribute("aria-disabled")).toBe("true");
  });

  it("Duplicate: the copy is added after the block, in one undo step, and the original and the neighbours keep their bytes", async () => {
    const ctx = await openPage();
    caretAt(ctx.editor, endOf(ctx.editor, SECOND));
    await ctx.app.user.keyboard(KEY.menu);
    await waitFor(() => expect(menuOpen()).toBe(true));
    await ctx.app.user.keyboard("{ArrowDown}{Enter}");
    expect(menuOpen()).toBe(false);
    expect(document.activeElement).toBe(ctx.box);
    expect(ctx.editor.state.doc.childCount).toBe(9);
    await ctx.saved(PAGE.replace("Second paragraph with __emphasis__ kept.\n", "Second paragraph with __emphasis__ kept.\n\nSecond paragraph with __emphasis__ kept.\n"));
    expect(undo(ctx.editor.state, ctx.editor.view.dispatch)).toBe(true);
    expect(ctx.editor.state.doc.childCount).toBe(8);
    await ctx.saved(PAGE);
  });

  it("Delete removes the block in one undo step and leaves the neighbours byte-identical", async () => {
    const ctx = await openPage();
    caretAt(ctx.editor, endOf(ctx.editor, SECOND));
    await ctx.app.user.keyboard(KEY.menu);
    await waitFor(() => expect(menuOpen()).toBe(true));
    await ctx.app.user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await ctx.saved(PAGE.replace("Second paragraph with __emphasis__ kept.\n\n", ""));
    expect(undo(ctx.editor.state, ctx.editor.view.dispatch)).toBe(true);
    await ctx.saved(PAGE);
  });

  it("Delete works on a list item, a toggle and a divider", async () => {
    await seed(root, { "Mix.md": "intro\n\n- a\n- b\n- c\n\n> [!toggle]+ T\n> body\n\n---\n\nend\n" });
    const ctx = await openPage("Mix.md", "Mix");
    const del = async () => {
      await ctx.app.user.keyboard(KEY.menu);
      await waitFor(() => expect(menuOpen()).toBe(true));
      await ctx.app.user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    };
    caretAt(ctx.editor, endOf(ctx.editor, "b"));
    await del();
    caretAt(ctx.editor, endOf(ctx.editor, "T"));
    await del();
    await ctx.saved("intro\n\n- a\n- c\n\n---\n\nend\n");
  });

  describe("Turn into", () => {
    async function turn(ctx: Awaited<ReturnType<typeof openPage>>, target: string, label: string) {
      caretAt(ctx.editor, endOf(ctx.editor, target));
      await ctx.app.user.keyboard(KEY.menu);
      await waitFor(() => expect(menuOpen()).toBe(true));
      await ctx.app.user.keyboard("{Enter}"); // Turn into
      const sub = await screen.findByRole("menu", { name: "Turn into" });
      const radio = within(sub).getAllByRole("menuitemradio");
      expect(radio.map((r) => r.textContent!.replace(/^\S+/, "").trim().replace(/ ✓$/, ""))).toHaveLength(12);
      const wanted = radio.find((r) => r.querySelector(".block-menu-label")!.textContent === label)!;
      wanted.click();
    }

    it.each([
      ["Heading 1", "# First paragraph."],
      ["Heading 3", "### First paragraph."],
      ["Bulleted list", "- First paragraph."],
      ["Numbered list", "1. First paragraph."],
      ["To-do list", "- [ ] First paragraph."],
      ["Toggle", "> [!toggle]+ First paragraph."],
      ["Quote", "> First paragraph."],
      ["Code", "```\nFirst paragraph.\n```"],
    ])("turns a paragraph into %s, keeping its text, as one undo step", async (label, md) => {
      const ctx = await openPage();
      await turn(ctx, "First paragraph.", label);
      expect(menuOpen()).toBe(false);
      expect(document.activeElement).toBe(ctx.box);
      await ctx.saved(PAGE.replace("First paragraph.\n", `${md}\n`));
      expect(undo(ctx.editor.state, ctx.editor.view.dispatch)).toBe(true);
      await ctx.saved(PAGE);
    });

    it("turns a toggle into text; the title becomes the first line and the body follows", async () => {
      const ctx = await openPage();
      await turn(ctx, "Folded   title", "Text");
      await ctx.saved(PAGE.replace("> [!toggle]- Folded   title\n> hidden body\n", "Folded   title\n\nhidden body\n"));
    });

    it("turns a list item into a heading: the list splits around it and the other items keep their text", async () => {
      const ctx = await openPage();
      await turn(ctx, "odd bullet one", "Heading 2");
      await ctx.saved(PAGE.replace("* odd bullet one\n* odd bullet two\n", "## odd bullet one\n\n- odd bullet two\n"));
    });

    it("turns a heading into a divider; the text stays after the rule", async () => {
      const ctx = await openPage();
      await turn(ctx, "Blocks", "Divider");
      await ctx.saved(PAGE.replace("# Blocks\n", "***\n\nBlocks\n"));
    });

    it("turns a note callout into a toggle and back, keeping the title and body", async () => {
      const ctx = await openPage();
      await turn(ctx, "Open note", "Toggle");
      await ctx.saved(PAGE.replace("> [!note]+ Open note\n", "> [!toggle]+ Open note\n"));
    });
  });

  it("is not available on a read-only page: no menu, no move", async () => {
    await seed(root, { "Binary.md": Buffer.from([0x41, 0xff, 0xfe, 0x42, 0x0a]) });
    const ctx = await openPage("Binary.md", "Binary");
    ctx.editor.view.focus();
    await ctx.app.user.keyboard(KEY.menu);
    await ctx.app.user.keyboard(KEY.moveDown);
    expect(menuOpen()).toBe(false);
    expect(ctx.guard.calls).toHaveLength(0);
  });
});

describe("block handle", () => {
  const handle = () => document.querySelector<HTMLButtonElement>(".block-handle")!;

  /** jsdom has no hit testing: tell ProseMirror which position the mouse is over. */
  function hover(ctx: Awaited<ReturnType<typeof openPage>>, pos: number): void {
    vi.spyOn(ctx.editor.view, "posAtCoords").mockReturnValue({ pos, inside: pos });
    ctx.editor.view.dom.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 5 }));
  }

  it("shows on a hovered top-level block and a list item, hides when read-only, and opens the menu on click", async () => {
    const ctx = await openPage();
    expect(handle().hidden).toBe(true);
    caretAt(ctx.editor, 1);
    hover(ctx, endOf(ctx.editor, "First paragraph.") - 3);
    expect(handle().hidden).toBe(false);
    expect(handle().getAttribute("aria-label")).toMatch(/block menu/i);
    handle().click();
    await waitFor(() => expect(menuOpen()).toBe(true));
    await ctx.app.user.keyboard("{Escape}");
    hover(ctx, endOf(ctx.editor, "odd bullet two") - 2);
    expect(handle().hidden).toBe(false);
  });

  it("is hidden on a read-only page", async () => {
    await seed(root, { "Binary.md": Buffer.from([0x41, 0xff, 0xfe, 0x42, 0x0a]) });
    const ctx = await openPage("Binary.md", "Binary");
    hover(ctx, 2);
    expect(handle().hidden).toBe(true);
  });

  it("is hidden and the menu closed while a conflict is open", async () => {
    const ctx = await openPage();
    hover(ctx, 3);
    expect(handle().hidden).toBe(false);
    await ctx.app.user.keyboard(KEY.menu);
    caretAt(ctx.editor, endOf(ctx.editor, "First paragraph."));
    type(ctx.editor, "!");
    await ctx.app.external("Page.md", PAGE.replace("First paragraph.", "Rewritten elsewhere."));
    ctx.app.platform.emit({ paths: ["Page.md"] });
    await screen.findByRole("dialog", { name: /changed on disk/i });
    expect(ctx.editor.isEditable).toBe(false);
    expect(handle().hidden).toBe(true);
    hover(ctx, 3);
    expect(handle().hidden).toBe(true);
    expect(menuOpen()).toBe(false);
  });
});

describe("toggles", () => {
  const callouts = (box: HTMLElement) => [...box.querySelectorAll<HTMLElement>(".callout")];
  const foldButton = (callout: HTMLElement) => callout.querySelector<HTMLButtonElement>(".callout-fold")!;

  it("renders a toggle like Notion: a triangle, an editable title and a body; other kinds keep the callout look", async () => {
    const ctx = await openPage();
    const [toggle, note] = callouts(ctx.box);
    expect(toggle!.dataset["callout"]).toBe("toggle");
    expect(toggle!.querySelector(".callout-title")!.textContent).toBe("Folded   title");
    expect(toggle!.querySelector(".callout-title")!.closest("[contenteditable=false]")).toBeNull();
    expect(note!.dataset["callout"]).toBe("note");
    expect(note!.querySelector(".callout-title")!.textContent).toBe("Open note");
    // existing foldable callouts get the triangle too; the fold marker decides the initial state
    expect(foldButton(toggle!).hidden).toBe(false);
    expect(foldButton(note!).hidden).toBe(false);
    expect(toggle!.dataset["collapsed"]).toBe("true");
    expect(foldButton(toggle!).getAttribute("aria-expanded")).toBe("false");
    expect(foldButton(toggle!).textContent).toBe("▸");
    expect(note!.dataset["collapsed"]).toBe("false");
    expect(foldButton(note!).textContent).toBe("▾");
  });

  it("a callout without a fold marker has no triangle", async () => {
    const ctx = await openPage("Page.md", "Page");
    ctx.editor.view.dispatch(ctx.editor.state.tr);
    await seed(root, { "Plain.md": "> [!tip] Just a tip\n> body\n" });
    cleanup();
    const next = await openPage("Plain.md", "Plain");
    expect(foldButton(callouts(next.box)[0]!).hidden).toBe(true);
  });

  it("clicking the triangle collapses and expands in the view only: no transaction that changes the document, no save", async () => {
    const ctx = await openPage();
    const [toggle, note] = callouts(ctx.box);
    const docBefore = ctx.editor.state.doc;
    const markdownBefore = await ctx.app.read("Page.md");
    let changed = 0;
    ctx.editor.on("update", () => changed++);
    await ctx.app.user.click(foldButton(toggle!));
    expect(toggle!.dataset["collapsed"]).toBe("false");
    expect(foldButton(toggle!).getAttribute("aria-expanded")).toBe("true");
    await ctx.app.user.click(foldButton(note!));
    expect(note!.dataset["collapsed"]).toBe("true");
    await ctx.app.user.click(foldButton(note!));
    expect(note!.dataset["collapsed"]).toBe("false");
    await ctx.app.user.keyboard("{Meta>}s{/Meta}");
    await new Promise((r) => setTimeout(r, 60));
    expect(ctx.editor.state.doc).toBe(docBefore); // not even a new document object
    expect(changed).toBe(0);
    expect(ctx.guard.calls).toHaveLength(0);
    expect(await ctx.app.read("Page.md")).toBe(markdownBefore);
    // and the page is not dirty
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("a collapsed body is hidden by the marker class and Ctrl/Cmd+Enter folds from the keyboard", async () => {
    const ctx = await openPage();
    const note = callouts(ctx.box)[1]!;
    caretAt(ctx.editor, endOf(ctx.editor, "note body"));
    await ctx.app.user.keyboard("{Control>}{Enter}{/Control}");
    expect(note.dataset["collapsed"]).toBe("true");
    // the caret moved out of the hidden body, onto the title, without changing the document
    expect(ctx.editor.state.selection.$from.parent.type.name).toBe("calloutTitle");
    await ctx.app.user.keyboard("{Control>}{Enter}{/Control}");
    expect(note.dataset["collapsed"]).toBe("false");
    expect(ctx.guard.calls).toHaveLength(0);
  });

  it("the fold state survives edits and the saved marker is unchanged", async () => {
    const ctx = await openPage();
    const toggle = callouts(ctx.box)[0]!;
    await ctx.app.user.click(foldButton(toggle)); // expand a `-` toggle in the view
    caretAt(ctx.editor, endOf(ctx.editor, "Last paragraph   ".trimEnd().replace(/ +$/, "")) );
    type(ctx.editor, "!");
    await ctx.save();
    await waitFor(async () => expect(await ctx.app.read("Page.md")).toContain("Last paragraph!"));
    expect(await ctx.app.read("Page.md")).toContain("> [!toggle]- Folded   title\n> hidden body\n");
    expect(callouts(ctx.box)[0]!.dataset["collapsed"]).toBe("false");
  });

  describe("title editing", () => {
    it("typing in the title of an untouched toggle changes only that block", async () => {
      const ctx = await openPage();
      caretAt(ctx.editor, endOf(ctx.editor, "Folded   title"));
      type(ctx.editor, " v2");
      await ctx.saved(PAGE.replace("> [!toggle]- Folded   title\n", "> [!toggle]- Folded   title v2\n"));
    });

    it("editing the title of a plain callout keeps its marker, kind and body", async () => {
      const ctx = await openPage();
      caretAt(ctx.editor, endOf(ctx.editor, "Open note"));
      type(ctx.editor, " **now**");
      await ctx.saved(PAGE.replace("> [!note]+ Open note\n", "> [!note]+ Open note \\*\\*now\\*\\*\n"));
    });

    it("Enter in the title moves into the body and does not split the title", async () => {
      const ctx = await openPage();
      caretAt(ctx.editor, endOf(ctx.editor, "Open note") - 4);
      await ctx.app.user.keyboard("{Enter}");
      expect(ctx.editor.state.selection.$from.parent.type.name).toBe("paragraph");
      expect(ctx.editor.state.selection.$from.parent.textContent).toBe("note body");
      expect(callouts(ctx.box)[1]!.querySelector(".callout-title")!.textContent).toBe("Open note");
      expect(ctx.guard.calls).toHaveLength(0);
    });

    it("an untouched callout keeps the odd formatting of its title when only the body is edited elsewhere", async () => {
      const ctx = await openPage();
      caretAt(ctx.editor, endOf(ctx.editor, "note body"));
      type(ctx.editor, "!");
      await ctx.saved(PAGE.replace("> note body\n", "> note body!\n"));
    });

    it("an emptied title shows the kind as a placeholder and saves without title text", async () => {
      const ctx = await openPage();
      const title = ctx.editor.state.doc.child(5).firstChild!;
      expect(title.textContent).toBe("Open note");
      const from = endOf(ctx.editor, "Open note") - "Open note".length;
      caretAt(ctx.editor, from + "Open note".length);
      ctx.editor.view.dispatch(ctx.editor.state.tr.delete(from, from + "Open note".length));
      await ctx.saved(PAGE.replace("> [!note]+ Open note\n", "> [!note]+\n"));
      expect(callouts(ctx.box)[1]!.querySelector(".callout-title")!.textContent).toBe("");
    });
  });

  describe("Backspace", () => {
    it("at the start of a title turns the toggle back into text, keeping the title and the body", async () => {
      const ctx = await openPage();
      caretAt(ctx.editor, endOf(ctx.editor, "Folded   title") - "Folded   title".length);
      await ctx.app.user.keyboard("{Backspace}");
      await ctx.saved(PAGE.replace("> [!toggle]- Folded   title\n> hidden body\n", "Folded   title\n\nhidden body\n"));
      expect(undo(ctx.editor.state, ctx.editor.view.dispatch)).toBe(true);
      await ctx.saved(PAGE);
    });

    it("in an empty first body block goes back to the end of the title and drops that empty block", async () => {
      await seed(root, { "T.md": "> [!toggle]+ Title\n> first\n> second\n\nafter\n" });
      const ctx = await openPage("T.md", "T");
      // an empty paragraph at the start of the body, as Enter in the title and then typing nothing leaves
      const bodyStart = endOf(ctx.editor, "Title") + 1;
      ctx.editor.view.dispatch(ctx.editor.state.tr.insert(bodyStart, ctx.editor.schema.nodes["paragraph"]!.create()));
      caretAt(ctx.editor, bodyStart + 1);
      expect(ctx.editor.state.doc.child(0).childCount).toBe(3); // title, the empty block, the body
      await ctx.app.user.keyboard("{Backspace}");
      expect(ctx.editor.state.selection.$from.parent.type.name).toBe("calloutTitle");
      expect(ctx.editor.state.selection.$from.parentOffset).toBe("Title".length);
      expect(ctx.editor.state.doc.child(0).childCount).toBe(2);
      await ctx.saved("> [!toggle]+ Title\n> first\n> second\n\nafter\n");
    });

    it("in the only, empty body block of a toggle returns to the title", async () => {
      const ctx = await openPage();
      await newLineAfter(ctx, "First paragraph.");
      type(ctx.editor, "/toggle");
      await ctx.app.user.keyboard("{Enter}");
      const parent = () => ctx.editor.state.selection.$from.parent;
      expect(parent().type.name).toBe("calloutTitle"); // a new toggle starts with the caret in its title
      await ctx.app.user.keyboard("{Enter}");
      expect(parent().type.name).toBe("paragraph"); // Enter moves into the (empty) body
      expect(ctx.editor.state.selection.$from.node(-1).type.name).toBe("callout");
      await ctx.app.user.keyboard("{Backspace}");
      expect(parent().type.name).toBe("calloutTitle");
      expect(ctx.editor.state.doc.childCount).toBe(9);
    });
  });

  describe("modes", () => {
    it("a toggle shows as `> [!toggle]-` text in Plain mode, edits there keep it a toggle, and Blocks reads it back", async () => {
      const ctx = await openPage();
      await ctx.app.user.keyboard("{Meta>}{Shift>}e{/Shift}{/Meta}");
      const cm = await waitFor(() => {
        const el = document.querySelector<HTMLElement>(".cm-editor");
        if (!el) throw new Error("not in Plain mode yet");
        return CodeMirrorView.findFromDOM(el)!;
      });
      expect(cm.state.doc.toString()).toContain("> [!toggle]- Folded   title\n> hidden body");
      expect(ctx.guard.calls).toHaveLength(0);
      await ctx.app.user.keyboard("{Meta>}{Shift>}e{/Shift}{/Meta}");
      await waitFor(() => expect(callouts(document.body)[0]!.dataset["collapsed"]).toBe("true"));
      expect(ctx.guard.calls).toHaveLength(0);
    });
  });
});

describe("list items: Enter and Backspace", () => {
  // Bullet lists need a different marker from the to-do list, or Markdown would merge them into one list.
  const LIST = "intro\n\n- [ ] buy milk\n- [x] milk,eggs\n\n* one\n* two\n\n1. first\n2. second\n\nend\n";
  const open = async () => {
    await seed(root, { "List.md": LIST });
    return openPage("List.md", "List");
  };
  const caretBlock = (ctx: Awaited<ReturnType<typeof openPage>>) => ctx.editor.state.selection.$from;

  it("Enter at the end of a to-do starts a new unchecked to-do below it, at the same level", async () => {
    const ctx = await open();
    caretAt(ctx.editor, endOf(ctx.editor, "buy milk"));
    await ctx.app.user.keyboard("{Enter}");
    const $at = caretBlock(ctx);
    expect($at.parent.type.name).toBe("paragraph");
    expect($at.node(-1).type.name).toBe("taskItem");
    expect($at.node(-1).attrs["checked"]).toBe(false);
    expect($at.node(-2).childCount).toBe(3);
    type(ctx.editor, "bread");
    await ctx.saved(LIST.replace("- [ ] buy milk\n", "- [ ] buy milk\n- [ ] bread\n"));
  });

  it("Enter in the middle of a to-do splits it; the new to-do is unchecked", async () => {
    const ctx = await open();
    caretAt(ctx.editor, endOf(ctx.editor, "milk,eggs") - "eggs".length);
    await ctx.app.user.keyboard("{Enter}");
    expect(caretBlock(ctx).node(-1).attrs["checked"]).toBe(false);
    await ctx.saved(LIST.replace("- [x] milk,eggs\n", "- [x] milk,\n- [ ] eggs\n"));
  });

  it("Enter on an empty to-do turns it into a paragraph after the list", async () => {
    const ctx = await open();
    caretAt(ctx.editor, endOf(ctx.editor, "milk,eggs"));
    await ctx.app.user.keyboard("{Enter}{Enter}");
    expect(caretBlock(ctx).depth).toBe(1);
    expect(caretBlock(ctx).parent.type.name).toBe("paragraph");
    type(ctx.editor, "after");
    await ctx.saved(LIST.replace("- [x] milk,eggs\n", "- [x] milk,eggs\n\nafter\n"));
  });

  it("Enter on an empty to-do in the middle of the list splits the list around the new paragraph", async () => {
    const ctx = await open();
    caretAt(ctx.editor, endOf(ctx.editor, "buy milk"));
    await ctx.app.user.keyboard("{Enter}{Enter}");
    type(ctx.editor, "between");
    await ctx.saved(LIST.replace("- [ ] buy milk\n", "- [ ] buy milk\n\nbetween\n\n"));
  });

  it.each([
    ["bulleted", "one", "* one\n* two\n", "* one\n* uno\n* two\n"],
    ["numbered", "first", "1. first\n2. second\n", "1. first\n2. uno\n3. second\n"],
  ])("%s lists behave the same: Enter adds an item", async (_name, first, md, split) => {
    const ctx = await open();
    caretAt(ctx.editor, endOf(ctx.editor, first));
    await ctx.app.user.keyboard("{Enter}");
    expect(caretBlock(ctx).node(-1).type.name).toBe("listItem");
    type(ctx.editor, "uno");
    await ctx.saved(LIST.replace(md, split));
  });

  it.each([
    ["bulleted", "two", "* one\n* two\n", "* one\n* two\n\nafter\n"],
    ["numbered", "second", "1. first\n2. second\n", "1. first\n2. second\n\nafter\n"],
  ])("%s lists behave the same: Enter on an empty last item leaves the list", async (_name, last, md, exited) => {
    const ctx = await open();
    caretAt(ctx.editor, endOf(ctx.editor, last));
    await ctx.app.user.keyboard("{Enter}{Enter}");
    expect(caretBlock(ctx).depth).toBe(1);
    type(ctx.editor, "after");
    await ctx.saved(LIST.replace(md, exited));
  });

  it("Backspace at the start of a to-do turns it into a paragraph and keeps its text, as one undo step", async () => {
    const ctx = await open();
    caretAt(ctx.editor, endOf(ctx.editor, "milk,eggs") - "milk,eggs".length);
    await ctx.app.user.keyboard("{Backspace}");
    expect(caretBlock(ctx).depth).toBe(1);
    expect(caretBlock(ctx).parent.textContent).toBe("milk,eggs");
    expect(caretBlock(ctx).parentOffset).toBe(0);
    await ctx.saved(LIST.replace("- [x] milk,eggs\n", "\nmilk,eggs\n"));
    expect(undo(ctx.editor.state, ctx.editor.view.dispatch)).toBe(true);
    await ctx.saved(LIST);
  });

  it("Backspace at the start of a bullet turns it into a paragraph and keeps its text", async () => {
    const ctx = await open();
    caretAt(ctx.editor, endOf(ctx.editor, "two") - "two".length);
    await ctx.app.user.keyboard("{Backspace}");
    await ctx.saved(LIST.replace("* one\n* two\n", "* one\n\ntwo\n"));
  });

  it("Backspace inside the text of a to-do still deletes one character", async () => {
    const ctx = await open();
    caretAt(ctx.editor, endOf(ctx.editor, "buy milk"));
    await ctx.app.user.keyboard("{Backspace}");
    await ctx.saved(LIST.replace("- [ ] buy milk\n", "- [ ] buy mil\n"));
  });

  it("Enter in a code block inside a list item adds a line to the code", async () => {
    await seed(root, { "Code.md": "- item\n\n  ```\n  code\n  ```\n" });
    const ctx = await openPage("Code.md", "Code");
    caretAt(ctx.editor, endOf(ctx.editor, "code"));
    await ctx.app.user.keyboard("{Enter}");
    expect(caretBlock(ctx).parent.type.name).toBe("code");
    expect(caretBlock(ctx).parent.textContent).toBe("code\n");
  });

  it("the `/` menu still takes Enter inside a list item", async () => {
    const ctx = await open();
    caretAt(ctx.editor, endOf(ctx.editor, "buy milk"));
    await ctx.app.user.keyboard("{Enter}");
    type(ctx.editor, "/h2");
    await waitFor(() => expect(slashOpen()).toBe(true));
    await ctx.app.user.keyboard("{Enter}");
    await waitFor(() => expect(slashOpen()).toBe(false));
    expect(caretBlock(ctx).parent.type.name).toBe("heading");
  });
});

describe("Markdown input rules", () => {
  async function typeAtNewLine(text: string) {
    const ctx = await openPage();
    await newLineAfter(ctx, "First paragraph.");
    type(ctx.editor, text);
    return ctx;
  }
  const middle = async (ctx: Awaited<ReturnType<typeof openPage>>) => {
    await ctx.save();
    let out = "";
    await waitFor(async () => {
      const saved = await ctx.app.read("Page.md");
      expect(saved).not.toBe(PAGE);
      out = saved.slice("# Blocks\n\nFirst paragraph.\n\n".length, saved.indexOf("\n\n* odd bullet one"));
    });
    return out;
  };

  it("`> ` keeps meaning quote", async () => {
    const ctx = await typeAtNewLine("> ");
    expect(ctx.editor.state.doc.child(2).type.name).toBe("blockquote");
    type(ctx.editor, "q");
    expect(await middle(ctx)).toBe("> q");
  });

  it("`>> ` makes a toggle, open, with the caret in its title", async () => {
    const ctx = await typeAtNewLine(">> ");
    const node = ctx.editor.state.doc.child(2);
    expect(node.type.name).toBe("callout");
    expect(node.attrs).toMatchObject({ kind: "toggle", fold: "+" });
    expect(ctx.editor.state.selection.$from.parent.type.name).toBe("calloutTitle");
    type(ctx.editor, "Heading");
    expect(await middle(ctx)).toBe("> [!toggle]+ Heading");
  });

  it.each([["[] "], ["[ ] "]])("`%s` makes a to-do", async (typed) => {
    const ctx = await typeAtNewLine(typed);
    expect(ctx.editor.state.doc.child(2).type.name).toBe("taskList");
    type(ctx.editor, "buy milk");
    expect(await middle(ctx)).toBe("- [ ] buy milk");
  });

  it("`---` makes a divider and leaves the caret on a new line after it", async () => {
    const ctx = await typeAtNewLine("---");
    expect(ctx.editor.state.doc.child(2).type.name).toBe("thematicBreak");
    expect(ctx.editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(ctx.editor.state.doc.child(3).type.name).toBe("paragraph");
    type(ctx.editor, "after");
    expect(await middle(ctx)).toBe("***\n\nafter");
  });

  it("`--` or `---` inside text is not a divider", async () => {
    const ctx = await openPage();
    caretAt(ctx.editor, endOf(ctx.editor, "First paragraph."));
    type(ctx.editor, "---");
    expect(ctx.editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(ctx.editor.state.doc.child(1).textContent).toBe("First paragraph.---");
  });

  it("`>> ` is one undo step", async () => {
    const ctx = await typeAtNewLine(">> ");
    expect(undo(ctx.editor.state, ctx.editor.view.dispatch)).toBe(true);
    expect(ctx.editor.state.doc.child(2).type.name).toBe("paragraph");
  });
});
