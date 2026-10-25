/**
 * Where the mascot sits, as plain geometry (no DOM), so dragging, snapping and clamping are tested on their own.
 *
 * The mascot is a box (full or compact, times the scale) inside the window, kept inside the "safe area": the window
 * minus a margin, and minus the tab strip at the top, so it never covers the tabs, their close buttons or the new-tab
 * button. Its position is remembered as distances from the nearest horizontal and vertical edges (`MascotPosition`),
 * so it stays glued to its corner when the window grows or shrinks, and is clamped back inside when the window gets
 * too small for it.
 */
import { COMPACT_BOX, STAGE, type MascotVersion } from "./MascotArt.tsx";
import type { MascotPosition } from "./prefs.ts";

export interface Size {
  width: number;
  height: number;
}
export interface Point {
  left: number;
  top: number;
}
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The gap kept between the mascot and the window's edges. */
export const EDGE_MARGIN = 16;
/** Below the tab strip. */
export const TOP_INSET = 48;
/** Snapping to a corner: when the mascot ends this close to the second edge too. */
export const CORNER_REACH = 96;
/** Arrow keys move this far; with Shift, `KEY_STEP_LARGE`. */
export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;
/** A press that moves less than this is a click, not a drag. */
export const DRAG_THRESHOLD = 4;
/** Below this window width, Auto shows the compact version. */
export const NARROW_WIDTH = 960;

export const DEFAULT_POSITION: MascotPosition = { h: "right", x: 24, v: "bottom", y: 24 };

/** The box of a version at a scale (percent). */
export function boxSize(version: MascotVersion, scale: number): number {
  return Math.round((version === "full" ? STAGE : COMPACT_BOX) * (scale / 100));
}

export const defaultInsets = (top = TOP_INSET): Insets => ({ top, right: EDGE_MARGIN / 2, bottom: EDGE_MARGIN / 2, left: EDGE_MARGIN / 2 });

/** Keeps a box inside the safe area. A window too small for it puts it at the top-left of the area. */
export function clampPoint(point: Point, box: number, view: Size, insets: Insets): Point {
  const maxLeft = Math.max(insets.left, view.width - insets.right - box);
  const maxTop = Math.max(insets.top, view.height - insets.bottom - box);
  return { left: Math.round(Math.min(maxLeft, Math.max(insets.left, point.left))), top: Math.round(Math.min(maxTop, Math.max(insets.top, point.top))) };
}

/** The box's top-left corner for a remembered position, clamped into the window. */
export function pointFor(position: MascotPosition, box: number, view: Size, insets: Insets): Point {
  const left = position.h === "left" ? position.x : view.width - position.x - box;
  const top = position.v === "top" ? position.y : view.height - position.y - box;
  return clampPoint({ left, top }, box, view, insets);
}

/** A position measured from the edges nearest to the box's centre. */
export function positionFor(point: Point, box: number, view: Size): MascotPosition {
  const cx = point.left + box / 2;
  const cy = point.top + box / 2;
  const h = cx < view.width / 2 ? "left" : "right";
  const v = cy < view.height / 2 ? "top" : "bottom";
  return {
    h,
    x: Math.max(0, Math.round(h === "left" ? point.left : view.width - point.left - box)),
    v,
    y: Math.max(0, Math.round(v === "top" ? point.top : view.height - point.top - box)),
  };
}

/**
 * Snaps a box to the nearest edge of the safe area (EDGE_MARGIN in from it), and into the corner when it is also
 * within `CORNER_REACH` of the second edge.
 */
export function snapPoint(point: Point, box: number, view: Size, insets: Insets): Point {
  const p = clampPoint(point, box, view, insets);
  const left = insets.left + EDGE_MARGIN / 2;
  const right = view.width - insets.right - EDGE_MARGIN / 2 - box;
  const top = insets.top;
  const bottom = view.height - insets.bottom - EDGE_MARGIN / 2 - box;
  const dLeft = Math.abs(p.left - left);
  const dRight = Math.abs(right - p.left);
  const dTop = Math.abs(p.top - top);
  const dBottom = Math.abs(bottom - p.top);
  const nearX = dLeft <= dRight ? { at: left, d: dLeft } : { at: right, d: dRight };
  const nearY = dTop <= dBottom ? { at: top, d: dTop } : { at: bottom, d: dBottom };
  let out: Point;
  if (nearX.d <= nearY.d) out = { left: nearX.at, top: nearY.d <= CORNER_REACH ? nearY.at : p.top };
  else out = { left: nearX.d <= CORNER_REACH ? nearX.at : p.left, top: nearY.at };
  return clampPoint(out, box, view, insets);
}

/** The mascot faces the middle of the window: right when it sits on the left half, left on the right half. */
export const facingFor = (position: MascotPosition): "left" | "right" => (position.h === "left" ? "right" : "left");
