// @vitest-environment jsdom
/**
 * Text styles in Blocks mode (ADR-0016 rule 1, Phase 3b AC 3 and 4), end to end through the app: the selection toolbar, the
 * shortcuts, and what PageSession saves. Every scenario ends in the file's text, and checks that untouched
 * blocks keep their exact bytes. Plain mode's live preview is checked at the end.
 *
 * jsdom has no layout or text input: selections are set through ProseMirror, keys go through user-event, and
 * the toolbar's position is not checked here (the Playwright scenario runs the real thing).
 */
import { EditorView as CodeMirrorView } from "@codemirror/view";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import { undo } from "@tiptap/pm/history";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, editorBox, openApp, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";
import { guardWrites } from "./support/write-guard.ts";
import { setDefaultEditorMode } from "@thoth/app-ui/editor/mode.ts";

const dirs = tempDirs();
let root: string;

const PAGE = `# Styles

First paragraph here.

* odd bullet one
* odd bullet two

Second   paragraph  kept.

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

async function openPage(file = "Page.md", name = "Page") {
  const guard = guardWrites();
  const app = await openApp(root);
  await app.user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name }));
  const box = await editorBox();
  await waitFor(() => expect(box.textContent).not.toBe(""));
  const editor = (box as Box).editor!;
  const saved = async (expected: string) => {
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(async () => expect(await app.read(file)).toBe(expected));
  };
  return { app, box, editor, guard, saved };
}
type Ctx = Awaited<ReturnType<typeof openPage>>;

/** Selects `text` inside one text block, with focus in the editor (what a drag or Shift+Arrow leaves behind). */
function select(editor: Editor, text: string): void {
  let from = -1;
  editor.state.doc.descendants((node, pos) => {
    if (from >= 0 || !node.isTextblock) return;
    const i = node.textContent.indexOf(text);
    if (i >= 0) from = pos + 1 + i;
  });
  if (from < 0) throw new Error(`"${text}" not in the document`);
  editor.view.focus();
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, from + text.length)));
}

const toolbar = () => screen.queryByRole("toolbar", { name: "Text formatting" });
const tool = (name: string) => within(toolbar()!).getByRole("button", { name });
const field = () => screen.getByRole("textbox", { name: "Link address" });

const MODS = { bold: "{Control>}b{/Control}", italic: "{Control>}i{/Control}", underline: "{Control>}u{/Control}", code: "{Control>}e{/Control}", strike: "{Control>}{Shift>}s{/Shift}{/Control}", highlight: "{Control>}{Shift>}h{/Shift}{/Control}", link: "{Control>}{Shift>}k{/Shift}{/Control}", toolbar: "{Alt>}{F10}{/Alt}" };

describe("the selection toolbar", () => {
  it("shows for selected text with every style, and not for a caret", async () => {
    const ctx = await openPage();
    ctx.editor.view.focus();
    expect(toolbar()).toBeNull();
    select(ctx.editor, "paragraph here");
    await waitFor(() => expect(toolbar()).not.toBeNull());
    const names = within(toolbar()!).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Bold", "Italic", "Underline", "Strikethrough", "Inline code", "Link", "Text colour", "Highlight"]);
    expect(within(toolbar()!).getByRole("button", { name: "Highlight" }).getAttribute("title")).toBe("Highlight (Ctrl/Cmd+Shift+H)");
    ctx.editor.view.dispatch(ctx.editor.state.tr.setSelection(TextSelection.create(ctx.editor.state.doc, 3)));
    await waitFor(() => expect(toolbar()).toBeNull());
  });

  it("is hidden for a code block and for a selection that reaches into one", async () => {
    const ctx = await openPage();
    select(ctx.editor, "const");
    await waitFor(() => expect(ctx.editor.state.selection.empty).toBe(false));
    expect(toolbar()).toBeNull();
    // From the last paragraph back up into the code block.
    const doc = ctx.editor.state.doc;
    ctx.editor.view.dispatch(ctx.editor.state.tr.setSelection(TextSelection.create(doc, doc.content.size - 8, doc.content.size - 3)));
    await waitFor(() => expect(toolbar()).not.toBeNull());
    ctx.editor.view.dispatch(ctx.editor.state.tr.setSelection(TextSelection.create(doc, doc.content.size - 40, doc.content.size - 3)));
    await waitFor(() => expect(toolbar()).toBeNull());
  });

  it("is hidden when the editor is read-only", async () => {
    await seed(root, { "Binary.md": Buffer.from([0x41, 0xff, 0xfe, 0x42, 0x0a]) });
    const ctx = await openPage("Binary.md", "Binary");
    expect(ctx.box.getAttribute("contenteditable")).toBe("false");
    ctx.editor.view.focus();
    ctx.editor.view.dispatch(ctx.editor.state.tr.setSelection(TextSelection.create(ctx.editor.state.doc, 1, 3)));
    expect(toolbar()).toBeNull();
  });

  it("is hidden when focus leaves the page text", async () => {
    const ctx = await openPage();
    select(ctx.editor, "paragraph here");
    await waitFor(() => expect(toolbar()).not.toBeNull());
    ctx.editor.view.dom.blur();
    await waitFor(() => expect(toolbar()).toBeNull());
  });

  const MARKS: [string, string][] = [
    ["Bold", "**paragraph here**"],
    ["Italic", "*paragraph here*"],
    ["Underline", "<u>paragraph here</u>"],
    ["Strikethrough", "~~paragraph here~~"],
    ["Inline code", "`paragraph here`"],
    ["Highlight", "==paragraph here=="],
  ];
  for (const [name, written] of MARKS) {
    it(`${name} applies and removes, and only that paragraph changes`, async () => {
      const ctx = await openPage();
      select(ctx.editor, "paragraph here");
      await waitFor(() => expect(toolbar()).not.toBeNull());
      expect(tool(name).getAttribute("aria-pressed")).toBe("false");
      await ctx.app.user.click(tool(name));
      expect(tool(name).getAttribute("aria-pressed")).toBe("true");
      await ctx.saved(PAGE.replace("paragraph here", written));
      expect(ctx.editor.view.hasFocus()).toBe(true); // a mouse click never moves focus out of the text
      await ctx.app.user.click(tool(name));
      expect(tool(name).getAttribute("aria-pressed")).toBe("false");
      await ctx.saved(PAGE);
      expect(ctx.guard.stale()).toEqual([]);
    });
  }

  it("each toolbar action is one undo step", async () => {
    const ctx = await openPage();
    select(ctx.editor, "paragraph here");
    await waitFor(() => expect(toolbar()).not.toBeNull());
    await ctx.app.user.click(tool("Bold"));
    await ctx.app.user.click(tool("Highlight"));
    await ctx.saved(PAGE.replace("paragraph here", "==**paragraph here**=="));
    expect(undo(ctx.editor.state, ctx.editor.view.dispatch)).toBe(true);
    await ctx.saved(PAGE.replace("paragraph here", "**paragraph here**"));
    expect(undo(ctx.editor.state, ctx.editor.view.dispatch)).toBe(true);
    await ctx.saved(PAGE);
  });

  it("applies a style across list items; the edited list is written canonically and every other block keeps its bytes", async () => {
    const ctx = await openPage();
    const doc = ctx.editor.state.doc;
    let from = -1;
    let to = -1;
    doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === "odd bullet one") from = pos + 1;
      if (node.isTextblock && node.textContent === "odd bullet two") to = pos + 1 + node.content.size;
    });
    ctx.editor.view.focus();
    ctx.editor.view.dispatch(ctx.editor.state.tr.setSelection(TextSelection.create(doc, from, to)));
    await waitFor(() => expect(toolbar()).not.toBeNull());
    await ctx.app.user.click(tool("Highlight"));
    await ctx.saved(PAGE.replace("* odd bullet one\n* odd bullet two", "- ==odd bullet one==\n- ==odd bullet two=="));
  });
});

describe("text colour", () => {
  const NAMES = ["Gray", "Brown", "Orange", "Yellow", "Green", "Blue", "Purple", "Red"];

  it("offers default and the eight palette colours, and writes the chosen name", async () => {
    const ctx = await openPage();
    select(ctx.editor, "paragraph here");
    await waitFor(() => expect(toolbar()).not.toBeNull());
    const button = tool("Text colour");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await ctx.app.user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "Text colour" });
    expect(within(menu).getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["ADefault", ...NAMES.map((n) => `A${n}`)]);
    expect(within(menu).getByRole("menuitemradio", { name: /Default/ }).getAttribute("aria-checked")).toBe("true");
    await ctx.app.user.click(within(menu).getByRole("menuitemradio", { name: /Red/ }));
    expect(screen.queryByRole("menu", { name: "Text colour" })).toBeNull();
    expect(ctx.editor.view.hasFocus()).toBe(true);
    await ctx.saved(PAGE.replace("paragraph here", '<span data-color="red">paragraph here</span>'));

    select(ctx.editor, "paragraph here");
    await ctx.app.user.click(tool("Text colour"));
    expect(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: /Red/ }).getAttribute("aria-checked")).toBe("true");
    await ctx.app.user.click(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: /Default/ }));
    await ctx.saved(PAGE);
  });

  it("works from the keyboard: arrows move, Enter picks, Escape closes", async () => {
    const ctx = await openPage();
    select(ctx.editor, "paragraph here");
    await waitFor(() => expect(toolbar()).not.toBeNull());
    await ctx.app.user.keyboard(MODS.toolbar);
    expect(document.activeElement).toBe(tool("Bold"));
    await ctx.app.user.keyboard("{End}{ArrowLeft}"); // Highlight, then Text colour
    expect(document.activeElement).toBe(tool("Text colour"));
    await ctx.app.user.keyboard("{ArrowDown}");
    const menu = screen.getByRole("menu", { name: "Text colour" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitemradio", { name: /Default/ }));
    await ctx.app.user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}"); // Gray, Brown, Orange
    expect(document.activeElement?.textContent).toBe("AOrange");
    await ctx.app.user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(tool("Text colour")); // one Escape closes the menu ...
    await ctx.app.user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(ctx.editor.view.hasFocus()).toBe(true); // ... and a pick returns to the text
    await ctx.saved(PAGE.replace("paragraph here", '<span data-color="orange">paragraph here</span>'));
  });
});

describe("link", () => {
  it("opens an address field, links the selection on Enter, and Escape returns to the text", async () => {
    const ctx = await openPage();
    select(ctx.editor, "paragraph here");
    await waitFor(() => expect(toolbar()).not.toBeNull());
    await ctx.app.user.click(tool("Link"));
    expect(document.activeElement).toBe(field());
    await ctx.app.user.keyboard("{Escape}");
    expect(ctx.editor.view.hasFocus()).toBe(true);
    expect(toolbar()).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Link address" })).toBeNull();

    await ctx.app.user.click(tool("Link"));
    await ctx.app.user.keyboard("example.com/docs{Enter}");
    expect(ctx.editor.view.hasFocus()).toBe(true);
    expect(tool("Link").getAttribute("aria-pressed")).toBe("true");
    await ctx.saved(PAGE.replace("paragraph here", "[paragraph here](https://example.com/docs)"));
  });

  it("refuses an address that would run code, and says why", async () => {
    const ctx = await openPage();
    select(ctx.editor, "paragraph here");
    await waitFor(() => expect(toolbar()).not.toBeNull());
    await ctx.app.user.click(tool("Link"));
    await ctx.app.user.keyboard("javascript:alert(1){Enter}");
    expect(screen.getByRole("alert").textContent).toMatch(/http, https, mailto or tel/);
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field());
    await ctx.app.user.keyboard("{Escape}");
    await ctx.saved(PAGE);
  });

  it("edits and removes an existing link", async () => {
    await seed(root, { "Linked.md": "See [the docs](https://a.example/x) now.\n" });
    const ctx = await openPage("Linked.md", "Linked");
    select(ctx.editor, "the docs");
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(tool("Link").getAttribute("aria-pressed")).toBe("true");
    await ctx.app.user.click(tool("Link"));
    expect((field() as HTMLInputElement).value).toBe("https://a.example/x");
    await ctx.app.user.clear(field());
    await ctx.app.user.keyboard("https://b.example/y{Enter}");
    await ctx.saved("See [the docs](https://b.example/y) now.\n");

    select(ctx.editor, "the docs");
    await ctx.app.user.click(tool("Link"));
    await ctx.app.user.click(screen.getByRole("button", { name: "Remove link" }));
    await ctx.saved("See the docs now.\n");
  });
});

describe("shortcuts", () => {
  const cases: [string, string, string][] = [
    ["Mod+B", MODS.bold, "**paragraph here**"],
    ["Mod+I", MODS.italic, "*paragraph here*"],
    ["Mod+U", MODS.underline, "<u>paragraph here</u>"],
    ["Mod+E", MODS.code, "`paragraph here`"],
    ["Mod+Shift+S", MODS.strike, "~~paragraph here~~"],
    ["Mod+Shift+H", MODS.highlight, "==paragraph here=="],
  ];
  for (const [label, keys, written] of cases) {
    it(`${label} toggles it on the selection, with the toolbar open or not`, async () => {
      const ctx = await openPage();
      select(ctx.editor, "paragraph here");
      await ctx.app.user.keyboard(keys);
      await ctx.saved(PAGE.replace("paragraph here", written));
      await ctx.app.user.keyboard(keys);
      await ctx.saved(PAGE);
    });
  }

  it("Mod+Shift+H marks the toolbar's Highlight button as pressed", async () => {
    const ctx = await openPage();
    select(ctx.editor, "paragraph here");
    await waitFor(() => expect(toolbar()).not.toBeNull());
    await ctx.app.user.keyboard(MODS.highlight);
    expect(tool("Highlight").getAttribute("aria-pressed")).toBe("true");
  });

  it("Mod+K is left alone: it neither styles nor links (it opens search)", async () => {
    const ctx = await openPage();
    select(ctx.editor, "paragraph here");
    await waitFor(() => expect(toolbar()).not.toBeNull());
    await ctx.app.user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("textbox", { name: "Link address" })).toBeNull();
    await ctx.saved(PAGE);
  });

  it("Mod+Shift+K opens the link field for the selection, and does nothing for a caret", async () => {
    const ctx = await openPage();
    ctx.editor.view.focus();
    await ctx.app.user.keyboard(MODS.link);
    expect(screen.queryByRole("textbox", { name: "Link address" })).toBeNull();
    select(ctx.editor, "paragraph here");
    await ctx.app.user.keyboard(MODS.link);
    expect(document.activeElement).toBe(field());
    await ctx.app.user.keyboard("mailto:a@b.example{Enter}");
    await ctx.saved(PAGE.replace("paragraph here", "[paragraph here](mailto:a@b.example)"));
  });

  it("a shortcut in a code block does nothing and does not fall through to the browser", async () => {
    const ctx = await openPage();
    select(ctx.editor, "const");
    const down = new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true });
    ctx.editor.view.dom.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await ctx.saved(PAGE);
  });

  it("a caret plus a shortcut changes what is typed next, not the file", async () => {
    const ctx = await openPage();
    ctx.editor.view.focus();
    ctx.editor.view.dispatch(ctx.editor.state.tr.setSelection(TextSelection.create(ctx.editor.state.doc, 3)));
    await ctx.app.user.keyboard(MODS.highlight);
    expect(ctx.editor.state.storedMarks?.map((m) => m.type.name)).toEqual(["highlight"]);
    await ctx.saved(PAGE);
  });
});

describe("keyboard use of the toolbar", () => {
  it("Alt+F10 enters it, arrows move, Enter toggles, Escape returns to the text", async () => {
    const ctx = await openPage();
    select(ctx.editor, "paragraph here");
    await waitFor(() => expect(toolbar()).not.toBeNull());
    await ctx.app.user.keyboard(MODS.toolbar);
    expect(document.activeElement).toBe(tool("Bold"));
    expect(toolbar()).not.toBeNull(); // moving focus into it keeps it open
    await ctx.app.user.keyboard("{ArrowRight}{ArrowRight}"); // Underline
    expect(document.activeElement).toBe(tool("Underline"));
    await ctx.app.user.keyboard("{Enter}");
    expect(document.activeElement).toBe(tool("Underline")); // focus stays, so several styles can be toggled
    expect(tool("Underline").getAttribute("aria-pressed")).toBe("true");
    await ctx.app.user.keyboard("{Home}{Enter}");
    expect(tool("Bold").getAttribute("aria-pressed")).toBe("true");
    await ctx.app.user.keyboard("{Escape}");
    expect(ctx.editor.view.hasFocus()).toBe(true);
    expect(document.activeElement).toBe(ctx.editor.view.dom);
    await ctx.saved(PAGE.replace("paragraph here", "<u>**paragraph here**</u>"));
  });

  it("only one toolbar button is in the tab order, and Tab returns to the text", async () => {
    const ctx = await openPage();
    select(ctx.editor, "paragraph here");
    await waitFor(() => expect(toolbar()).not.toBeNull());
    const stops = within(toolbar()!).getAllByRole("button").filter((b) => b.tabIndex === 0);
    expect(stops).toHaveLength(1);
    await ctx.app.user.keyboard(MODS.toolbar);
    await ctx.app.user.keyboard("{Tab}");
    expect(document.activeElement).toBe(ctx.editor.view.dom);
  });

  it("Alt+F10 without a toolbar does nothing", async () => {
    const ctx = await openPage();
    ctx.editor.view.focus();
    await ctx.app.user.keyboard(MODS.toolbar);
    expect(document.activeElement).toBe(ctx.editor.view.dom);
  });
});

describe("Plain mode live preview", () => {
  const SOURCE = [
    "Intro line.",
    "",
    "A ==marked words== and <u>under</u> and <span data-color=\"red\">red text</span> and <span class=\"k\">other</span> done.",
    "",
    "Not a highlight: a == b, ===x===, `==code==` and `<u>code</u>`.",
    "",
    "<u>one</u> then <u>unclosed",
    "",
    "<span data-color=\"pink\">pink</span>",
    "",
  ].join("\n");

  async function plain() {
    await seed(root, { "Styled.md": SOURCE });
    setDefaultEditorMode("plain");
    const guard = guardWrites();
    const app = await openApp(root);
    await app.user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: "Styled" }));
    const box = await editorBox();
    const view = CodeMirrorView.findFromDOM(box.closest(".cm-editor") as HTMLElement)!;
    await waitFor(() => expect(view.state.doc.toString()).toBe(SOURCE));
    view.focus();
    view.dispatch({ selection: { anchor: 0 } }); // the caret on the first line: later lines are previewed
    return { app, view, guard, content: view.contentDOM };
  }
  const lineOf = (content: HTMLElement, text: string) => [...content.querySelectorAll<HTMLElement>(".cm-line")].find((l) => l.textContent!.includes(text))!;

  it("shows highlight, underline and palette colours with their markers hidden, and never rewrites the file", async () => {
    const { app, view, guard, content } = await plain();
    await waitFor(() => expect(content.querySelector(".md-highlight")).not.toBeNull());
    const line = lineOf(content, "marked words");
    expect(line.textContent).toBe('A marked words and under and red text and <span class="k">other</span> done.');
    expect(line.querySelector(".md-highlight")?.textContent).toBe("marked words");
    expect(line.querySelector(".md-underline")?.textContent).toBe("under");
    const colored = line.querySelector<HTMLElement>(".text-color");
    expect(colored?.textContent).toBe("red text");
    expect(colored?.dataset["color"]).toBe("red");
    // An unknown span is plain HTML: its tags stay visible and nothing is coloured; the styled tags are hidden.
    expect(line.textContent).not.toContain("<u>");
    expect(line.querySelectorAll(".text-color")).toHaveLength(1);

    await app.user.keyboard("{Meta>}s{/Meta}");
    await new Promise((r) => setTimeout(r, 60));
    expect(guard.calls).toHaveLength(0);
    expect(view.state.doc.toString()).toBe(SOURCE);
    expect(await app.read("Styled.md")).toBe(SOURCE);
  });

  it("reads `==`, `<u>` and colours as the serializer does: code, spaced and unpaired markers stay as written", async () => {
    const { content } = await plain();
    await waitFor(() => expect(content.querySelector(".md-highlight")).not.toBeNull());
    const not = lineOf(content, "Not a highlight");
    expect(not.querySelector(".md-highlight")).toBeNull();
    expect(not.querySelector(".md-underline")).toBeNull();
    expect(not.textContent).toContain("==code==");
    expect(not.textContent).toContain("<u>code</u>");
    expect(not.textContent).toContain("a == b");
    const unclosed = lineOf(content, "then");
    expect(unclosed.querySelectorAll(".md-underline")).toHaveLength(1);
    expect(unclosed.textContent).toBe("one then <u>unclosed");
    const pink = lineOf(content, "pink");
    expect(pink.querySelector(".text-color")).toBeNull();
  });

  it("shows the exact source on the line being edited, still styled", async () => {
    const { view, content } = await plain();
    const at = SOURCE.indexOf("marked words");
    view.dispatch({ selection: { anchor: at } });
    await waitFor(() => expect(lineOf(content, "marked words").textContent).toContain("==marked words=="));
    const line = lineOf(content, "marked words");
    expect(line.textContent).toContain("<u>under</u>");
    expect(line.textContent).toContain('<span data-color="red">red text</span>');
    expect(line.querySelector(".md-highlight")?.textContent).toBe("marked words");
    expect(line.querySelector(".text-color")?.textContent).toBe("red text");
  });
});
