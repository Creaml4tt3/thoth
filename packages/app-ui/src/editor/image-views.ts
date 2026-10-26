/**
 * Image and inline-image node views (ADR-0028). The `src` written in the page is never given to the DOM: the view
 * asks the page's space for the bytes (`ctx.media()`) and shows them from a `blob:` URL, revoked when the node goes
 * or its `src` changes. An SVG is therefore only ever an `<img>` from a blob URL, where its scripts do not run and it
 * loads nothing; its markup is never put into the page.
 *
 * - Loading: a quiet placeholder with the alt text, the image's last known height reserved.
 * - Missing or not loadable: a small placeholder naming the file ("Image not found: bird.svg"), never a broken image.
 * - A web (`http(s)`) image: not loaded; its alt text and address, as a link that opens in the browser.
 * - Alt text: "Edit alt text" in the block menu, or Enter on a selected image, opens a small field under it.
 */
import type { NodeViewRenderer } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { EditorContext } from "./context.ts";
import type { ImageLoad } from "./media.ts";

/** Dispatched on an image's DOM to open its alt text field (the block menu and the Enter key do). */
export const EDIT_ALT_EVENT = "thoth-edit-alt";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The file name an image's `src` names, for placeholders: decoded, without folders, query or fragment. */
export function imageDisplayName(src: string): string {
  const raw = src.trim();
  if (/^https?:/i.test(raw)) return raw;
  if (/^thoth:attachment\//.test(raw)) return raw;
  const bare = raw.replace(/[?#].*$/s, "");
  const last = bare.slice(bare.lastIndexOf("/") + 1) || bare;
  try {
    return decodeURIComponent(last) || raw;
  } catch {
    return last || raw;
  }
}

/** Heights of images already shown, by `src`, so a reload (mode switch, a changed file) keeps the page from jumping. */
const heights = new WeakMap<EditorContext, Map<string, number>>();
const heightsOf = (ctx: EditorContext): Map<string, number> => {
  let map = heights.get(ctx);
  if (!map) heights.set(ctx, (map = new Map()));
  return map;
};

let altIds = 0;

type Shown = ImageLoad | { state: "loading" };

export const imageView =
  (ctx: EditorContext, inline: boolean): NodeViewRenderer =>
  ({ node: initial, view, getPos }) => {
    let node: PMNode = initial;
    const t = ctx.strings.image;
    const dom = el(inline ? "span" : "div", inline ? "page-image is-inline" : "page-image");
    dom.setAttribute("contenteditable", "false");
    const frame = el("span", "page-image-frame");
    dom.append(frame);
    let url: string | null = null;
    let token = 0;
    let shown: Shown = { state: "loading" };
    let alive = true;
    let form: HTMLElement | null = null;

    const src = (): string => node.attrs["src"] as string;
    const alt = (): string => node.attrs["alt"] as string;
    const name = (): string => imageDisplayName(src());
    /** Every image has an accessible name: its alt text, else its file name. */
    const label = (): string => alt().trim() || t.unnamed(name());

    const release = (): void => {
      if (url) URL.revokeObjectURL(url);
      url = null;
    };

    const placeholder = (state: string, text: string, aria: string): HTMLElement => {
      const box = el("span", "page-image-placeholder");
      box.setAttribute("role", "img");
      box.setAttribute("aria-label", aria);
      box.title = aria;
      const icon = el("span", "page-image-icon", state === "loading" ? "" : "⌧");
      icon.setAttribute("aria-hidden", "true");
      box.append(icon, el("span", "page-image-text", text));
      return box;
    };

    const show = (next: Shown): void => {
      shown = next;
      release();
      dom.dataset["imageState"] = next.state;
      dom.removeAttribute("aria-busy");
      frame.style.minHeight = "";
      switch (next.state) {
        case "loading": {
          dom.setAttribute("aria-busy", "true");
          const known = heightsOf(ctx).get(src());
          if (known && !inline) frame.style.minHeight = `${known}px`;
          frame.replaceChildren(placeholder("loading", alt().trim() || name(), t.loading(alt().trim() || name())));
          return;
        }
        case "ready": {
          url = URL.createObjectURL(new Blob([next.bytes as BlobPart], { type: next.mimeType }));
          const img = el("img", "page-image-img");
          img.alt = label();
          img.draggable = false;
          img.decoding = "async";
          const title = node.attrs["title"] as string | null;
          if (title) img.title = title;
          const mine = token;
          img.addEventListener("load", () => {
            if (mine === token && img.offsetHeight > 0) heightsOf(ctx).set(src(), img.offsetHeight);
          });
          // Bytes that do not decode as an image: say so instead of the browser's broken-image icon.
          img.addEventListener("error", () => {
            if (mine === token && alive) show({ state: "unreadable" });
          });
          img.src = url;
          frame.replaceChildren(img);
          return;
        }
        case "remote": {
          const link = el("a", "page-image-remote");
          link.href = next.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.referrerPolicy = "no-referrer";
          link.tabIndex = 0;
          link.title = t.remoteTitle;
          const icon = el("span", "page-image-icon", "↗");
          icon.setAttribute("aria-hidden", "true");
          const lead = el("span", "sr-only", `${t.remote} `);
          const text = el("span", "page-image-text", alt().trim() || t.unnamed(""));
          const address = el("span", "page-image-url", next.url);
          link.append(icon, lead, text, document.createTextNode(" "), address);
          const open = (event: Event): void => {
            if (!ctx.openExternal) return; // the browser opens it (a new tab)
            event.preventDefault();
            ctx.openExternal(next.url);
          };
          link.addEventListener("click", open);
          link.addEventListener("keydown", (event) => {
            if (event.key === "Enter") open(event);
          });
          frame.replaceChildren(link);
          return;
        }
        default: {
          const n = name();
          const text = next.state === "missing" ? t.missing(n) : next.state === "refused" ? t.refused(n) : next.state === "not-image" ? t.notImage(n) : next.state === "too-large" ? t.tooLarge(n) : t.unreadable(n);
          frame.replaceChildren(placeholder(next.state, text, alt().trim() ? `${text} (${alt().trim()})` : text));
        }
      }
    };

    const load = (): void => {
      const mine = ++token;
      const media = ctx.media();
      if (!media) return show({ state: "missing" });
      show({ state: "loading" });
      media.load(src()).then(
        (result) => {
          if (alive && mine === token) show(result);
        },
        () => {
          if (alive && mine === token) show({ state: "unreadable" });
        },
      );
    };

    // ------------------------------------------------------------ alt text

    const closeForm = (refocus: boolean): void => {
      form?.remove();
      form = null;
      if (!refocus) return;
      view.focus();
      const pos = getPos();
      if (pos !== undefined && view.state.doc.nodeAt(pos) === node) view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
    };

    const saveAlt = (value: string): void => {
      const pos = getPos();
      if (pos === undefined || !view.editable || view.state.doc.nodeAt(pos) !== node) return closeForm(true);
      if (value !== alt()) view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, alt: value }));
      closeForm(true);
    };

    const openForm = (): void => {
      if (!view.editable) return;
      if (form) {
        form.querySelector("input")?.focus();
        return;
      }
      const id = `page-image-alt-${++altIds}`;
      form = el("span", "page-image-alt");
      form.setAttribute("role", "group");
      form.setAttribute("aria-label", t.editAlt);
      const input = el("input", "page-image-alt-input");
      input.type = "text";
      input.value = alt();
      input.id = id;
      input.setAttribute("aria-label", t.altLabel);
      input.setAttribute("aria-describedby", `${id}-hint`);
      input.placeholder = t.altLabel;
      const hint = el("span", "page-image-alt-hint", t.altHint);
      hint.id = `${id}-hint`;
      const save = el("button", "page-image-alt-button is-primary", t.save);
      save.type = "button";
      const cancel = el("button", "page-image-alt-button", t.cancel);
      cancel.type = "button";
      input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          saveAlt(input.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          closeForm(true);
        }
      });
      save.addEventListener("click", () => saveAlt(input.value));
      cancel.addEventListener("click", () => closeForm(true));
      for (const b of [save, cancel]) b.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeForm(true);
        }
      });
      form.append(input, save, cancel, hint);
      dom.append(form);
      // The block menu gives focus back to the editor when it closes; take it after that.
      setTimeout(() => {
        if (form) input.focus();
        input.select();
      }, 0);
    };
    dom.addEventListener(EDIT_ALT_EVENT, openForm);

    const handle = {
      refresh: () => {
        // The index changed (a save, a file added outside): try again what could not be shown.
        if (shown.state === "missing" || shown.state === "unreadable") load();
      },
    };
    ctx.views.add(handle);
    load();

    return {
      dom,
      update(next) {
        if (next.type !== node.type) return false;
        const before = node;
        node = next;
        if (next.attrs["src"] !== before.attrs["src"]) load();
        else if (next.attrs["alt"] !== before.attrs["alt"] || next.attrs["title"] !== before.attrs["title"]) show(shown);
        return true;
      },
      // The alt field and the web link handle their own events.
      stopEvent: (event) => {
        const target = event.target as Node | null;
        if (form && target && form.contains(target)) return true;
        return shown.state === "remote" && (event.type === "click" || event.type === "mousedown" || event.type === "keydown") && !!target && frame.contains(target);
      },
      ignoreMutation: () => true,
      destroy() {
        alive = false;
        token++;
        release();
        form?.remove();
        ctx.views.delete(handle);
        dom.removeEventListener(EDIT_ALT_EVENT, openForm);
      },
    };
  };

/** Opens the alt text field of the image at `pos`, if there is one. */
export function editImageAlt(view: EditorView, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || (node.type.name !== "image" && node.type.name !== "inlineImage")) return false;
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return false;
  dom.dispatchEvent(new Event(EDIT_ALT_EVENT));
  return true;
}
