// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextMenu, type MenuItem } from "../src/order/ContextMenu.tsx";

const items: MenuItem[] = [
  { id: "a", label: "Rename", onSelect() {} },
  { id: "b", label: "Delete", onSelect() {} },
];

/** jsdom has no layout: every menu measures as `w` × `h`, and the window is `vw` × `vh`. */
function layout(w: number, h: number, vw = 800, vh = 600) {
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: vw });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: vh });
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (!this.classList.contains("ctx-menu")) return new DOMRect(0, 0, 0, 0);
    return new DOMRect(0, 0, w, Math.min(h, parseFloat(this.style.maxHeight) || h));
  };
}

const original = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => layout(200, 100));
afterEach(() => {
  cleanup();
  HTMLElement.prototype.getBoundingClientRect = original;
});

const menu = (x: number, y: number) => {
  render(<ContextMenu label="Page" at={{ x, y }} items={items} onClose={() => {}} />);
  return screen.getByRole("menu");
};

describe("ContextMenu placement", () => {
  it("opens at the point when it fits", () => {
    const el = menu(100, 100);
    expect(el.style.left).toBe("100px");
    expect(el.style.top).toBe("100px");
    expect(el.style.visibility).not.toBe("hidden");
  });

  it("flips above the point near the bottom edge and to the left near the right edge", () => {
    const el = menu(700, 560);
    expect(el.style.top).toBe("460px"); // 560 - 100
    expect(el.style.left).toBe("500px"); // 700 - 200
  });

  it("clamps inside the window with an 8 px margin when flipping does not fit either", () => {
    layout(200, 100, 250, 150);
    const el = menu(60, 60);
    expect(el.style.left).toBe("42px"); // 250 - 8 - 200
    expect(el.style.top).toBe("42px"); // 150 - 8 - 100
  });

  it("caps a menu taller than the window and lets it scroll", () => {
    layout(200, 900, 800, 600);
    const el = menu(100, 300);
    expect(el.style.maxHeight).toBe("584px"); // 600 - 2 × 8
    expect(el.style.overflowY).toBe("auto");
    expect(el.style.top).toBe("8px");
  });
});
