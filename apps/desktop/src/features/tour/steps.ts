/**
 * The steps of the first-run tour (ADR-0032), each pointing at a real control. A step whose control is not on screen
 * (the sidebar hidden, a narrow window, no assistant, no page open) is left out, so the count says what will be shown.
 */
import type { Side } from "@thoth/app-ui/ui/place.ts";

export type TourStepId = "tree" | "create" | "search" | "editor" | "tabs" | "home" | "assistant";

export interface TourStep {
  id: TourStepId;
  /** Where the control is, the first match that is on screen wins. */
  anchors: readonly string[];
  /** Where the popover goes, in order of preference. */
  sides: readonly Side[];
  /** A part of the control to put the popover beside, when the control is large (the editor: its first block). */
  placeAt?: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  { id: "tree", anchors: [".sidebar .tree-wrap"], sides: ["right", "bottom", "top", "left"] },
  { id: "create", anchors: [".sidebar .side-actions"], sides: ["right", "top", "bottom", "left"] },
  { id: "search", anchors: [".sidebar .search-trigger"], sides: ["right", "bottom", "top", "left"] },
  // The open page's editor, with the popover under its first block: the `/` menu and the block handle are there. The
  // ring and the description go on the editor's frame, never inside the text: the editor owns those nodes.
  { id: "editor", anchors: [".main .tab-panel .editor-surface:has(.prose > :first-child)"], placeAt: ".prose > :first-child", sides: ["bottom", "top", "right", "left"] },
  { id: "tabs", anchors: [".main .tabstrip .tablist"], sides: ["bottom", "top", "right", "left"] },
  { id: "home", anchors: [".main .tabstrip .tab-home", ".sidebar .ws-home"], sides: ["bottom", "right", "top", "left"] },
  { id: "assistant", anchors: [".mascot-layer .mascot"], sides: ["top", "left", "bottom", "right"] },
];

/** On screen: not inside something hidden or inert, with a size, and at least partly inside the window. */
export function onScreen(el: Element): boolean {
  if (el.closest("[inert], [aria-hidden='true'], [hidden]")) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const width = document.documentElement.clientWidth || window.innerWidth;
  const height = document.documentElement.clientHeight || window.innerHeight;
  return rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height;
}

/** The control of `step` now, if it is on screen. */
export function anchorOf(step: TourStep, root: ParentNode = document, shown: (el: Element) => boolean = onScreen): Element | null {
  for (const selector of step.anchors) {
    for (const el of root.querySelectorAll(selector)) if (shown(el)) return el;
  }
  return null;
}

/** The steps whose control is on screen, in tour order. */
export function availableSteps(steps: readonly TourStep[] = TOUR_STEPS, root: ParentNode = document, shown: (el: Element) => boolean = onScreen): TourStep[] {
  return steps.filter((step) => anchorOf(step, root, shown) !== null);
}
