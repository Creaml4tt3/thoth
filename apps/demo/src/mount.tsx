/** The lazy chunk: mounts one demo into its root. Everything heavy (React, the editors, the app's CSS) is behind this import. */
import { createRoot } from "react-dom/client";
import type { Lang } from "@thoth/app-ui/strings/index.ts";
import "./demo.css";
import { Demo, type DemoKind } from "./Demo.tsx";

/** The editors put their menus on `document.body`, outside any demo root. They are moved into one themed layer, so the scoped CSS reaches them. */
const POPUPS = ".slash-menu, .link-menu, .block-menu, .block-submenu";
let layer: HTMLElement | null = null;
function adoptPopups(lang: Lang): void {
  if (layer) return;
  layer = document.createElement("div");
  layer.className = "thoth-demo";
  layer.setAttribute("data-theme", "system");
  layer.lang = lang;
  layer.style.cssText = "height:0;margin:0;padding:0;background:none;overflow:visible";
  document.body.append(layer);
  const into = layer;
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement && node.matches(POPUPS)) into.append(node);
  }).observe(document.body, { childList: true });
}

/** Painted: an editor shows the page's text. (Gives up after about two seconds and shows what there is.) */
function whenPainted(host: HTMLElement, done: () => void): void {
  let frames = 0;
  const tick = () => (host.querySelector(".ProseMirror, .cm-content")?.textContent || ++frames > 120 ? done() : void requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}

export function mount(root: HTMLElement): void {
  const kind = root.dataset["thothDemo"];
  if (kind !== "compare" && kind !== "window") throw new Error(`Unknown demo: ${kind}`);
  const lang: Lang = (root.closest("[lang]")?.getAttribute("lang") ?? "").toLowerCase().startsWith("th") ? "th" : "en";
  adoptPopups(lang);

  // The root's own HTML (the site's capture) stays until the editor is mounted: the demo builds beside it, off screen.
  const capture = [...root.childNodes];
  const host = document.createElement("div");
  host.className = "thoth-demo";
  host.lang = lang;
  host.setAttribute("data-theme", "system"); // follows prefers-color-scheme (tokens.css)
  host.setAttribute("data-staging", "");
  host.style.width = `${root.clientWidth}px`;
  root.append(host);
  createRoot(host).render(<Demo kind={kind as DemoKind} lang={lang} />);
  whenPainted(host, () => {
    for (const node of capture) node.remove();
    host.removeAttribute("data-staging");
    host.style.width = "";
    root.dataset["thothDemoState"] = "ready";
  });
}
