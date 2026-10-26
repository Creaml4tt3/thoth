// The arithmetic of a live reorder preview (tabs and sidebar sections): where a dragged item lands among the others,
// measured from the boxes cached when the drag started, and how far each other item slides aside to open the gap.
import { describe, expect, it } from "vitest";
import { gapBetween, previewShifts, slotIndex } from "../src/order/live-reorder.ts";

/** Four 100px items side by side with a 2px gap: 0–100, 102–202, 204–304, 306–406. */
const ROW = [0, 102, 204, 306].map((start) => ({ start, size: 100 }));
/** The same four in a right-to-left bar: the first is rightmost. */
const RTL = [306, 204, 102, 0].map((start) => ({ start, size: 100 }));

describe("slotIndex", () => {
  it("counts the others whose middle the dragged item's middle has passed", () => {
    const others = ROW.slice(1); // the first is dragged; B C D are left, middles 152, 254, 356
    expect(slotIndex(others, 40)).toBe(0);
    expect(slotIndex(others, 151)).toBe(0);
    expect(slotIndex(others, 153)).toBe(1);
    expect(slotIndex(others, 300)).toBe(2);
    expect(slotIndex(others, 999)).toBe(3);
  });

  it("reads a right-to-left bar from the right", () => {
    const others = RTL.slice(1); // middles 254, 152, 50
    expect(slotIndex(others, 400, true)).toBe(0);
    expect(slotIndex(others, 200, true)).toBe(1);
    expect(slotIndex(others, 10, true)).toBe(3);
  });

  it("measures the cached boxes moved by how far the list has scrolled since", () => {
    // The list scrolled 120px to the right: every item now sits 120px further left on screen.
    const others = ROW.slice(1);
    expect(slotIndex(others, 153)).toBe(1);
    expect(slotIndex(others, 153, false, 120)).toBe(2); // C's middle is at 134 now
  });
});

describe("gapBetween", () => {
  it("is the space between the first two items, either way round, and never negative", () => {
    expect(gapBetween(ROW)).toBe(2);
    expect(gapBetween(RTL, true)).toBe(2);
    expect(gapBetween([{ start: 0, size: 100 }])).toBe(0);
    expect(gapBetween([{ start: 0, size: 100 }, { start: 90, size: 100 }])).toBe(0);
  });
});

describe("previewShifts", () => {
  it("slides the items between the old and new place back by the dragged item's size and the gap", () => {
    // A (index 0) dragged to index 2: B and C move left by 102, D stays, A itself gets no shift (it follows the pointer).
    expect(previewShifts(4, 0, 2, 100, 2)).toEqual([0, -102, -102, 0]);
  });

  it("slides them forward when the item moves back", () => {
    expect(previewShifts(4, 3, 1, 100, 2)).toEqual([0, 102, 102, 0]);
    expect(previewShifts(4, 3, 0, 60, 4)).toEqual([64, 64, 64, 0]);
  });

  it("flips the direction in a right-to-left bar", () => {
    expect(previewShifts(4, 0, 2, 100, 2, true)).toEqual([0, 102, 102, 0]);
  });

  it("moves nothing where the item already is, or when it has no place in the list (out for a new window)", () => {
    expect(previewShifts(4, 1, 1, 100, 2)).toEqual([0, 0, 0, 0]);
    expect(previewShifts(4, 1, null, 100, 2)).toEqual([0, 0, 0, 0]);
  });
});
