// @vitest-environment jsdom
/**
 * The card under the pointer while a block is dragged (drag-preview.ts) and the caret scroll of caret-scroll.ts, as
 * pure code. A real drag and real scrolling run in tests/e2e (block-drag.e2e.ts, editor-scroll.e2e.ts): jsdom has no
 * layout and no drag.
 */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownToDoc, thothExtensions, thothSchema } from "@thoth/editor";
import type { Node as PMNode } from "@tiptap/pm/model";
import { en } from "../src/strings/en.ts";
import { th } from "../src/strings/th.ts";
import { blockHandleExtension } from "../src/editor/block-handle.ts";
import { EXCERPT_LENGTH, createDragPreview, dragPreviewContent, excerpt } from "../src/editor/drag-preview.ts";
import { revealDelta } from "../src/editor/caret-scroll.ts";

const schema = thothSchema();
const doc = (source: string): PMNode => schema.nodeFromJSON(markdownToDoc(source).doc);
/** The top-level blocks of `source`, as the handle sees them (a list item with its list as parent). */
const blocks = (source: string) => {
  const out: { node: PMNode; parent: PMNode | null }[] = [];
  doc(source).forEach((node) => {
    if (node.type.name === "list") node.forEach((item) => out.push({ node: item, parent: node }));
    else out.push({ node, parent: null });
  });
  return out;
};

