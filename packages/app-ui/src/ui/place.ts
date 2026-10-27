/**
 * Where a floating box goes next to the element it belongs to: the first side in `sides` where it fits, centred on
 * the element along that side, and always kept `margin` inside the window. When it fits on no side it goes on the
 * first, pushed inside the window. The tooltip uses below / above; the first-run tour (ADR-0032) tries all four.
 */
export type Side = "bottom" | "top" | "right" | "left";

export interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  side: Side;
}

export function placeBeside(anchor: Rect, size: { width: number; height: number }, view: { width: number; height: number }, sides: readonly Side[], { gap = 6, margin = 8 }: { gap?: number; margin?: number } = {}): Placement {
  const clamp = (v: number, length: number, room: number) => Math.max(margin, Math.min(v, room - margin - length));
  const centredX = clamp(anchor.left + anchor.width / 2 - size.width / 2, size.width, view.width);
  const centredY = clamp(anchor.top + anchor.height / 2 - size.height / 2, size.height, view.height);
  const at = (side: Side): { place: Placement; fits: boolean } => {
    switch (side) {
      case "bottom": {
        const top = anchor.bottom + gap;
        return { place: { side, left: centredX, top: clamp(top, size.height, view.height) }, fits: top + size.height <= view.height - margin };
      }
      case "top": {
        const top = anchor.top - gap - size.height;
        return { place: { side, left: centredX, top: clamp(top, size.height, view.height) }, fits: top >= margin };
      }
      case "right": {
        const left = anchor.right + gap;
        return { place: { side, top: centredY, left: clamp(left, size.width, view.width) }, fits: left + size.width <= view.width - margin };
      }
      case "left": {
        const left = anchor.left - gap - size.width;
        return { place: { side, top: centredY, left: clamp(left, size.width, view.width) }, fits: left >= margin };
      }
    }
  };
  for (const side of sides) {
    const option = at(side);
    if (option.fits) return option.place;
  }
  return at(sides[0] ?? "bottom").place;
}
