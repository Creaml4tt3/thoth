// @vitest-environment jsdom
/**
 * Copy text / Insert text below on an image (ADR-0055): the block menu offers them only where the app has OCR; Copy puts
 * the text on the clipboard, Insert adds one paragraph per line after the image as one undo step, "Try the other model"
 * replaces what Insert added, "not installed" offers Settings and never downloads, Cancel changes nothing, and a web
 * image or one that is not loaded has the items disabled. OCR itself is a fake here; the host runs the real one.
 */
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { undo } from "@tiptap/pm/history";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docToMarkdown, markdownToDoc } from "@thoth/editor";
import { createEditorContext, type EditorContext, type OcrResult } from "../src/editor/context.ts";
import { createEditorExtensions } from "../src/editor/extensions.ts";
import type { PageMedia } from "../src/editor/media.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const media: PageMedia = {
  load: async (src) => (src.startsWith("http") ? { state: "remote", url: src } : src === "gone.png" ? { state: "missing" } : { state: "ready", bytes: PNG, mimeType: "image/png" }),
};

let editor: Editor;
let copied: string[];
afterEach(() => {
  editor?.destroy();
  for (const m of document.querySelectorAll(".block-menu")) m.remove();
  document.body.replaceChildren();
});
beforeEach(() => {
  copied = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
});

type Ocr = NonNullable<EditorContext["ocr"]>;

function setup(md: string, ocr?: Ocr, extra: Partial<Parameters<typeof createEditorContext>[0]> = {}): Editor {
  const ctx = createEditorContext({ lookup: () => ({}) as never, suggester: () => ({}) as never, openPage: () => {}, media: () => media, ...(ocr ? { ocr } : {}), ...extra });
  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({ element, extensions: createEditorExtensions(ctx), content: markdownToDoc(md).doc });
  return editor;
}

/** Selects the first image and opens the block menu with its shortcut. */
function openMenuOnImage(): HTMLElement {
  let pos = -1;
  editor.state.doc.descendants((node, at) => {
    if (pos < 0 && node.type.name === "image") pos = at;
  });
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key: "m", code: "KeyM", ctrlKey: true, altKey: true })));
  const menu = document.querySelector<HTMLElement>('.block-menu[aria-label="Block menu"]');
  if (!menu || menu.hidden) throw new Error("no block menu");
  return menu;
}

const item = (menu: HTMLElement, name: string) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.includes(name));
const status = () => document.querySelector<HTMLElement>(".image-ocr-status");
const md = () => docToMarkdown(editor.getJSON());
const done = (text: string, model: "fast" | "second" = "fast"): OcrResult => ({ state: "done", model, text });

