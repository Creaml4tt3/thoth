/**
 * Copy text / Insert text below on an image (ADR-0055). The bytes come from the page's media, the host reads them
 * (`ctx.ocr`); nothing is downloaded from here: "not installed" only offers Settings → Modules. A status line under the
 * editor (a polite live region) says what is happening, with Cancel while reading and "Try the other model" after.
 * Insert adds one paragraph per line after the image as one undo step; the other model replaces what Insert added.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { applyAsOneStep } from "./block-ops.ts";
import type { EditorContext, OcrResult } from "./context.ts";
import { copyText } from "../ui/clipboard.ts";

type Model = "fast" | "second";
type Mode = "copyText" | "insertText";

/** Why Copy text / Insert text below are disabled on this image, or true when they can run. */
export function ocrState(ctx: EditorContext, view: EditorView, pos: number, node: PMNode): true | string {
  const t = ctx.strings.image;
  if (/^\s*https?:/i.test(String(node.attrs["src"] ?? ""))) return t.remoteNoOcr;
  const dom = view.nodeDOM(pos);
  const state = dom instanceof HTMLElement ? dom.dataset["imageState"] : undefined;
  return state === undefined || state === "ready" || state === "loading" ? true : t.notLoadedNoOcr;
}

interface Status {
  el: HTMLElement;
  say(text: string, buttons?: { label: string; onClick(): void }[]): void;
}

const statuses = new WeakMap<EditorView, Status>();

function statusFor(view: EditorView, ctx: EditorContext): Status {
  const known = statuses.get(view);
  if (known?.el.isConnected) return known;
  const el = document.createElement("div");
  el.className = "image-ocr-status";
  el.setAttribute("aria-live", "polite");
  el.hidden = true;
  view.dom.parentElement?.append(el);
  const status: Status = {
    el,
    say(text, buttons = []) {
      const line = document.createElement("span");
      line.textContent = text;
      const all = [...buttons, { label: ctx.strings.image.dismiss, onClick: () => (el.hidden = true) }];
      el.replaceChildren(
        line,
        ...all.map((b) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "image-ocr-button";
          button.textContent = b.label;
          button.addEventListener("click", b.onClick);
          return button;
        }),
      );
      el.hidden = false;
    },
  };
  statuses.set(view, status);
  return status;
}

/** Where the image now is: the same node object, found again if the document moved it. */
function findNode(view: EditorView, node: PMNode, near: number): number | undefined {
  if (view.state.doc.nodeAt(near) === node) return near;
  let found: number | undefined;
  view.state.doc.descendants((n, at) => {
    if (found === undefined && n === node) found = at;
    return found === undefined;
  });
  return found;
}

/** Reads the image's text and copies it, or inserts it under the image. */
export function runImageOcr(ctx: EditorContext, view: EditorView, pos: number, mode: Mode): void {
  const ocr = ctx.ocr;
  const image = view.state.doc.nodeAt(pos);
  if (!ocr || !image) return;
  const t = ctx.strings.image;
  const status = statusFor(view, ctx);
  /** The paragraphs the last Insert added, so the other model can replace them. */
  let added: PMNode[] = [];

  const insert = (text: string): void => {
    const at = findNode(view, image, pos);
    if (at === undefined) return;
    const after = at + image.nodeSize;
    const paragraph = view.state.schema.nodes["paragraph"]!;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
    const nodes = lines.map((l) => paragraph.create(null, view.state.schema.text(l)));
    // Only the paragraphs still there, untouched, are replaced; otherwise the new text goes in next to them.
    let end = after;
    for (const n of added) {
      if (view.state.doc.nodeAt(end) !== n) {
        end = after;
        break;
      }
      end += n.nodeSize;
    }
    applyAsOneStep(view, (tr) => {
      tr.replaceWith(after, end, nodes);
      return true;
    });
    added = [];
    let p = after;
    for (let i = 0; i < nodes.length; i++) {
      const n = view.state.doc.nodeAt(p);
      if (!n) break;
      added.push(n);
      p += n.nodeSize;
    }
  };

  const read = async (model?: Model): Promise<void> => {
    status.say(t.reading, ctx.cancelOcr ? [{ label: t.cancel, onClick: () => ctx.cancelOcr?.() }] : []);
    let result: OcrResult;
    try {
      const loaded = await ctx.media()?.load(image.attrs["src"] as string);
      if (!loaded || loaded.state !== "ready") return status.say(t.notLoadedNoOcr);
      result = await ocr({ bytes: loaded.bytes, mimeType: loaded.mimeType }, model);
    } catch {
      result = { state: "failed", reason: "failed" };
    }
    switch (result.state) {
      case "not-installed":
        return status.say(t.notInstalled, ctx.openModules ? [{ label: t.openSettings, onClick: () => ctx.openModules?.() }] : []);
      case "cancelled":
        return status.say(t.cancelled);
      case "failed":
        return status.say(t.ocrFailed[result.reason]);
    }
    const other: Model = result.model === "fast" ? "second" : "fast";
    const retry = ctx.ocrModels?.().includes(other) ? [{ label: t.otherModel, onClick: () => void read(other) }] : [];
    if (result.text.trim() === "") return status.say(t.noText, retry);
    if (mode === "copyText") {
      try {
        await copyText(result.text);
      } catch {
        return status.say(t.ocrFailed.failed, retry);
      }
      return status.say(t.copied, retry);
    }
    if (!view.editable) return status.say(t.ocrFailed.failed);
    insert(result.text);
    status.say(t.inserted, retry);
  };

  void read();
}
