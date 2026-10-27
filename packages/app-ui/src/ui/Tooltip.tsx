/**
 * One tooltip for the whole app. Elements opt in with attributes (see `tip` and `tipIfClipped`); a single
 * `<TooltipLayer />` near the root listens for them, so a tree of hundreds of rows carries no handler per row.
 *
 * - `tip(name, keys)` is for icon buttons and other controls without a visible name: it always shows the name, and
 *   its shortcut next to it.
 * - `tipIfClipped(text)` is for text that ellipsis or `line-clamp` cuts: the tooltip shows the whole text, and only
 *   when the text really is cut (`scrollWidth > clientWidth`, or `scrollHeight > clientHeight` for a clamp), measured
 *   when the tooltip is about to show. The element's own text stays the accessible name; the tooltip is for eyes.
 *
 * It shows after a short pause with the pointer on the element, at once when the element gets keyboard focus
 * (`:focus-visible`), hides on Escape, on a press, on scroll, when a drag starts, and when the pointer or focus leaves.
 * It never takes the pointer (`pointer-events: none`), so it cannot get in the way of a click or a drop. It sits below
 * the element, above it when there is no room, and is kept inside the window. While it shows, the element's own native
 * `title` is set aside, so the browser does not show a second one. Motion comes from the motion tokens (ui.css).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { placeBeside } from "./place.ts";

/** How long the pointer rests on an element before its tooltip shows (ms). */
export const TOOLTIP_DELAY_MS = 500;
/** Within this long after one tooltip closes, the next shows at once (moving along a row of icon buttons). */
export const TOOLTIP_WARM_MS = 400;

const MARGIN = 8;
const GAP = 6;

export interface TipAttributes {
  "data-tip": string;
  "data-tip-keys"?: string;
  "data-tip-detail"?: string;
  "data-tip-fit"?: "";
}

/** For a control that has no visible name (an icon button): always shows `name`, and `keys` beside it. */
export function tip(name: string, keys?: string, detail?: string): TipAttributes {
  return { "data-tip": name, ...(keys ? { "data-tip-keys": keys } : {}), ...(detail ? { "data-tip-detail": detail } : {}) };
}

/** For text that may be cut off: shows `text` in full, and only when the element (or something in it) is cut. */
export function tipIfClipped(text: string): TipAttributes {
  return { "data-tip": text, "data-tip-fit": "" };
}

/** Is `el` itself cut: wider (or, for a line clamp, taller) than the box that shows it? */
function cut(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.overflowX !== "visible" && style.overflowX !== "" && el.scrollWidth > el.clientWidth + 1) return true;
  const clamp = style.getPropertyValue("-webkit-line-clamp");
  const clamped = clamp !== "" && clamp !== "none";
  return clamped && el.scrollHeight > el.clientHeight + 1;
}

/** True when the text of `host` is cut off: the element itself or anything inside it is wider than its box. */
export function isClipped(host: Element): boolean {
  if (cut(host)) return true;
  for (const child of host.querySelectorAll("*")) if (cut(child)) return true;
  return false;
}

interface Shown {
  host: HTMLElement;
  text: string;
  keys: string | undefined;
  detail: string | undefined;
}

const read = (host: HTMLElement): Shown => ({ host, text: host.getAttribute("data-tip") ?? "", keys: host.getAttribute("data-tip-keys") ?? undefined, detail: host.getAttribute("data-tip-detail") ?? undefined });

const hostOf = (target: EventTarget | null): HTMLElement | null => (target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null);

function keyboardFocus(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true; // no :focus-visible (an old engine, a test DOM): focus counts
  }
}

