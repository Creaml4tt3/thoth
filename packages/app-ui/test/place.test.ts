import { describe, expect, it } from "vitest";
import { placeBeside } from "../src/ui/place.ts";

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
const view = { width: 1000, height: 700 };
const size = { width: 300, height: 140 };

describe("placeBeside", () => {
  it("takes the first side where the box fits, centred on the element along that side", () => {
    expect(placeBeside(rect(0, 40, 260, 500), size, view, ["right", "bottom"], { gap: 10 })).toEqual({ side: "right", left: 270, top: 220 });
    expect(placeBeside(rect(300, 100, 200, 30), size, view, ["bottom", "top"], { gap: 10 })).toEqual({ side: "bottom", left: 250, top: 140 });
  });

  it("goes to the next side when one has no room: above an element at the bottom, left of one at the right edge", () => {
    expect(placeBeside(rect(300, 650, 200, 30), size, view, ["bottom", "top"], { gap: 10 })).toEqual({ side: "top", left: 250, top: 500 });
    expect(placeBeside(rect(880, 300, 100, 40), size, view, ["right", "left"], { gap: 10 })).toEqual({ side: "left", left: 570, top: 250 });
  });

  it("stays inside the window, by the margin: near a corner, and when no side fits (the first side, pushed in)", () => {
    expect(placeBeside(rect(0, 0, 40, 30), size, view, ["bottom"], { gap: 6, margin: 8 })).toEqual({ side: "bottom", left: 8, top: 36 });
    expect(placeBeside(rect(0, 0, 1000, 700), size, view, ["right", "bottom"], { gap: 6, margin: 8 })).toEqual({ side: "right", left: 692, top: 280 });
  });
});
