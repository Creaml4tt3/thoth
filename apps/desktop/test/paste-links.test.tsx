// @vitest-environment jsdom
/**
 * Paste makes links (ADR-0020 rule 1), end to end through the app in Blocks mode: what PageSession saves after a
 * paste, the one undo step that turns a link back into the pasted text, code and plain paste left alone, refused
 * schemes, and untouched blocks keeping their exact bytes. Plain mode inserts what was pasted, unchanged.
 *
 * jsdom has no clipboard: a paste is a `paste` event with a stub `clipboardData`, dispatched on the editor, which is
 * what a browser sends. Cmd/Ctrl+Shift+V is the same event with Shift held.
 */
import { EditorView as CodeMirrorView } from "@codemirror/view";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import { undo } from "@tiptap/pm/history";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, editorBox, openApp, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";
import { setDefaultEditorMode } from "@thoth/app-ui/editor/mode.ts";
import { findUrls, pastedLink } from "@thoth/app-ui/editor/paste-links.ts";

const dirs = tempDirs();
let root: string;

// The odd spacing and bullets are there to show that untouched blocks keep their bytes.
const PAGE = `# Paste

First paragraph here.

* odd bullet one
* odd bullet two

Second   paragraph  kept.

Use \`npm run\` now.

\`\`\`sh
echo  hi
\`\`\`

Last paragraph   
`;

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Page.md": PAGE });
});
afterEach(async () => {
  setDefaultEditorMode("blocks");
  localStorage.clear();
  cleanup();
  await dirs.cleanup();
});

type Box = HTMLElement & { editor?: Editor };

async function openPage() {
  const app = await openApp(root);
  await app.user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: "Page" }));
  const box = await editorBox();
  await waitFor(() => expect(box.textContent).not.toBe(""));
  const editor = (box as Box).editor!;
  const saved = async (expected: string) => {
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(async () => expect(await app.read("Page.md")).toBe(expected));
  };
  return { app, box, editor, saved };
}

/** Selects `text` (or puts the caret after it with `caret`) inside one text block, with focus in the editor. */
function select(editor: Editor, text: string, caret: "select" | "after" | "inside" = "select"): void {
  let from = -1;
  editor.state.doc.descendants((node, pos) => {
    if (from >= 0 || !node.isTextblock) return;
    const i = node.textContent.indexOf(text);
    if (i >= 0) from = pos + 1 + i;
  });
  if (from < 0) throw new Error(`"${text}" not in the document`);
  editor.view.focus();
  const sel = caret === "select" ? TextSelection.create(editor.state.doc, from, from + text.length) : TextSelection.create(editor.state.doc, caret === "after" ? from + text.length : from + 2);
  editor.view.dispatch(editor.state.tr.setSelection(sel));
}

/** A new empty paragraph after the one holding `text`, with the caret in it. */
async function newParagraphAfter(ctx: Awaited<ReturnType<typeof openPage>>, text: string) {
  select(ctx.editor, text, "after");
  await ctx.app.user.keyboard("{Enter}");
}

/** What a browser sends for Cmd/Ctrl+V (and, with `shift`, Cmd/Ctrl+Shift+V). */
function paste(target: HTMLElement, data: { text?: string; html?: string }, shift = false): void {
  if (shift) target.dispatchEvent(new KeyboardEvent("keydown", { key: "V", code: "KeyV", keyCode: 86, metaKey: true, shiftKey: true, bubbles: true }));
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? (data.text ?? "") : type === "text/html" ? (data.html ?? "") : "") } });
  target.dispatchEvent(event);
  if (shift) target.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft", keyCode: 16, metaKey: true, shiftKey: false, bubbles: true }));
}

