/**
 * Exit motion without a library. React removes a component the moment its parent stops rendering it, so
 * something that should leave with a short animation needs one of these:
 *
 * - `usePresence(open)`: for a part that stays mounted by its own parent while it closes (a tree folder). It keeps the
 *   element in the page, with `data-state="closed"`, until the CSS transition that closes it has finished.
 * - `leaveAsGhost(node, surface)`: for a component that is removed at once (a dialog). It leaves an inert copy
 *   with `data-state="closing"` in the page for as long as the exit animation lasts, then removes it.
 *
 * Both ask the element's computed style how long its motion lasts (`motionMs`), so the CSS stays the one place that
 * says so; both wait for `animationend` / `transitionend` and fall back to a timer, and neither waits at all when
 * the person asked for reduced motion or when there is no layout engine (a test). Nothing in an exiting element can be
 * focused or read: it is `inert` and hidden from assistive technology the whole time.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

const REDUCED = "(prefers-reduced-motion: reduce)";

/** True when exits must not wait: reduced motion is asked for, or there is no way to know (no `matchMedia`, as in a test). */
export function motionOff(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(REDUCED).matches;
}

/** "0.14s" or "140ms" as milliseconds; anything else (empty, "auto") is 0. */
const toMs = (value: string): number => {
  const v = value.trim();
  const n = Number.parseFloat(v);
  if (Number.isNaN(n)) return 0;
  return v.endsWith("ms") ? n : v.endsWith("s") ? n * 1000 : 0;
};
const toList = (value: string): number[] => value.split(",").map(toMs);

/** How long the element's CSS animates or transitions it after a state change: `duration` (longest one) and `total` (with delay). Both 0 when it stays still. */
export function motionMs(el: Element): { duration: number; total: number } {
  const style = getComputedStyle(el);
  let duration = 0;
  let total = 0;
  const note = (d: number, delay: number) => {
    duration = Math.max(duration, d);
    total = Math.max(total, d + delay);
  };
  const names = style.animationName.split(",").map((n) => n.trim());
  const ad = toList(style.animationDuration);
  const adelay = toList(style.animationDelay);
  names.forEach((name, i) => {
    if (name !== "" && name !== "none") note(ad[i % ad.length] ?? 0, adelay[i % adelay.length] ?? 0);
  });
  const td = toList(style.transitionDuration);
  const tdelay = toList(style.transitionDelay);
  td.forEach((d, i) => note(d, tdelay[i % tdelay.length] ?? 0));
  return { duration, total };
}

/**
 * Calls `done` once `el` has finished the motion its CSS gives it now: at the end event of its longest animation or
 * transition, or after that long plus a margin if the event never comes. At once when there is no motion. Returns a
 * function that cancels (done is then not called).
 */
export function whenSettled(el: HTMLElement, done: () => void): () => void {
  const { duration, total } = motionOff() ? { duration: 0, total: 0 } : motionMs(el);
  if (total <= 0) {
    done();
    return () => undefined;
  }
  let over = false;
  const stop = () => {
    over = true;
    clearTimeout(timer);
    el.removeEventListener("animationend", onEnd);
    el.removeEventListener("transitionend", onEnd);
  };
  const onEnd = (event: Event) => {
    // Only the element's own motion counts (its children's hover transitions bubble up), and only the longest of them.
    if (event.target !== el || over) return;
    const elapsed = (event as AnimationEvent | TransitionEvent).elapsedTime * 1000;
    if (elapsed < duration - 8) return;
    stop();
    done();
  };
  const timer = setTimeout(() => {
    if (over) return;
    stop();
    done();
  }, total + 80);
  el.addEventListener("animationend", onEnd);
  el.addEventListener("transitionend", onEnd);
  return stop;
}

export interface Presence<T extends HTMLElement> {
  /** Render the element (it is open, or still on its way out). */
  present: boolean;
  /** Put this on the element as `data-state`; the CSS moves between the two. */
  state: "open" | "closed";
  ref: RefObject<T | null>;
}

/**
 * Keeps something rendered while it closes. Mounted already open it simply shows (no enter motion on the first
 * render of a tree). Opened later it mounts as "closed", the browser computes that style, then it flips to "open", so
 * a CSS transition carries it in; closing flips it back and the element goes once the transition has ended. Opening again
 * half way through reverses from where it is. `enabled=false` skips all of it: open means present, closed means gone.
 */
export function usePresence<T extends HTMLElement>(open: boolean, enabled = true): Presence<T> {
  const ref = useRef<T>(null);
  const [kept, setKept] = useState(open);
  const [shown, setShown] = useState(open);

  useLayoutEffect(() => {
    if (!enabled) {
      setKept(open);
      setShown(open);
      return;
    }
    if (open) {
      setKept(true);
      if (!shown) {
        // Read layout once so the "closed" style is computed before it changes; the change then runs as a transition.
        if (ref.current) void ref.current.offsetHeight;
        setShown(true);
      }
      return;
    }
    setShown(false);
    const el = ref.current;
    if (!el) {
      setKept(false);
      return;
    }
    return whenSettled(el, () => setKept(false));
    // `shown` is read, not a trigger: the effect runs when `open` or `enabled` changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, enabled]);

  if (!enabled) return { present: open, state: open ? "open" : "closed", ref };
  return { present: open || kept, state: open && shown ? "open" : "closed", ref };
}

/**
 * Called as a component unmounts (from a layout-effect cleanup, while `node` is still in the page): leaves an inert,
 * hidden-from-AT copy of it in the same place with `data-state="closing"`, so the CSS can play the exit, and removes the
 * copy when that is over. Does nothing when motion is off. The copy has no ids (nothing in the page is duplicated) and
 * cannot take focus or clicks. A development-only second run of the effect leaves the original in the page, so no copy is made then.
 */
export function leaveAsGhost(node: HTMLElement, surface: string): void {
  if (motionOff()) return;
  const parent = node.parentNode;
  if (!parent) return;
  const next = node.nextSibling;
  const ghost = node.cloneNode(true) as HTMLElement;
  // A picture, not a second dialog: nothing in the page may find it by id, role (a shortcut checks for an open
  // `[role=dialog]`), name, tree row or autofocus. Other aria-* stay, since the CSS styles a selected row by them.
  for (const el of [ghost, ...ghost.querySelectorAll<HTMLElement>("*")]) {
    for (const attribute of ["id", "role", "aria-modal", "aria-labelledby", "aria-describedby", "aria-controls", "aria-activedescendant", "tabindex", "name", "data-tree-id", "data-autofocus"]) el.removeAttribute(attribute);
  }
  ghost.setAttribute("data-state", "closing");
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  queueMicrotask(() => {
    if (node.isConnected || !parent.isConnected) return;
    parent.insertBefore(ghost, next && next.parentNode === parent ? next : null);
    whenSettled((ghost.querySelector<HTMLElement>(surface) ?? ghost) as HTMLElement, () => ghost.remove());
  });
}
