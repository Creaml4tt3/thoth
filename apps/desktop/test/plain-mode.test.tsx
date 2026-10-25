// @vitest-environment jsdom
/**
 * Plain mode in the app (ADR-0012): the same page, the same PageSession, a
 * different editor. Saves are exact text edits; switching modes never writes
 * and never loses an unsaved edit; conflicts behave as in Blocks mode.
 */
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, editorBox, openApp, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";
import { guardWrites } from "./support/write-guard.ts";
import { setDefaultEditorMode } from "@thoth/app-ui/editor/mode.ts";

const dirs = tempDirs();
let root: string;
// Odd but valid Markdown the block editor would also keep: Plain mode must keep it byte for byte too.
const ODD = "﻿---\r\ntitle:   Odd\r\n---\r\n* star bullet\r\n\r\n__bold__   spacing  \r\nlast line without newline";

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA, "Odd.md": ODD });
});
afterEach(async () => {
  vi.restoreAllMocks();
  setDefaultEditorMode("blocks");
  localStorage.clear();
  cleanup();
  await dirs.cleanup();
});

/** The CodeMirror view behind the open Plain editor. jsdom cannot type into contenteditable for CodeMirror, so edits are dispatched as user input. */
async function plainView(): Promise<EditorView> {
  const box = await editorBox();
  const view = EditorView.findFromDOM(box.closest(".cm-editor") as HTMLElement);
  if (!view) throw new Error("No CodeMirror view");
  view.focus();
  return view;
}

function typeAt(view: EditorView, after: string, text: string): void {
  const at = view.state.doc.toString().indexOf(after);
  if (at < 0) throw new Error(`"${after}" not in the document`);
  view.dispatch({ changes: { from: at + after.length, insert: text }, userEvent: "input.type" });
}

async function openPage(name: string) {
  const app = await openApp(root);
  await app.user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name }));
  return app;
}

const modeButton = (label: "Blocks" | "Plain") => within(screen.getByRole("group", { name: "Editor mode" })).getByRole("button", { name: label });

