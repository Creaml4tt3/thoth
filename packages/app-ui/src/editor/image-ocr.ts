/**
 * Copy text / Insert text below on an image (ADR-0055). The bytes come from the page's media, the host reads them
 * (`ctx.ocr`); nothing is downloaded from here: "not installed" only offers Settings → Modules. A toast (a polite
 * live region) says what is happening, with Cancel while reading and "Try the other model" after.
 * Insert adds one paragraph per line after the image as one undo step; the other model replaces what Insert added.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { applyAsOneStep } from "./block-ops.ts";
import type { EditorContext, OcrResult } from "./context.ts";
import { copyText } from "../ui/clipboard.ts";
import { toast } from "../ui/toast.ts";

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

type Kind = "info" | "success" | "error" | "loading";

interface Status {
  say(text: string, buttons?: { label: string; onClick(): void }[], kind?: Kind): void;
}

let nextId = 0;

/** One toast per read: each step updates it in place (Reading… → Text copied), Ding's way. */
function statusFor(ctx: EditorContext): Status {
  const id = `image-ocr-${++nextId}`;
  return {
    say(text, buttons = [], kind = "info") {
      toast(text, { id, kind, actions: buttons, closeLabel: ctx.strings.image.dismiss });
    },
  };
}

/**
 * A clipboard write begun now whose text comes later (WebKit's way to copy what an async task returns): `give(text)`
 * finishes it and answers whether it worked; `give(null)` drops it. Null where the async clipboard has no ClipboardItem.
 */
function startCopy(): { give(text: string | null): Promise<boolean> } | null {
  if (typeof ClipboardItem === "undefined" || typeof navigator.clipboard?.write !== "function") return null;
  let settle: (text: string | null) => void = () => {};
  const blob = new Promise<Blob>((resolve, reject) => {
    settle = (text) => (text === null ? reject(new Error("nothing to copy")) : resolve(new Blob([text], { type: "text/plain" })));
  });
  let written: Promise<boolean>;
  try {
    written = navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]).then(
      () => true,
      () => false,
    );
  } catch {
    written = Promise.resolve(false);
  }
  return {
    give(text) {
      settle(text);
      return written;
    },
  };
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
  const status = statusFor(ctx);
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
    // Started here, inside the click: WebKit refuses a clipboard write begun after the read's seconds have passed.
    const copy = mode === "copyText" ? startCopy() : null;
    // Cancel may come before the host has started the program: the answer is dropped whatever it is.
    let cancelled = false;
    const cancel = (): void => {
      cancelled = true;
      ctx.cancelOcr?.();
      status.say(t.cancelled);
    };
    status.say(t.reading, [{ label: t.cancel, onClick: cancel }], "loading");
    let result: OcrResult;
    try {
      const loaded = await ctx.media()?.load(image.attrs["src"] as string);
      if (cancelled) return;
      if (!loaded || loaded.state !== "ready") return status.say(t.notLoadedNoOcr, [], "error");
      result = await ocr({ bytes: loaded.bytes, mimeType: loaded.mimeType }, model);
    } catch {
      result = { state: "failed", reason: "failed" };
    }
    if (cancelled || result.state !== "done" || result.text.trim() === "") copy?.give(null);
    if (cancelled) return;
    switch (result.state) {
      case "not-installed":
        return status.say(t.notInstalled, ctx.openModules ? [{ label: t.openSettings, onClick: () => ctx.openModules?.() }] : [], "error");
      case "cancelled":
        return status.say(t.cancelled);
      case "failed":
        return status.say(t.ocrFailed[result.reason], [], "error");
    }
    const other: Model = result.model === "fast" ? "second" : "fast";
    const retry = ctx.ocrModels?.().includes(other) ? [{ label: t.otherModel, onClick: () => void read(other) }] : [];
    if (result.text.trim() === "") return status.say(t.noText, retry, "info");
    if (mode === "copyText") {
      try {
        if (!copy || !(await copy.give(result.text))) await copyText(result.text);
      } catch {
        // The text was read; only the clipboard refused it. Offer it under the image instead of losing it.
        return status.say(t.copyFailed, view.editable ? [{ label: t.insertText, onClick: () => insert(result.text) }, ...retry] : retry, "error");
      }
      return status.say(t.copied, retry, "success");
    }
    if (!view.editable) return status.say(t.ocrFailed.failed, [], "error");
    insert(result.text);
    status.say(t.inserted, retry, "success");
  };

  void read();
}
