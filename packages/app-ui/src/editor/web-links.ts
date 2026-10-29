/**
 * Web links in Blocks mode (0.2.7, `link-open.ts`): Cmd/Ctrl+click or a middle-click opens the address (the host's
 * browser, or the browser's own new tab on the web); a plain click only puts the cursor in it. Hovering one shows the
 * app's tooltip with the address and how to open it.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { EditorContext } from "./context.ts";
import { linkHint, webLinkOpens } from "./link-open.ts";
import { isPasteLinkHref } from "./paste-links.ts";

const webLinksKey = new PluginKey("thothWebLinks");

/**
 * The web link under `target`, when it is one the app may open. The schema does not put `href` in the page's HTML
 * (`@thoth/editor`), so the address is read from the link mark at that place in the document.
 */
function hrefAt(view: EditorView, target: EventTarget | null): { a: HTMLElement; href: string } | null {
  const a = target instanceof Element ? target.closest<HTMLElement>("a") : null;
  if (!a || !view.dom.contains(a) || a.classList.contains("wikilink")) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(a, 0);
  } catch {
    return null;
  }
  // The first character inside the link carries its mark.
  const link = view.state.doc.resolve(Math.min(pos + 1, view.state.doc.content.size)).marks().find((m) => m.type.name === "link");
  const href = String(link?.attrs["href"] ?? "");
  return isPasteLinkHref(href) ? { a, href } : null;
}

export function openWebLink(ctx: EditorContext, href: string): void {
  if (ctx.openExternal) ctx.openExternal(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}

export function webLinksExtension(ctx: EditorContext) {
  const hint = linkHint(ctx.strings, "web");
  const open = (view: EditorView, event: MouseEvent): boolean => {
    const a = event.target instanceof Element ? event.target.closest("a") : null;
    if (!a || !view.dom.contains(a) || a.classList.contains("wikilink")) return false;
    // The page never follows a link by itself (in a read-only page a plain click would, and on the desktop replace the app).
    event.preventDefault();
    const found = webLinkOpens(event) ? hrefAt(view, event.target) : null;
    if (found) openWebLink(ctx, found.href);
    return found !== null;
  };
  return Extension.create({
    name: "thothWebLinks",
    addProseMirrorPlugins: () => [
      new Plugin({
        key: webLinksKey,
        props: {
          handleDOMEvents: {
            // The tooltip is set as the pointer reaches the link, so the shared tooltip layer finds it.
            mouseover: (view, event) => {
              const found = hrefAt(view, event.target);
              if (found && found.a.getAttribute("data-tip") !== found.href) {
                found.a.setAttribute("data-tip", found.href);
                found.a.setAttribute("data-tip-detail", hint);
              }
              return false;
            },
            // A middle-click on Linux would paste the selection where it lands.
            mousedown: (view, event) => event.button === 1 && hrefAt(view, event.target) !== null && (event.preventDefault(), true),
            click: open,
            auxclick: (view, event) => event.button === 1 && open(view, event),
          },
        },
      }),
    ],
  });
}