describe("finding links in pasted text (GitHub's rules)", () => {
  it("finds bare http(s) and www. links and leaves trailing punctuation out", () => {
    const found = (text: string) => findUrls(text).map((u) => [text.slice(u.from, u.to), u.href]);
    expect(found("See https://example.com/a, and (www.example.org/x). Done.")).toEqual([
      ["https://example.com/a", "https://example.com/a"],
      ["www.example.org/x", "https://www.example.org/x"],
    ]);
    expect(found("Go to https://en.wikipedia.org/wiki/Thoth_(god)! or http://a.example/b?c=d&e=f.")).toEqual([
      ["https://en.wikipedia.org/wiki/Thoth_(god)", "https://en.wikipedia.org/wiki/Thoth_(god)"],
      ["http://a.example/b?c=d&e=f", "http://a.example/b?c=d&e=f"],
    ]);
    expect(found("https://a.example/x.:!?*_~")).toEqual([["https://a.example/x", "https://a.example/x"]]);
    expect(found("https://a.example/&amp;")).toEqual([["https://a.example/", "https://a.example/"]]);
    expect(found("*https://a.example/x* and http://127.0.0.1:8080/page")).toEqual([
      ["https://a.example/x", "https://a.example/x"],
      ["http://127.0.0.1:8080/page", "http://127.0.0.1:8080/page"],
    ]);
    // Not links: no domain with a dot, a word that only contains `www.`, other schemes, e-mail addresses.
    expect(found("http://localhost:3000 xwww.example.com javascript:alert(1) ftp://a.example/ file:///etc/passwd a@b.example")).toEqual([]);
  });

  it("knows a paste that is one link: http(s), www. or mailto, nothing else", () => {
    expect(pastedLink(" https://example.com/a?b#c\n")).toBe("https://example.com/a?b#c");
    expect(pastedLink("www.example.com")).toBe("https://www.example.com");
    expect(pastedLink("mailto:a@b.example")).toBe("mailto:a@b.example");
    for (const text of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "vbscript:x", "https://example.com/ and more", "https://example.com/.", "example.com", "", "https://exa\u0000mple.com/"]) {
      expect(pastedLink(text), text).toBeNull();
    }
  });
});