/** Mount once, near the root of the app. */
export function TooltipLayer({ delayMs = TOOLTIP_DELAY_MS }: { delayMs?: number }) {
  const id = useId();
  const [shown, setShown] = useState<Shown | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number; side: "top" | "bottom" } | null>(null);

  useEffect(() => {
    let pending: { host: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;
    let active: HTMLElement | null = null;
    let closedAt = -Infinity;
    /** Dismissed with Escape: stays closed until the pointer or focus leaves that element. */
    let dismissed: HTMLElement | null = null;
    /** The native title set aside while the tooltip shows. */
    let stashed: { host: HTMLElement; title: string } | null = null;
    let watcher: MutationObserver | null = null;

    const describe = (host: HTMLElement, add: boolean) => {
      const ids = (host.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((x) => x && x !== id);
      if (add) ids.push(id);
      if (ids.length > 0) host.setAttribute("aria-describedby", ids.join(" "));
      else host.removeAttribute("aria-describedby");
    };

    const hide = () => {
      if (pending) clearTimeout(pending.timer);
      pending = null;
      watcher?.disconnect();
      watcher = null;
      if (stashed) {
        stashed.host.setAttribute("title", stashed.title);
        stashed = null;
      }
      if (active) {
        describe(active, false);
        closedAt = Date.now();
      }
      active = null;
      setShown(null);
      setPlace(null);
    };

    const show = (host: HTMLElement) => {
      pending = null;
      if (!host.isConnected) return;
      if ((host.getAttribute("data-tip") ?? "") === "") return;
      if (host.hasAttribute("data-tip-fit") && !isClipped(host)) return;
      active = host;
      describe(host, true);
      const title = host.getAttribute("title");
      if (title !== null) {
        stashed = { host, title };
        host.removeAttribute("title");
      }
      // A host that goes away (a tab closes) or changes its text while the tooltip shows.
      watcher = new MutationObserver(() => {
        if (!host.isConnected) return hide();
        const next = host.getAttribute("data-tip");
        if (next === null || next === "") return hide();
        const now = read(host);
        setShown((s) => (s && s.text === now.text && s.keys === now.keys && s.detail === now.detail ? s : now));
      });
      watcher.observe(document.body, { childList: true, subtree: true });
      watcher.observe(host, { attributes: true, attributeFilter: ["data-tip", "data-tip-keys", "data-tip-detail"] });
      setShown(read(host));
    };

    const schedule = (host: HTMLElement, immediate: boolean) => {
      if (host === active || host === pending?.host || host === dismissed) return;
      hide();
      if (immediate || Date.now() - closedAt < TOOLTIP_WARM_MS) return show(host);
      pending = { host, timer: setTimeout(() => show(host), delayMs) };
    };

    const onOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if (document.documentElement.hasAttribute("data-tree-dragging")) return;
      const host = hostOf(event.target);
      if (host !== dismissed) dismissed = null;
      if (!host) return hide();
      schedule(host, false);
    };
    const onOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) hide(); // the pointer left the window
    };
    const onFocusIn = (event: FocusEvent) => {
      const host = hostOf(event.target);
      if (!host || !keyboardFocus(host)) return;
      schedule(host, true);
    };
    const onFocusOut = (event: FocusEvent) => {
      const host = hostOf(event.target);
      if (host && host === dismissed) dismissed = null;
      if (host && (host === active || host === pending?.host)) hide();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !(active || pending)) return;
      dismissed = active ?? pending?.host ?? null;
      hide(); // not stopped: a dialog under it still gets Escape
    };
    const any = () => {
      if (active || pending) hide();
    };

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", any, true);
    document.addEventListener("dragstart", any, true);
    document.addEventListener("scroll", any, true);
    window.addEventListener("blur", any);
    window.addEventListener("resize", any);
    return () => {
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", any, true);
      document.removeEventListener("dragstart", any, true);
      document.removeEventListener("scroll", any, true);
      window.removeEventListener("blur", any);
      window.removeEventListener("resize", any);
      hide();
    };
  }, [delayMs, id]);

  // Below the element, above it when there is no room, and inside the window.
  useLayoutEffect(() => {
    const el = box.current;
    if (!shown || !el) return;
    const view = { width: document.documentElement.clientWidth || window.innerWidth, height: document.documentElement.clientHeight || window.innerHeight };
    const { top, left, side } = placeBeside(shown.host.getBoundingClientRect(), el.getBoundingClientRect(), view, ["bottom", "top"], { gap: GAP, margin: MARGIN });
    setPlace({ top, left, side: side === "top" ? "top" : "bottom" });
  }, [shown]);

  if (!shown) return null;
  const style: CSSProperties = place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: "hidden" };
  return createPortal(
    <div ref={box} id={id} role="tooltip" className="tooltip" data-side={place?.side ?? "bottom"} style={style}>
      <span className="tooltip-body">
        <span className="tooltip-text">{shown.text}</span>
        {shown.detail && <span className="tooltip-detail">{shown.detail}</span>}
      </span>
      {shown.keys && <kbd className="tooltip-keys">{shown.keys}</kbd>}
    </div>,
    document.body,
  );
}