describe("Copy text and Insert text below", () => {
  it("the image menu has Copy text and Insert text below only where ocr exists", () => {
    setup("![Receipt](receipt.png)\n");
    expect(item(openMenuOnImage(), "Copy text")).toBeUndefined();
    editor.destroy();
    setup("![Receipt](receipt.png)\n", async () => done("x"));
    const menu = openMenuOnImage();
    expect(item(menu, "Copy text")).toBeTruthy();
    expect(item(menu, "Insert text below")).toBeTruthy();
  });

  it("copy puts the text on the clipboard", async () => {
    const ocr = vi.fn(async () => done("Total 1,290 บาท"));
    setup("![Receipt](receipt.png)\n", ocr);
    item(openMenuOnImage(), "Copy text")!.click();
    await vi.waitFor(() => expect(copied).toEqual(["Total 1,290 บาท"]));
    expect(ocr).toHaveBeenCalledWith({ bytes: PNG, mimeType: "image/png" }, undefined);
    await vi.waitFor(() => expect(status()?.textContent).toContain("Text copied"));
    expect(status()?.getAttribute("aria-live")).toBe("polite");
  });

  it("insert adds one paragraph per line after the image as one undo step", async () => {
    setup("![Receipt](receipt.png)\n\nAfter\n", async () => done("Line one\nบรรทัดสอง"));
    item(openMenuOnImage(), "Insert text below")!.click();
    await vi.waitFor(() => expect(md()).toBe("![Receipt](receipt.png)\n\nLine one\n\nบรรทัดสอง\n\nAfter\n"));
    undo(editor.state, editor.view.dispatch);
    expect(md()).toBe("![Receipt](receipt.png)\n\nAfter\n");
  });

  it("says when no text was found", async () => {
    setup("![Photo](cat.png)\n", async () => done(""));
    item(openMenuOnImage(), "Insert text below")!.click();
    await vi.waitFor(() => expect(status()?.textContent).toContain("No text found in this image"));
    expect(md()).toBe("![Photo](cat.png)\n");
  });

  it("try the other model replaces the inserted text", async () => {
    const ocr = vi.fn(async (_image: unknown, model?: "fast" | "second") => (model === "second" ? done("Second read", "second") : done("Frist read")));
    setup("![Receipt](receipt.png)\n\nAfter\n", ocr, { ocrModels: () => ["fast", "second"] });
    item(openMenuOnImage(), "Insert text below")!.click();
    await vi.waitFor(() => expect(md()).toContain("Frist read"));
    const other = [...status()!.querySelectorAll("button")].find((b) => b.textContent === "Try the other model")!;
    other.click();
    await vi.waitFor(() => expect(md()).toBe("![Receipt](receipt.png)\n\nSecond read\n\nAfter\n"));
    expect(ocr).toHaveBeenLastCalledWith(expect.anything(), "second");
  });

  it("not installed offers Settings and never calls install", async () => {
    const openModules = vi.fn();
    const ocr = vi.fn(async (): Promise<OcrResult> => ({ state: "not-installed" }));
    setup("![Receipt](receipt.png)\n", ocr, { openModules });
    item(openMenuOnImage(), "Copy text")!.click();
    await vi.waitFor(() => expect(status()?.textContent).toContain("OCR isn't downloaded yet"));
    expect(ocr).toHaveBeenCalledTimes(1);
    [...status()!.querySelectorAll("button")].find((b) => b.textContent === "Open Settings")!.click();
    expect(openModules).toHaveBeenCalledTimes(1);
    expect(copied).toEqual([]);
  });

  it("cancel stops and says nothing was changed", async () => {
    let finish: (r: OcrResult) => void = () => {};
    const cancelOcr = vi.fn(() => finish({ state: "cancelled" }));
    setup("![Receipt](receipt.png)\n", () => new Promise<OcrResult>((r) => (finish = r)), { cancelOcr });
    item(openMenuOnImage(), "Insert text below")!.click();
    await vi.waitFor(() => expect(status()?.textContent).toContain("Reading text…"));
    [...status()!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
    expect(cancelOcr).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(status()?.textContent).toContain("Nothing was changed"));
    expect(md()).toBe("![Receipt](receipt.png)\n");
  });

  it("a web image disables the items", async () => {
    setup("![Logo](https://example.org/logo.png)\n", async () => done("x"));
    const menu = openMenuOnImage();
    for (const name of ["Copy text", "Insert text below"]) {
      expect(item(menu, name)!.getAttribute("aria-disabled")).toBe("true");
      expect(item(menu, name)!.textContent).toContain("Web images are not read");
    }
  });

  it("each failure says what happened", async () => {
    const seen = new Set<string>();
    for (const reason of ["too-large", "bad-file", "timeout", "failed"] as const) {
      setup("![Receipt](receipt.png)\n", async () => ({ state: "failed", reason }));
      item(openMenuOnImage(), "Copy text")!.click();
      await vi.waitFor(() => expect(status()?.textContent).not.toMatch(/Reading text/));
      seen.add(status()!.textContent!);
      editor.destroy();
      document.body.replaceChildren();
    }
    expect(seen.size).toBe(4);
  });
});