describe("pasting in Blocks mode", () => {
  it("one URL with no selection inserts a link whose text is the URL", async () => {
    const ctx = await openPage();
    await newParagraphAfter(ctx, "First paragraph here.");
    paste(ctx.editor.view.dom, { text: "https://example.com/a_b" });
    await ctx.saved(PAGE.replace("First paragraph here.\n", "First paragraph here.\n\n<https://example.com/a_b>\n"));
  });

  it("one URL over selected text links that text", async () => {
    const ctx = await openPage();
    select(ctx.editor, "paragraph here");
    paste(ctx.editor.view.dom, { text: "https://example.com/docs" });
    await ctx.saved(PAGE.replace("paragraph here", "[paragraph here](https://example.com/docs)"));
  });

  it("text with URLs links each URL and keeps the rest as text, trailing punctuation outside", async () => {
    const ctx = await openPage();
    await newParagraphAfter(ctx, "First paragraph here.");
    paste(ctx.editor.view.dom, { text: "See https://example.com/a, and (www.example.org/x). Done." });
    await ctx.saved(PAGE.replace("First paragraph here.\n", "First paragraph here.\n\nSee <https://example.com/a>, and ([www.example.org/x](https://www.example.org/x)). Done.\n"));
  });

  it("several lines become paragraphs, each with its links", async () => {
    const ctx = await openPage();
    await newParagraphAfter(ctx, "First paragraph here.");
    paste(ctx.editor.view.dom, { text: "one https://a.example/1\ntwo\nhttps://b.example/2" });
    await ctx.saved(PAGE.replace("First paragraph here.\n", "First paragraph here.\n\none <https://a.example/1>\n\ntwo\n\n<https://b.example/2>\n"));
  });

  it("one undo step turns the link back into the pasted text, the next removes it", async () => {
    const ctx = await openPage();
    await newParagraphAfter(ctx, "First paragraph here.");
    paste(ctx.editor.view.dom, { text: "https://example.com/a" });
    expect(undo(ctx.editor.state, ctx.editor.view.dispatch)).toBe(true);
    await ctx.saved(PAGE.replace("First paragraph here.\n", "First paragraph here.\n\nhttps://example.com/a\n"));
    undo(ctx.editor.state, ctx.editor.view.dispatch);
    await waitFor(() => expect(ctx.editor.state.doc.textContent).not.toContain("example.com"));
  });

  it("undo after linking a selection gives the URL pasted over it, as text", async () => {
    const ctx = await openPage();
    select(ctx.editor, "paragraph here");
    paste(ctx.editor.view.dom, { text: "https://example.com/docs" });
    undo(ctx.editor.state, ctx.editor.view.dispatch);
    await ctx.saved(PAGE.replace("paragraph here", "https://example.com/docs"));
    undo(ctx.editor.state, ctx.editor.view.dispatch);
    await ctx.saved(PAGE);
  });

  it("undo after mixed text keeps the text and drops its links", async () => {
    const ctx = await openPage();
    await newParagraphAfter(ctx, "First paragraph here.");
    paste(ctx.editor.view.dom, { text: "See https://example.com/a now" });
    undo(ctx.editor.state, ctx.editor.view.dispatch);
    await ctx.saved(PAGE.replace("First paragraph here.\n", "First paragraph here.\n\nSee https://example.com/a now\n"));
  });

  it("nothing changes inside a code block or inline code", async () => {
    const ctx = await openPage();
    select(ctx.editor, "echo  hi", "after");
    paste(ctx.editor.view.dom, { text: " https://example.com/x" });
    select(ctx.editor, "npm run", "inside");
    paste(ctx.editor.view.dom, { text: "https://example.com/y" });
    await ctx.saved(PAGE.replace("echo  hi", "echo  hi https://example.com/x").replace("`npm run`", "`nphttps://example.com/ym run`"));
  });

  it("Cmd/Ctrl+Shift+V pastes plain text with no linking", async () => {
    const ctx = await openPage();
    await newParagraphAfter(ctx, "First paragraph here.");
    paste(ctx.editor.view.dom, { text: "https://example.com/a" }, true);
    select(ctx.editor, "paragraph here");
    paste(ctx.editor.view.dom, { text: "https://example.com/b" }, true);
    await ctx.saved(PAGE.replace("First paragraph here.\n", "First https://example.com/b.\n\nhttps://example.com/a\n"));
  });

  it("only http, https and mailto become links", async () => {
    const ctx = await openPage();
    await newParagraphAfter(ctx, "First paragraph here.");
    paste(ctx.editor.view.dom, { text: "javascript:alert(1)" });
    select(ctx.editor, "paragraph here");
    paste(ctx.editor.view.dom, { text: "data:text/html,<script>alert(1)</script>" });
    select(ctx.editor, "Second", "select");
    paste(ctx.editor.view.dom, { text: "mailto:a@b.example" });
    const text = await (async () => {
      await ctx.app.user.keyboard("{Meta>}s{/Meta}");
      await waitFor(async () => expect(await ctx.app.read("Page.md")).not.toBe(PAGE));
      return ctx.app.read("Page.md");
    })();
    expect(text).toContain("javascript:alert(1)");
    expect(text).not.toMatch(/\]\(javascript:|<javascript:|\]\(data:|<data:/);
    expect(text).toContain("[Second](mailto:a@b.example)");
  });

  it("pasted HTML keeps its web links and loses any other", async () => {
    const ctx = await openPage();
    await newParagraphAfter(ctx, "First paragraph here.");
    paste(ctx.editor.view.dom, { text: "ok bad file", html: '<a href="https://ok.example/">ok</a> <a href="javascript:alert(1)">bad</a> <a href="file:///etc/passwd">file</a>' });
    await ctx.saved(PAGE.replace("First paragraph here.\n", "First paragraph here.\n\n[ok](https://ok.example/) bad file\n"));
  });

  it("pasting text with no link is an ordinary paste", async () => {
    const ctx = await openPage();
    select(ctx.editor, "paragraph here");
    paste(ctx.editor.view.dom, { text: "words only" });
    await ctx.saved(PAGE.replace("paragraph here", "words only"));
  });
});

describe("pasting in Plain mode", () => {
  it("inserts the text unchanged: no link syntax is added", async () => {
    setDefaultEditorMode("plain");
    const app = await openApp(root);
    await app.user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: "Page" }));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("First paragraph"));
    const view = CodeMirrorView.findFromDOM(box.closest(".cm-editor") as HTMLElement)!;
    const at = view.state.doc.toString().indexOf("First paragraph here.") + "First paragraph here.".length;
    view.dispatch({ selection: { anchor: at } });
    view.focus();
    paste(view.contentDOM, { text: " https://example.com/a" });
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(async () => expect(await app.read("Page.md")).toBe(PAGE.replace("First paragraph here.", "First paragraph here. https://example.com/a")));
  });
});