describe("excerpt", () => {
  it("keeps short text as it is, on one line", () => {
    expect(excerpt("  Birds   excrete\nnitrogen ")).toBe("Birds excrete nitrogen");
  });
  it("cuts long English text to about 60 characters with an ellipsis", () => {
    const long = "The quick brown fox jumps over the lazy dog and keeps on running far away";
    const cut = excerpt(long);
    expect(cut.endsWith("…")).toBe(true);
    expect(Array.from(cut).length).toBeLessThanOrEqual(EXCERPT_LENGTH);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
  });
  it("cuts Thai text between whole characters, never between a letter and its vowel or tone mark", () => {
    const thai = "นกขับถ่ายไนโตรเจนออกมาในรูปของกรดยูริก ".repeat(4);
    const cut = excerpt(thai);
    expect(cut.endsWith("…")).toBe(true);
    const body = cut.slice(0, -1);
    expect(thai.startsWith(body)).toBe(true);
    // The next character of the source after the cut is not a combining mark left behind.
    expect(/^[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/u.test(thai.slice(body.length))).toBe(false);
    const graphemes = Array.from(new Intl.Segmenter("th", { granularity: "grapheme" }).segment(cut));
    expect(graphemes.length).toBeLessThanOrEqual(EXCERPT_LENGTH);
  });
  it("is empty for an empty block", () => {
    expect(excerpt(" \n ")).toBe("");
  });
});

describe("dragPreviewContent", () => {
  it("shows the kind icon and the start of the text", () => {
    const [heading, para, bullet, numbered] = [...blocks("# Birds\n\nBirds excrete nitrogen.\n\n- one\n"), ...blocks("1. first\n")];
    expect(dragPreviewContent([heading!], en.editor)).toEqual({ icon: "H1", text: "Birds", image: false });
    expect(dragPreviewContent([para!], en.editor)).toEqual({ icon: "T", text: "Birds excrete nitrogen.", image: false });
    expect(dragPreviewContent([bullet!], en.editor)).toEqual({ icon: "•", text: "one", image: false });
    expect(dragPreviewContent([numbered!], en.editor)).toEqual({ icon: "1.", text: "first", image: false });
  });
  it("names a block with no text by its kind, in the UI language", () => {
    const [divider, image] = blocks("---\n\n![](bird.png)\n");
    const empty = { node: schema.nodes["paragraph"]!.create(), parent: null };
    expect(dragPreviewContent([divider!], en.editor)).toEqual({ icon: "—", text: "Divider", image: false });
    expect(dragPreviewContent([divider!], th.editor).text).toBe(th.editor.blocks.divider.title);
    expect(dragPreviewContent([image!], en.editor)).toEqual({ icon: "▣", text: "Image", image: true });
    expect(dragPreviewContent([image!], th.editor).text).toBe(th.editor.image.slash.title);
    expect(dragPreviewContent([empty], en.editor)).toEqual({ icon: "T", text: "Text", image: false });
    expect(dragPreviewContent([empty], th.editor).text).toBe(th.editor.blocks.text.title);
  });
  it("says a table is a table when it has no text, and shows its text when it has", () => {
    const [table] = blocks("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(dragPreviewContent([table!], en.editor)).toMatchObject({ icon: "▦", text: "ab12" });
    const empty = schema.nodes["table"]!.createAndFill();
    if (empty) expect(dragPreviewContent([{ node: empty, parent: null }], en.editor).text).toBe("Table");
  });
  it("cuts long Thai text", () => {
    const [para] = blocks(`${"กรดยูริกเป็นของเสียที่นกขับออกมา ".repeat(5)}\n`);
    const { text } = dragPreviewContent([para!], th.editor);
    expect(text.endsWith("…")).toBe(true);
  });
  it("says how many blocks for several", () => {
    const all = blocks("one\n\ntwo\n\nthree\n");
    expect(dragPreviewContent(all, en.editor)).toEqual({ icon: "⧉", text: "3 blocks", image: false });
    expect(dragPreviewContent(all, th.editor).text).toBe("3 บล็อก");
  });
});

describe("createDragPreview", () => {
  afterEach(() => document.body.replaceChildren());
  it("is in the document, hidden from assistive technology, with the icon and the text", () => {
    const card = createDragPreview({ icon: "T", text: "Birds", image: false }, null);
    expect(card.isConnected).toBe(true);
    expect(card.getAttribute("aria-hidden")).toBe("true");
    expect(card.querySelector(".block-drag-icon")?.textContent).toBe("T");
    expect(card.querySelector(".block-drag-text")?.textContent).toBe("Birds");
    expect(card.querySelector("canvas")).toBeNull();
  });
});

describe("the handle's drag", () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  /** An editor over `source` with the handle shown on its first block (jsdom has no layout, so the pointer's block is given). */
  function setup(source: string) {
    const host = document.createElement("div");
    host.className = "editor-surface";
    document.body.append(host);
    const element = document.createElement("div");
    host.append(element);
    editor = new Editor({ element, extensions: [...thothExtensions(), blockHandleExtension(en.editor)], content: markdownToDoc(source).doc });
    const view = editor.view;
    view.posAtCoords = () => ({ pos: 1, inside: 0 });
    view.dom.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 10 }));
    const handle = host.querySelector<HTMLElement>(".block-handle")!;
    expect(handle.hidden).toBe(false);
    return { view, handle };
  }

  const drag = (handle: HTMLElement, type: string) => {
    const setDragImage = vi.fn();
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { setData: vi.fn(), setDragImage, effectAllowed: "", dropEffect: "" } });
    handle.dispatchEvent(event);
    return setDragImage;
  };

  it("gives the browser the card, with the pointer at its left edge, and the handle keeps its name", () => {
    const { handle } = setup("Birds excrete nitrogen as uric acid.\n\nSecond.\n");
    const setDragImage = drag(handle, "dragstart");
    expect(setDragImage).toHaveBeenCalledTimes(1);
    const [card, x, y] = setDragImage.mock.calls[0]! as [HTMLElement, number, number];
    expect(card.isConnected).toBe(true);
    expect(card.textContent).toBe("TBirds excrete nitrogen as uric acid.");
    expect(x).toBeLessThan(8);
    expect(y).toBeGreaterThan(0);
    expect(handle.getAttribute("aria-label")).toBe(en.editor.handleLabel);
  });

  it("leaves no card behind once the drag has begun, after a drop's dragend, or after a cancelled drag", () => {
    vi.useFakeTimers();
    const { view, handle } = setup("First.\n\nSecond.\n");
    drag(handle, "dragstart");
    expect(document.querySelectorAll(".block-drag-preview")).toHaveLength(1);
    expect(view.dom.classList.contains("is-block-dragging")).toBe(true);
    vi.runAllTimers();
    expect(document.querySelectorAll(".block-drag-preview")).toHaveLength(0);
    // Escape: the browser ends the drag with a dragend and no drop.
    drag(handle, "dragend");
    expect(view.dom.classList.contains("is-block-dragging")).toBe(false);

    drag(handle, "dragstart");
    drag(handle, "dragend"); // before the timer: dragend removes it too
    expect(document.querySelectorAll(".block-drag-preview")).toHaveLength(0);
    vi.runAllTimers();
    expect(document.querySelectorAll(".block-drag-preview")).toHaveLength(0);
  });
});

describe("revealDelta", () => {
  const area = { top: 100, bottom: 700 };
  it("does not scroll when the caret is inside, away from the edges", () => {
    expect(revealDelta({ top: 400, bottom: 420 }, area)).toBe(0);
  });
  it("scrolls down just enough when the caret passes the bottom", () => {
    expect(revealDelta({ top: 690, bottom: 710 }, area, 32)).toBe(710 - (700 - 32));
  });
  it("scrolls up just enough when the caret passes the top", () => {
    expect(revealDelta({ top: 90, bottom: 110 }, area, 32)).toBe(90 - (100 + 32));
  });
  it("keeps the top of a caret taller than the room in view", () => {
    expect(revealDelta({ top: 650, bottom: 1400 }, area, 32)).toBe(0 + 650 - 100);
  });
});
