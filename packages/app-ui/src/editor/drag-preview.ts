/**
 * The picture under the pointer while a block is dragged by its handle: a small card with the block's kind icon (as
 * the `/` and Turn into menus show it) and the start of its text, or the kind's name for a block without text. Several
 * blocks say how many. The browser's own picture is a copy of the whole block: huge for a long one, cut off, away from
 * the pointer, or blank in some webviews.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorStrings } from "../strings/en.ts";
import { kindOfBlock } from "./block-ops.ts";
import { kindInfo, localizedBlockKinds } from "./block-kinds.ts";

/** About this many characters of text on the card, ellipsis included. */
export const EXCERPT_LENGTH = 60;

/** Where the pointer is on the card (CSS px from its top left): on its left edge, at the middle of the line. */
export const POINTER = { x: 4, y: 16 };

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** `text` on one line, cut to `max` characters with an ellipsis. Counts whole characters, so a Thai vowel or tone mark stays with its letter. */
export function excerpt(text: string, max = EXCERPT_LENGTH): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = segmenter ? Array.from(segmenter.segment(flat), (s) => s.segment) : Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

export interface DragPreviewContent {
  icon: string;
  text: string;
  /** True for an image block: the card shows its picture when it has loaded. */
  image: boolean;
}

/** What the card says for `blocks` (each with the node that holds it, for list kinds). */
export function dragPreviewContent(blocks: readonly { node: PMNode; parent: PMNode | null }[], strings: EditorStrings): DragPreviewContent {
  if (blocks.length !== 1) return { icon: "⧉", text: strings.dragBlocks(blocks.length), image: false };
  const { node, parent } = blocks[0]!;
  const kind = kindOfBlock(node, parent);
  const name = node.type.name;
  const icon = kind ? kindInfo(kind).icon : name === "image" ? "▣" : name === "table" ? "▦" : "¶";
  const text = excerpt(node.textContent);
  if (text) return { icon, text, image: false };
  const title = kind ? localizedBlockKinds(strings.blocks).find((k) => k.kind === kind)!.title : name === "image" ? strings.image.slash.title : name === "table" ? strings.dragTable : strings.dragBlock;
  return { icon, text: title, image: name === "image" };
}

/**
 * Builds the card, in the document and painted (WebKit and WebView2 take no picture of an element that is not), off
 * screen. `picture` is the image block's loaded `<img>`, drawn small. The caller removes it once the drag has begun.
 */
export function createDragPreview(content: DragPreviewContent, picture: HTMLImageElement | null, host: HTMLElement = document.body): HTMLElement {
  const card = document.createElement("div");
  card.className = "block-drag-preview";
  card.setAttribute("aria-hidden", "true");
  const icon = document.createElement("span");
  icon.className = "block-drag-icon";
  icon.textContent = content.icon;
  card.append(icon);
  if (content.image && picture?.complete && picture.naturalWidth > 0) {
    const thumb = document.createElement("canvas");
    thumb.className = "block-drag-thumb";
    const ratio = window.devicePixelRatio || 1;
    thumb.width = thumb.height = Math.round(24 * ratio);
    const scale = Math.max(thumb.width / picture.naturalWidth, thumb.height / picture.naturalHeight);
    const w = picture.naturalWidth * scale;
    const h = picture.naturalHeight * scale;
    try {
      thumb.getContext("2d")?.drawImage(picture, (thumb.width - w) / 2, (thumb.height - h) / 2, w, h);
      card.append(thumb);
    } catch {
      // no picture: the card still names the image
    }
  }
  const text = document.createElement("span");
  text.className = "block-drag-text";
  text.textContent = content.text;
  card.append(text);
  host.append(card);
  return card;
}
