/**
 * Toasts: short messages floating at the bottom of the window, in the manner of Ding (a pill that changes in place).
 * Plain DOM, so editor plugins can use them as well as React. A toast with an `id` already on screen is updated where
 * it is (its width eases to the new text) instead of stacking another. Quick ones (info, success) leave after a few
 * seconds (more with a button), paused while the pointer or focus is on them; errors and loading stay until closed or
 * replaced. The region is a polite live region, so screen readers hear each message once.
 */

export type ToastKind = "info" | "success" | "error" | "loading";

export interface ToastButton {
  label: string;
  onClick(): void;
}

export interface ToastOptions {
  kind?: ToastKind;
  /** Buttons after the message; the toast closes after one is clicked unless it was updated meanwhile. */
  actions?: ToastButton[];
  /** The same id updates the toast on screen instead of adding one. */
  id?: string;
  /** Milliseconds before it leaves; 0 keeps it. Default: errors and loading stay; others 4000, or 8000 with a button. */
  duration?: number;
  /** The close button's name (localized by the caller). */
  closeLabel?: string;
}

export interface ToastHandle {
  dismiss(): void;
}

const MAX = 3;
const ICONS: Record<ToastKind, string[]> = {
  success: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18", "M8 12.5l2.7 2.7L16 9.8"],
  error: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18", "M12 7.5v5.5", "M12 16.4v.1"],
  info: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18", "M12 11v5.5", "M12 7.6v.1"],
  // Three dots in a ring: still going. Nothing spins (the app loops no animation).
  loading: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18", "M8 12h.1M12 12h.1M16 12h.1"],
};

interface Live {
  el: HTMLElement;
  timer: ReturnType<typeof setTimeout> | undefined;
  duration: number;
  version: number;
}

let viewport: HTMLElement | null = null;
const shown = new Map<string, Live>();
let nextId = 0;

function region(): HTMLElement {
  if (viewport?.isConnected) return viewport;
  // A region taken out of the page (a test, a reload) takes its toasts with it.
  for (const live of shown.values()) clearTimeout(live.timer);
  shown.clear();
  viewport = document.createElement("section");
  viewport.className = "toast-viewport";
  viewport.setAttribute("aria-live", "polite");
  viewport.setAttribute("aria-relevant", "additions text");
  document.body.append(viewport);
  return viewport;
}

const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function icon(kind: ToastKind): Element {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "toast-icon");
  for (const d of ICONS[kind]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function leave(id: string): void {
  const live = shown.get(id);
  if (!live) return;
  clearTimeout(live.timer);
  shown.delete(id);
  const el = live.el;
  if (reducedMotion() || typeof el.animate !== "function") return el.remove();
  el.classList.add("is-leaving");
  el.addEventListener("animationend", () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 400); // shortcut: a fallback when no animationend comes (an animation the page never ran)
}

function arm(id: string, live: Live): void {
  clearTimeout(live.timer);
  if (live.duration > 0) live.timer = setTimeout(() => leave(id), live.duration);
}

/** Shows `message`, or updates the toast with the same `id`. */
export function toast(message: string, options: ToastOptions = {}): ToastHandle {
  const kind = options.kind ?? "info";
  const actions = options.actions ?? [];
  const id = options.id ?? `toast-${++nextId}`;
  // Errors and loading stay; the rest leave on their own, later when there is a button to reach.
  const duration = options.duration ?? (kind === "error" || kind === "loading" ? 0 : actions.length > 0 ? 8000 : 4000);
  const root = region();
  let live = shown.get(id);
  const before = live?.el.getBoundingClientRect().width ?? 0;
  if (!live) {
    const el = document.createElement("div");
    el.className = "toast";
    el.addEventListener("mouseenter", () => clearTimeout(shown.get(id)?.timer));
    el.addEventListener("focusin", () => clearTimeout(shown.get(id)?.timer));
    el.addEventListener("mouseleave", () => {
      const now = shown.get(id);
      if (now && !el.contains(document.activeElement)) arm(id, now);
    });
    el.addEventListener("keydown", (event) => {
      if (event.key === "Escape") leave(id);
    });
    live = { el, timer: undefined, duration, version: 0 };
    shown.set(id, live);
    root.append(el);
    // Oldest out first when too many are up.
    while (shown.size > MAX) leave(shown.keys().next().value!);
  }
  const current = live;
  const version = ++current.version;
  current.duration = duration;
  current.el.dataset["kind"] = kind;
  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = message;
  const buttons = actions.map((a) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-action";
    b.textContent = a.label;
    b.addEventListener("click", () => {
      a.onClick();
      // An action that put up a new message (Try the other model) keeps the toast; anything else closes it.
      if (shown.get(id)?.version === version) leave(id);
    });
    return b;
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", options.closeLabel ?? "Close");
  close.textContent = "×";
  close.addEventListener("click", () => leave(id));
  current.el.replaceChildren(icon(kind), text, ...buttons, close);
  // Ding's morph: the pill eases from its old width to the new one.
  const after = current.el.getBoundingClientRect().width;
  if (before > 0 && after > 0 && before !== after && !reducedMotion() && typeof current.el.animate === "function") {
    const style = getComputedStyle(document.documentElement);
    const duration = Number.parseFloat(style.getPropertyValue("--thoth-dur-base")) || 0;
    if (duration > 0) current.el.animate([{ width: `${before}px` }, { width: `${after}px` }], { duration, easing: style.getPropertyValue("--thoth-ease-emphasized").trim() || "ease-out" });
  }
  arm(id, current);
  return { dismiss: () => shown.get(id)?.version === version && leave(id) };
}

/** Closes every toast (tests, and a window that is closing). */
export function dismissAllToasts(): void {
  for (const id of [...shown.keys()]) leave(id);
}