describe("Plain mode", () => {
  it("opens in Plain when that is the default, and saves only the typed characters", async () => {
    setDefaultEditorMode("plain");
    const guard = guardWrites();
    const app = await openPage("Odd");
    const view = await plainView();
    await waitFor(() => expect(view.state.doc.toString()).toContain("star bullet"));
    expect(modeButton("Plain").getAttribute("aria-pressed")).toBe("true");

    typeAt(view, "star bullet", "!");
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(async () => expect(await app.read("Odd.md")).toBe(ODD.replace("star bullet", "star bullet!")));
    expect(guard.calls).toHaveLength(1);
    expect(guard.stale()).toEqual([]);
  });

  it("a no-op save in Plain mode writes nothing", async () => {
    setDefaultEditorMode("plain");
    const guard = guardWrites();
    const app = await openPage("Odd");
    const view = await plainView();
    await waitFor(() => expect(view.state.doc.toString()).toContain("star bullet"));
    typeAt(view, "star bullet", "x");
    view.dispatch({ changes: { from: view.state.doc.toString().indexOf("bulletx") + 6, to: view.state.doc.toString().indexOf("bulletx") + 7 } });
    await app.user.keyboard("{Meta>}s{/Meta}");
    await new Promise((r) => setTimeout(r, 60));
    expect(guard.calls).toHaveLength(0);
    expect(await app.read("Odd.md")).toBe(ODD);
  });

  it("switching modes keeps an unsaved edit and does not write", async () => {
    const guard = guardWrites();
    const app = await openPage("Alpha");
    await app.user.click(modeButton("Plain"));
    const view = await plainView();
    await waitFor(() => expect(view.state.doc.toString()).toContain("First paragraph stays exactly."));
    typeAt(view, "First paragraph stays exactly.", " Typed in Plain.");

    await app.user.click(modeButton("Blocks"));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("First paragraph stays exactly. Typed in Plain."));
    await waitFor(() => expect(box.classList.contains("ProseMirror-focused")).toBe(true)); // focus follows the switch (Tiptap focuses on the next frame)
    expect(guard.calls).toHaveLength(0);
    expect(await app.read("Alpha.md")).toBe(ALPHA);
    expect(screen.getByRole("status", { name: "" }).textContent).toBe("Unsaved changes");

    // Saved from Blocks: the edited paragraph changes, every other byte (odd bullets, __emphasis__, spacing) stays.
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(async () => expect(await app.read("Alpha.md")).toBe(ALPHA.replace("First paragraph stays exactly.", "First paragraph stays exactly. Typed in Plain.")));
    expect(guard.stale()).toEqual([]);
  });

  it("Ctrl/Cmd+Shift+E toggles the mode and the page remembers it", async () => {
    const app = await openPage("Alpha");
    await editorBox();
    await app.user.keyboard("{Meta>}{Shift>}e{/Shift}{/Meta}");
    await waitFor(() => expect(modeButton("Plain").getAttribute("aria-pressed")).toBe("true"));
    expect(document.querySelector(".cm-editor")).not.toBeNull();

    await app.user.click(within(screen.getByRole("tree")).getByRole("treeitem", { name: "Beta" }));
    await waitFor(() => expect(modeButton("Blocks").getAttribute("aria-pressed")).toBe("true"));
    await app.user.click(within(screen.getByRole("tree")).getByRole("treeitem", { name: "Alpha" }));
    await waitFor(() => expect(modeButton("Plain").getAttribute("aria-pressed")).toBe("true"));
  });

  it("an external change with unsaved Plain edits opens the conflict dialog and nothing is overwritten", async () => {
    setDefaultEditorMode("plain");
    const guard = guardWrites();
    const app = await openPage("Alpha");
    const view = await plainView();
    await waitFor(() => expect(view.state.doc.toString()).toContain("First paragraph"));
    typeAt(view, "First paragraph stays exactly.", "!!");
    const external = ALPHA.replace("First paragraph stays exactly.", "Rewritten elsewhere.");
    await app.external("Alpha.md", external);
    app.platform.emit({ paths: ["Alpha.md"] });

    const dialog = await screen.findByRole("dialog", { name: /changed on disk/i });
    expect(view.state.readOnly).toBe(true);
    expect(modeButton("Blocks").hasAttribute("disabled")).toBe(true);
    await app.user.click(within(dialog).getByRole("button", { name: /keep both/i }));
    await waitFor(() => expect(view.state.doc.toString()).toContain("Rewritten elsewhere."));
    expect(await app.read("Alpha.md")).toBe(external);
    expect(guard.calls.map((c) => c.expectedHash)).toEqual([null]); // only the conflict copy was written
    expect(view.state.readOnly).toBe(false);
  });

  it("a page with no local edits follows the disk silently in Plain mode", async () => {
    setDefaultEditorMode("plain");
    const app = await openPage("Beta");
    const view = await plainView();
    await waitFor(() => expect(view.state.doc.toString()).toContain("Beta links back"));
    await app.external("Beta.md", "# Beta\n\nChanged outside.\n");
    app.platform.emit({ paths: ["Beta.md"] });
    await waitFor(() => expect(view.state.doc.toString()).toBe("# Beta\n\nChanged outside.\n"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("non-UTF-8 files are read-only in Plain mode too", async () => {
    await seed(root, { "Latin.md": new Uint8Array([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a]) });
    setDefaultEditorMode("plain");
    const guard = guardWrites();
    const app = await openPage("Latin");
    const view = await plainView();
    await waitFor(() => expect(view.state.readOnly).toBe(true));
    await app.user.keyboard("{Meta>}s{/Meta}");
    await new Promise((r) => setTimeout(r, 60));
    expect(guard.calls).toHaveLength(0);
  });

  it("live preview shows a callout as a callout: a kind label instead of the raw `[!kind]` marker, and the file is untouched", async () => {
    const source = "Intro line.\n\n> [!note] Read me\n> body text\n\n> [!WARNING]-\n> careful\n\n> [!toggle]+ Fold me\n> inside\n\n> plain quote\n\n> [!not a kind] stays a quote\n";
    await seed(root, { "Callouts.md": source });
    setDefaultEditorMode("plain");
    const guard = guardWrites();
    const app = await openPage("Callouts");
    const view = await plainView();
    await waitFor(() => expect(view.state.doc.toString()).toBe(source));
    view.dispatch({ selection: { anchor: 0 } }); // the caret on "Intro line.": every callout line is previewed
    const content = view.contentDOM;
    const lineOf = (text: string) => [...content.querySelectorAll<HTMLElement>(".cm-line")].find((l) => l.textContent!.includes(text))!;

    await waitFor(() => expect(content.querySelectorAll(".md-callout-label")).toHaveLength(3));
    expect([...content.querySelectorAll(".md-callout-label")].map((l) => l.textContent)).toEqual(["iNote", "!Warning", "▸Toggle"]);
    expect(content.textContent).not.toContain("!note");
    expect(content.textContent).not.toContain("!WARNING");
    expect(content.textContent).not.toContain("!toggle");
    expect(lineOf("Read me").dataset["callout"]).toBe("note");
    expect(lineOf("Read me").classList.contains("md-line-callout-title")).toBe(true);
    expect(lineOf("body text").dataset["callout"]).toBe("note");
    expect(lineOf("careful").dataset["callout"]).toBe("warning");
    expect(lineOf("Fold me").dataset["callout"]).toBe("toggle");
    // An ordinary quote, and a marker that is not a valid kind, stay quotes.
    expect(lineOf("plain quote").classList.contains("md-line-callout")).toBe(false);
    expect(lineOf("stays a quote").classList.contains("md-line-callout")).toBe(false);

    // The line being edited shows its exact source.
    const at = source.indexOf("Read me");
    view.dispatch({ selection: { anchor: at } });
    await waitFor(() => expect(lineOf("Read me").textContent).toBe("> [!note] Read me"));
    expect(content.querySelectorAll(".md-callout-label")).toHaveLength(2);

    // Display only: nothing was written and the text is the file's.
    await app.user.keyboard("{Meta>}s{/Meta}");
    await new Promise((r) => setTimeout(r, 60));
    expect(guard.calls).toHaveLength(0);
    expect(view.state.doc.toString()).toBe(source);
    expect(await app.read("Callouts.md")).toBe(source);
  });

  it("the default mode is chosen in Settings", async () => {
    const app = await openApp(root);
    await app.user.click(await screen.findByRole("button", { name: /settings/i }));
    await app.user.click(await screen.findByRole("radio", { name: /plain/i }));
    await waitFor(() => expect(localStorage.getItem("thoth.editor.defaultMode")).toBe("plain"));
    await app.user.click(within(screen.getByRole("tree")).getByRole("treeitem", { name: "Beta" }));
    await waitFor(() => expect(modeButton("Plain").getAttribute("aria-pressed")).toBe("true"));
  });
});
