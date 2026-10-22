// @vitest-environment jsdom
/**
 * `[[` autocomplete in both editor modes, end to end through the app: the menu
 * lists vault pages, keyboard picking inserts a link that resolves, Escape
 * dismisses, and the saved Markdown is exactly `[[Target]]` with every other
 * byte unchanged.
 *
 * jsdom cannot generate text input for contenteditable, so typing goes through
 * the editors' own input paths: ProseMirror's `handleTextInput` props (what a
 * keypress triggers) and CodeMirror user-input transactions.
 */
import { EditorView as CodeMirrorView } from "@codemirror/view";
import type { EditorView as ProseMirrorView } from "@tiptap/pm/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caretAtEnd, cleanup, editorBox, openApp, paragraph, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";
import { guardWrites } from "./support/write-guard.ts";
import { setDefaultEditorMode } from "../src/features/editor/mode.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, {
    "Alpha.md": ALPHA,
    "Beta.md": BETA,
    "Projects/Roadmap.md": "# Roadmap\n",
    // Titles come from frontmatter `title`, else the file name (the index's rule).
    "Work/Notes.md": "---\ntitle: Work notes\n---\n",
    "Home/Notes.md": "---\ntitle: Home notes\n---\n",
    "Sync.md": "---\ntitle: Weekly sync\naliases: [standup]\n---\n",
  });
});
afterEach(async () => {
  vi.restoreAllMocks(); // guardWrites spies on Vault.prototype; stacked spies would leak between tests
  setDefaultEditorMode("blocks");
  localStorage.clear();
  cleanup();
  await dirs.cleanup();
});

const menu = () => screen.queryByRole("listbox", { name: "Link to page" });
const options = () => within(menu()!).getAllByRole("option").map((o) => o.querySelector(".link-option-title")!.textContent);

async function openAlpha() {
  const app = await openApp(root);
  await app.user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: "Alpha" }));
  const box = await editorBox();
  await waitFor(() => expect(box.textContent).toContain("First paragraph stays exactly."));
  return { app, box };
}

/** Types into ProseMirror the way a keypress does: handleTextInput props first, plain insertion otherwise. */
function typeBlocks(box: HTMLElement, text: string): void {
  // Tiptap keeps its editor on the ProseMirror root element.
  const view = (box as unknown as { editor?: { view: ProseMirrorView } }).editor?.view;
  if (!view) throw new Error("No ProseMirror view");
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

describe("[[ autocomplete in Blocks mode", () => {
  it("lists pages, picks with the keyboard, and saves a resolving [[link]] with nothing else changed", async () => {
    const guard = guardWrites();
    const { app, box } = await openAlpha();
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    typeBlocks(box, " [[");
    await waitFor(() => expect(menu()).not.toBeNull());
    typeBlocks(box, "note");
    await waitFor(() => expect(options()).toEqual(["Home notes", "Work notes"]));
    await app.user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(menu()?.hidden ?? true).toBe(true));
    expect(box.querySelector('.wikilink[data-target="Work/Notes.md"]')?.textContent).toBe("Work/Notes");

    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(async () => expect(await app.read("Alpha.md")).toBe(ALPHA.replace("First paragraph stays exactly.", "First paragraph stays exactly. [[Work/Notes]]")));
    expect(guard.stale()).toEqual([]);
  });

  it("finds pages by alias and Escape dismisses the menu without changing the text", async () => {
    const { app, box } = await openAlpha();
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    typeBlocks(box, " [[stand");
    await waitFor(() => expect(options()).toEqual(["Weekly sync"]));
    expect(within(menu()!).getByText(/alias “standup”/)).toBeTruthy();
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(menu()?.hidden ?? true).toBe(true));
    expect(box.textContent).toContain("First paragraph stays exactly. [[stand");
    typeBlocks(box, "u");
    expect(menu()?.hidden ?? true).toBe(true); // stays dismissed for this [[
  });

  it("a link typed by hand with ]] becomes a real link, saved unescaped", async () => {
    const { app, box } = await openAlpha();
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    typeBlocks(box, " [[Beta]]");
    await waitFor(() => expect(box.querySelector('.wikilink[data-target="Beta.md"]')).not.toBeNull());
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(async () => expect(await app.read("Alpha.md")).toBe(ALPHA.replace("First paragraph stays exactly.", "First paragraph stays exactly. [[Beta]]")));
  });
});

describe("[[ autocomplete in Plain mode", () => {
  async function plain() {
    setDefaultEditorMode("plain");
    const { app, box } = await openAlpha();
    const view = CodeMirrorView.findFromDOM(box.closest(".cm-editor") as HTMLElement)!;
    view.focus();
    const end = view.state.doc.toString().indexOf("First paragraph stays exactly.") + "First paragraph stays exactly.".length;
    view.dispatch({ selection: { anchor: end } });
    const type = (text: string) => {
      for (const ch of text) view.dispatch(view.state.replaceSelection(ch), { userEvent: "input.type" });
    };
    return { app, view, type };
  }

  it("completes [[ro to [[Roadmap]] as one undoable edit and saves exactly that", async () => {
    const guard = guardWrites();
    const { app, view, type } = await plain();
    type(" [[ro");
    await waitFor(() => expect(options()).toEqual(["Roadmap"]));
    await app.user.keyboard("{Enter}");
    expect(view.state.doc.toString()).toContain("First paragraph stays exactly. [[Roadmap]]\n");
    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf("[[Roadmap]]") + "[[Roadmap]]".length);
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(async () => expect(await app.read("Alpha.md")).toBe(ALPHA.replace("First paragraph stays exactly.", "First paragraph stays exactly. [[Roadmap]]")));
    expect(guard.stale()).toEqual([]);
  });

  it("arrow keys move through the list; Escape closes it and Enter then makes a new line", async () => {
    const { app, view, type } = await plain();
    type(" [[notes");
    await waitFor(() => expect(options()).toEqual(["Home notes", "Work notes"]));
    await app.user.keyboard("{ArrowDown}");
    expect(within(menu()!).getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(menu()?.hidden ?? true).toBe(true));
    await app.user.keyboard("{Enter}");
    expect(view.state.doc.toString()).toContain("First paragraph stays exactly. [[notes\n");
  });
});
