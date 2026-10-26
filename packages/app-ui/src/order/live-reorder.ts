/**
 * The arithmetic of a live reorder preview, for anything laid out in one line (tabs along the bar, sidebar sections down
 * the sidebar): while an item is dragged, the others slide aside to open a gap where it would land (ADR-0019 amendment).
 *
 * Everything here works on boxes cached when the drag started (`Span`: where an item starts on its axis and how long it
 * is), never on boxes read during the drag: the others are moved by transforms, and measuring moved items would make
 * the gap chase the pointer. A list that scrolls during the drag passes how far it has scrolled since (`scrolled`).
 */

/** An item's place on the axis of its list, in client pixels, as it was when the drag started. */
export interface Span {
  start: number;
  size: number;
}

/**
 * Where an item whose middle is at `center` lands among the `others` (in order, without it): the number of them whose
 * middle it has passed, in reading order (so from the right in a right-to-left bar). That is its new index.
 */
export function slotIndex(others: readonly Span[], center: number, reverse = false, scrolled = 0): number {
  let n = 0;
  for (const s of others) {
    const middle = s.start - scrolled + s.size / 2;
    if (reverse ? middle > center : middle < center) n++;
  }
  return n;
}

/** The space between neighbouring items: between the first two, in reading order; 0 with fewer than two. */
export function gapBetween(spans: readonly Span[], reverse = false): number {
  const [a, b] = spans;
  if (!a || !b) return 0;
  return Math.max(0, reverse ? a.start - (b.start + b.size) : b.start - (a.start + a.size));
}

/**
 * How far each of `count` items slides while the item at `from` is shown at index `to` (null: it has no place in the
 * list, for example dragged out for a new window, and nothing moves). The items between the two places make room by
 * the dragged item's `size` plus the `gap`; the dragged item itself gets 0 here (it follows the pointer).
 */
export function previewShifts(count: number, from: number, to: number | null, size: number, gap: number, reverse = false): number[] {
  const out = Array.from({ length: count }, () => 0);
  if (to === null || to === from) return out;
  const step = (size + gap) * (reverse ? -1 : 1);
  if (to > from) for (let i = from + 1; i <= to && i < count; i++) out[i] = -step;
  else for (let i = to; i < from; i++) out[i] = step;
  return out;
}
