/**
 * Vanilla DOM node views for the Thoth schema. They are plain DOM (not React
 * portals) so they stay cheap and the editor has no React re-render per node.
 */
import type { NodeViewRenderer } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorContext } from "./context.ts";
import { kindClass, kindIcon, kindLabel } from "./callout-kinds.ts";
import { linkHint, pageLinkOpens } from "./link-open.ts";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Obsidian-style callout. The title is the first child (`calloutTitle`), so it
 * is edited in place; the icon and the fold triangle sit beside it in a
 * non-editable lead. `toggle` callouts look like Notion toggles (no box).
 *
 * Folding is view-only: it flips attributes on this element and never
 * dispatches a document change, so it cannot mark the page dirty or save.
 * The initial state comes from the marker (`-` collapsed, `+` open).
 */
export const calloutView = (ctx: EditorContext): NodeViewRenderer => ({ node: initial, view, getPos }) => {
  let node = initial;
  const dom = el("div", "callout");
  const lead = el("div", "callout-lead");
  lead.setAttribute("contenteditable", "false");
  const fold = el("button", "callout-fold");
  fold.type = "button";
  const icon = el("span", "callout-icon");
  icon.setAttribute("aria-hidden", "true");
  lead.append(fold, icon);
  const contentDOM = el("div", "callout-content");
  dom.append(lead, contentDOM);
  let collapsed = node.attrs["fold"] === "-";

  const foldable = (): boolean => node.attrs["fold"] !== "" || node.attrs["kind"] === "toggle";
  const paint = (): void => {
    const kind = node.attrs["kind"] as string;
    const key = kindClass(kind);
    dom.dataset["callout"] = key;
    dom.dataset["fold"] = node.attrs["fold"] as string;
    dom.dataset["foldable"] = String(foldable());
    dom.dataset["collapsed"] = String(foldable() && collapsed);
    dom.style.setProperty("--callout-label", JSON.stringify(kindLabel(kind)));
    icon.textContent = kindIcon(kind);
    fold.hidden = !foldable();
    fold.setAttribute("aria-expanded", String(!collapsed));
    fold.setAttribute("aria-label", ctx.strings.fold(collapsed, key === "toggle"));
    fold.textContent = collapsed ? "▸" : "▾";
  };
  const setCollapsed = (next: boolean): void => {
    collapsed = next;
    paint();
    const pos = getPos();
    const { selection } = view.state;
    if (!next || pos === undefined || selection.from <= pos || selection.to >= pos + node.nodeSize) return;
    // The caret was in the body that just disappeared: move it to the end of the title (a selection change, not an edit).
    const end = pos + 1 + node.firstChild!.nodeSize - 1;
    if (selection.from > end) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
  };
  fold.addEventListener("mousedown", (event) => event.preventDefault());
  fold.addEventListener("click", (event) => {
    event.preventDefault();
    setCollapsed(!collapsed);
  });
  paint();
  return {
    dom,
    contentDOM,
    update(next) {
      if (next.type.name !== node.type.name) return false;
      // A new marker (another kind of callout, a converted block) restarts from the marker.
      if (next.attrs["fold"] !== node.attrs["fold"]) collapsed = next.attrs["fold"] === "-";
      node = next;
      paint();
      return true;
    },
    stopEvent: (event) => lead.contains(event.target as Node | null),
    ignoreMutation: (mutation) => mutation.type !== "selection" && !contentDOM.contains(mutation.target),
  };
};

/** raw, html and math: read-only, monospace, and labelled so nobody mistakes them for content that was converted. */
export const preservedView = (ctx: EditorContext): NodeViewRenderer => ({ node }) => {
  const dom = el("div", "preserved");
  dom.setAttribute("contenteditable", "false");
  dom.dataset["kind"] = node.type.name;
  const label = el("div", "preserved-label", ctx.strings.preserved(node.type.name === "html" ? "html" : node.type.name === "math" ? "math" : "raw"));
  const pre = el("pre", "preserved-source", node.attrs["source"] as string);
  dom.append(label, pre);
  return {
    dom,
    update(next) {
      if (next.type.name !== node.type.name) return false;
      pre.textContent = next.attrs["source"] as string;
      return true;
    },
    stopEvent: () => false,
  };
};

/** Inline constructs the editor cannot model (references, inline HTML, footnote refs). */
export const inlineRawView = (ctx: EditorContext): NodeViewRenderer => ({ node }) => {
  const dom = el("code", "inline-raw", node.attrs["source"] as string);
  dom.setAttribute("contenteditable", "false");
  dom.title = ctx.strings.preservedTitle;
  return { dom };
};

const labelOf = (target: string, label: string | null, fragment: string | null): string => label ?? (fragment ? `${target}#${fragment}` : target);

/** The app's tooltip on a link chip (`Tooltip.tsx`): where it goes, and how to open it when it can be opened. */
export function setLinkTip(dom: HTMLElement, text: string, hint: string | null): void {
  dom.removeAttribute("title");
  if (text) dom.setAttribute("data-tip", text);
  else dom.removeAttribute("data-tip");
  if (hint) dom.setAttribute("data-tip-detail", hint);
  else dom.removeAttribute("data-tip-detail");
}

