/**
 * The link preview card (ADR-0020 rule 2): under a paragraph that holds only a web link, a card with the site name,
 * the title, two lines of description and the image, when the app has link previews (the desktop; `ctx.links`).
 *
 * The card is a widget decoration: display only, never in the document, so the Markdown stays a plain link. What the
 * page sent is untrusted: it is set as text (`textContent`), never as HTML, and the image is only a `data:` URL of a
 * raster type the host checked. A small menu offers "Show as link", "Open" and "Copy link"; its button and items are
 * ordinary buttons in the tab order (no focus trap), arrows move in the open menu and Escape closes it.
 */
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { EditorContext } from "./context.ts";
import { isPreviewImage, type CardState, type PageLinks } from "./link-previews.ts";
import type { EditorStrings } from "../strings/en.ts";

const cardsKey = new PluginKey<DecorationSet>("thothLinkCards");

/** The href when `node` is a paragraph whose whole content is one `http(s)` link. */
export function onlyLink(node: PMNode): string | null {
  if (node.type.name !== "paragraph" || node.childCount === 0) return null;
  let href: string | null = null;
  let ok = true;
  node.forEach((child) => {
    if (!ok) return;
    const link = child.isText ? child.marks.find((m) => m.type.name === "link") : undefined;
    const h = link ? String(link.attrs["href"] ?? "") : null;
    if (!h || (href !== null && h !== href)) ok = false;
    else href = h;
  });
  return ok && href !== null && /^https?:\/\/[^\s]/i.test(href) ? href : null;
}

function hostOf(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The focus to restore after a card is drawn again (its state changed while focus was in it). */
let refocus: string | null = null;

/** Puts `text` on the clipboard (the async clipboard, else the older way). Also used by Settings → Connected apps. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // The older way, for a webview without the async clipboard.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    document.execCommand("copy");
  } finally {
    area.remove();
  }
}

function menu(view: EditorView, href: string, links: PageLinks, t: EditorStrings["linkCard"]): HTMLElement {
  const wrap = el("span", "link-card-actions");
  const button = el("button", "link-card-more");
  button.type = "button";
  button.setAttribute("aria-label", t.options);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.title = t.options;
  button.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>';
  const list = el("span", "link-card-menu");
  list.setAttribute("role", "menu");
  list.setAttribute("aria-label", t.options);
  list.hidden = true;
  const close = (focusButton: boolean) => {
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focusButton) button.focus();
  };
  const items: [string, () => void][] = [
    [
      t.showAsLink,
      () => {
        links.hide(href);
        view.focus();
      },
    ],
    [t.open, () => links.open(href)],
    [t.copy, () => void copyText(href)],
  ];
  const buttons = items.map(([label, run]) => {
    const item = el("button", "link-card-item", label);
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    item.addEventListener("click", (event) => {
      event.preventDefault();
      close(label !== t.showAsLink);
      run();
    });
    list.append(item);
    return item;
  });
  const open = (first: boolean) => {
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    (first ? buttons[0] : buttons[buttons.length - 1])!.focus();
  };
  button.addEventListener("click", (event) => {
    event.preventDefault();
    if (list.hidden) open(true);
    else close(true);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open(event.key === "ArrowDown");
    }
  });
  list.addEventListener("keydown", (event) => {
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = (at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]!.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      buttons[event.key === "Home" ? 0 : buttons.length - 1]!.focus();
    } else if (event.key === "Tab") {
      // Not a trap: Tab leaves the menu (and closes it).
      close(false);
    }
  });
  list.addEventListener("focusout", (event) => {
    if (!wrap.contains(event.relatedTarget as Node | null)) close(false);
  });
  wrap.append(button, list);
  return wrap;
}

/** Draws the card for `href` in `state`. Every text from the page goes in through `textContent`. */
export function renderCard(view: EditorView, href: string, state: CardState, links: PageLinks, t: EditorStrings["linkCard"]): HTMLElement {
  const card = el("span", `link-card link-card-${state.kind}`);
  card.setAttribute("contenteditable", "false");
  card.setAttribute("data-link-card", "");
  card.setAttribute("role", "group");
  const site = state.kind === "ready" ? (state.preview.siteName ?? hostOf(state.preview.finalUrl)) : hostOf(href);
  card.setAttribute("aria-label", t.label(state.kind === "ready" ? (state.preview.title ?? site) : site));
  const body = el("span", "link-card-body");
  if (state.kind === "ready") {
    const { preview } = state;
    const text = el("span", "link-card-text");
    text.append(el("span", "link-card-site", site));
    if (preview.title) text.append(el("span", "link-card-title", preview.title));
    if (preview.description) text.append(el("span", "link-card-description", preview.description));
    body.append(text);
    if (isPreviewImage(preview.image)) {
      const media = el("span", "link-card-media");
      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.src = preview.image;
      media.append(img);
      body.append(media);
    }
  } else {
    const text = el("span", "link-card-text");
    text.append(el("span", "link-card-site", site));
    if (state.kind === "loading") {
      card.setAttribute("aria-busy", "true");
      text.append(el("span", "link-card-status", t.loading));
    } else {
      const load = el("button", "link-card-load", t.load);
      load.type = "button";
      load.title = t.loadHint;
      load.addEventListener("click", (event) => {
        event.preventDefault();
        refocus = href;
        links.load(href);
      });
      text.append(load);
    }
    body.append(text);
  }
  card.append(body, menu(view, href, links, t));
  if (refocus === href) {
    refocus = state.kind === "loading" ? href : null;
    queueMicrotask(() => (card.querySelector<HTMLElement>(".link-card-more") ?? card).focus());
  }
  return card;
}

interface CardSpec {
  href: string;
  kind: CardState["kind"];
}

function build(doc: PMNode, view: EditorView | null, links: PageLinks, t: EditorStrings["linkCard"]): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const href = onlyLink(node);
    if (!href || !links.shows(href)) return false;
    const state = links.state(href);
    if (state.kind === "none") return false;
    const spec: CardSpec & { key: string; side: number; ignoreSelection: boolean; stopEvent: () => boolean } = {
      href,
      kind: state.kind,
      key: `link-card:${state.kind}:${href}`,
      side: 1,
      ignoreSelection: true,
      stopEvent: () => true,
    };
    decorations.push(Decoration.widget(pos + node.nodeSize - 1, (v) => renderCard(view ?? v, href, links.state(href), links, t), spec));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** Starts the fetches the rules allow for the cards now shown. */
function kick(state: EditorState, links: PageLinks): void {
  for (const deco of cardsKey.getState(state)?.find() ?? []) {
    const spec = deco.spec as CardSpec;
    if (spec.kind === "idle" && links.auto(spec.href)) links.load(spec.href);
  }
}

export function linkCardsExtension(ctx: EditorContext & { links: PageLinks }) {
  const { links } = ctx;
  const t = ctx.strings.linkCard;
  return Extension.create({
    name: "thothLinkCards",
    addProseMirrorPlugins() {
      return [
        new Plugin<DecorationSet>({
          key: cardsKey,
          state: {
            init: (_, state) => build(state.doc, null, links, t),
            apply: (tr, old, _oldState, state) => (tr.docChanged || tr.getMeta(cardsKey) ? build(state.doc, null, links, t) : old),
          },
          props: {
            decorations: (state) => cardsKey.getState(state),
          },
          view(view) {
            const off = links.subscribe(() => {
              if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(cardsKey, true).setMeta("addToHistory", false));
            });
            queueMicrotask(() => {
              if (!view.isDestroyed) kick(view.state, links);
            });
            return {
              update: (v) => kick(v.state, links),
              destroy: off,
            };
          },
        }),
      ];
    },
  });
}