/** `[[Target]]` as a chip. Clicking (or Enter on it) opens the resolved page. */
export const wikilinkView = (ctx: EditorContext): NodeViewRenderer => ({ node: initial }) => {
  let node = initial;
  const dom = el("a", "wikilink");
  dom.setAttribute("contenteditable", "false");
  dom.tabIndex = 0;
  dom.setAttribute("role", "link");
  const paint = (): void => {
    const target = node.attrs["target"] as string;
    const result = ctx.lookup().resolve(target);
    dom.textContent = labelOf(target, node.attrs["label"] as string | null, node.attrs["fragment"] as string | null);
    dom.dataset["state"] = result.state;
    dom.dataset["target"] = result.state === "resolved" ? result.path : "";
    const t = ctx.strings;
    setLinkTip(dom, result.state === "resolved" ? result.path : result.state === "ambiguous" ? t.linkAmbiguous(result.candidates.join(", ")) : t.linkUnresolved(target), result.state === "resolved" ? linkHint(t, "page") : null);
    dom.setAttribute("aria-label", `${dom.textContent} (${t.linkState[result.state]})`);
  };
  const open = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    const result = ctx.lookup().resolve(node.attrs["target"] as string);
    if (result.state === "resolved") ctx.openPage(result.path, event instanceof MouseEvent ? pageLinkOpens(event) : undefined);
  };
  dom.addEventListener("click", open);
  dom.addEventListener("auxclick", (event) => event.button === 1 && open(event));
  // A middle-click on Linux pastes the selection where it lands; never in the document.
  dom.addEventListener("mousedown", (event) => event.button === 1 && event.preventDefault());
  dom.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") open(event);
  });
  const handle = { refresh: paint };
  ctx.views.add(handle);
  paint();
  return {
    dom,
    update(next) {
      if (next.type.name !== node.type.name) return false;
      node = next;
      paint();
      return true;
    },
    stopEvent: (event) => event.type === "click" || event.type === "auxclick" || event.type === "mousedown",
    destroy: () => void ctx.views.delete(handle),
  };
};

/** `![[Target]]` on its own line: shown as a chip; embedding is not rendered in v1. */
export const embedView = (ctx: EditorContext): NodeViewRenderer => ({ node }) => {
  const dom = el("div", "embed");
  dom.setAttribute("contenteditable", "false");
  const chip = el("a", "wikilink");
  chip.tabIndex = 0;
  chip.setAttribute("role", "link");
  const target = node.attrs["target"] as string;
  const paint = (): void => {
    const result = ctx.lookup().resolve(target);
    chip.textContent = `${ctx.strings.embed}${labelOf(target, node.attrs["label"] as string | null, node.attrs["fragment"] as string | null)}`;
    chip.dataset["state"] = result.state;
    chip.dataset["target"] = result.state === "resolved" ? result.path : "";
    setLinkTip(chip, result.state === "resolved" ? result.path : "", result.state === "resolved" ? linkHint(ctx.strings, "page") : null);
  };
  const open = (event: Event): void => {
    event.preventDefault();
    const result = ctx.lookup().resolve(target);
    if (result.state === "resolved") ctx.openPage(result.path, event instanceof MouseEvent ? pageLinkOpens(event) : undefined);
  };
  chip.addEventListener("click", open);
  chip.addEventListener("auxclick", (event) => event.button === 1 && open(event));
  chip.addEventListener("mousedown", (event) => event.button === 1 && event.preventDefault());
  chip.addEventListener("keydown", (event) => {
    if (event.key === "Enter") open(event);
  });
  dom.append(chip);
  const handle = { refresh: paint };
  ctx.views.add(handle);
  paint();
  return { dom, stopEvent: (event) => event.type === "click", destroy: () => void ctx.views.delete(handle) };
};

/** Task item with a real checkbox; read-only editors cannot toggle it. */
export const taskItemView = (ctx: EditorContext): NodeViewRenderer => ({ node: initial, view, getPos }) => {
  let node = initial;
  const dom = el("li", "task-item");
  const box = el("input");
  box.type = "checkbox";
  box.className = "task-box";
  box.setAttribute("aria-label", ctx.strings.done);
  const contentDOM = el("div", "task-content");
  const wrap = el("span", "task-check");
  wrap.setAttribute("contenteditable", "false");
  wrap.append(box);
  dom.append(wrap, contentDOM);
  const paint = (): void => {
    box.checked = node.attrs["checked"] === true;
    dom.dataset["checked"] = String(box.checked);
  };
  box.addEventListener("change", () => {
    const pos = getPos();
    if (pos === undefined || !view.editable) {
      paint();
      return;
    }
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: box.checked }));
  });
  paint();
  return {
    dom,
    contentDOM,
    update(next) {
      if (next.type.name !== node.type.name) return false;
      node = next;
      paint();
      return true;
    },
    stopEvent: (event) => event.target === box,
    ignoreMutation: (mutation) => wrap.contains(mutation.target),
  };
};
