// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLTIP_DELAY_MS, TooltipLayer, isClipped, tip, tipIfClipped } from "../src/ui/Tooltip.tsx";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** jsdom has no layout: say how wide the text is and how wide its box is. */
function size(el: Element, scroll: number, client: number, extra: { height?: [number, number]; clamp?: boolean } = {}) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scroll });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: client });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: extra.height?.[0] ?? client });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: extra.height?.[1] ?? client });
  (el as HTMLElement).style.overflowX = "hidden";
  if (extra.clamp) (el as HTMLElement).style.setProperty("-webkit-line-clamp", "2");
}

const pointer = (el: Element) => fireEvent.pointerOver(el, { pointerType: "mouse" });
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

function Fixture({ cutOff }: { cutOff: boolean }) {
  return (
    <>
      <TooltipLayer />
      <button data-testid="row" {...tipIfClipped("The whole page title")}>
        <span data-testid="label">The whole pa…</span>
      </button>
      <button data-testid="icon" aria-label="New page" {...tip("New page", "⌘N")} />
      <span hidden>{String(cutOff)}</span>
    </>
  );
}

describe("isClipped", () => {
  it("is true for text wider than its box, or taller than a line clamp, and false when it fits", () => {
    const wide = document.createElement("div");
    size(wide, 200, 100);
    expect(isClipped(wide)).toBe(true);
    const fits = document.createElement("div");
    size(fits, 100, 100);
    expect(isClipped(fits)).toBe(false);
    const clamped = document.createElement("div");
    size(clamped, 100, 100, { height: [80, 40], clamp: true });
    expect(isClipped(clamped)).toBe(true);
    const taller = document.createElement("div");
    size(taller, 100, 100, { height: [80, 40] }); // no line clamp: a taller box is not "cut"
    expect(isClipped(taller)).toBe(false);
    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.append(child);
    size(child, 300, 100);
    expect(isClipped(parent)).toBe(true); // the cut text may be inside the element that has the tooltip
  });
});

describe("TooltipLayer", () => {
  it("shows the whole text of a cut-off element after a short delay, and not before", () => {
    render(<Fixture cutOff />);
    size(screen.getByTestId("label"), 300, 100);
    pointer(screen.getByTestId("label"));
    wait(TOOLTIP_DELAY_MS - 10);
    expect(screen.queryByRole("tooltip")).toBeNull();
    wait(20);
    expect(screen.getByRole("tooltip").textContent).toBe("The whole page title");
    expect(screen.getByTestId("row").getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
  });

  it("shows nothing for text that fits", () => {
    render(<Fixture cutOff={false} />);
    size(screen.getByTestId("label"), 100, 100);
    pointer(screen.getByTestId("label"));
    wait(2000);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("an icon button's tooltip is always there, with its shortcut", () => {
    render(<Fixture cutOff />);
    pointer(screen.getByTestId("icon"));
    wait(TOOLTIP_DELAY_MS + 1);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toBe("New page⌘N");
    expect(tooltip.querySelector("kbd")?.textContent).toBe("⌘N");
  });

  it("shows at once on keyboard focus, hides on blur, and hides on Escape without coming back for the same element", () => {
    render(<Fixture cutOff />);
    size(screen.getByTestId("label"), 300, 100);
    act(() => screen.getByTestId("row").focus());
    expect(screen.getByRole("tooltip").textContent).toBe("The whole page title");
    act(() => screen.getByTestId("row").blur());
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => screen.getByTestId("row").focus());
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByTestId("row").hasAttribute("aria-describedby")).toBe(false);
    pointer(screen.getByTestId("label"));
    wait(2000);
    expect(screen.queryByRole("tooltip")).toBeNull(); // dismissed: stays closed until the pointer leaves
    pointer(document.body);
    pointer(screen.getByTestId("label"));
    wait(TOOLTIP_DELAY_MS + 1);
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });

  it("hides when the pointer leaves, on a press, when a drag starts, and on scroll", () => {
    render(<Fixture cutOff />);
    const open = () => {
      pointer(screen.getByTestId("icon"));
      wait(TOOLTIP_DELAY_MS + 1);
      expect(screen.getByRole("tooltip")).toBeTruthy();
    };
    open();
    pointer(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
    for (const event of [() => fireEvent.pointerDown(screen.getByTestId("icon")), () => fireEvent.dragStart(screen.getByTestId("icon")), () => fireEvent.scroll(document)]) {
      pointer(document.body);
      open();
      event();
      expect(screen.queryByRole("tooltip")).toBeNull();
    }
  });

  it("does not show while a tree drag runs, and is quick when the pointer moves along neighbours", () => {
    render(<Fixture cutOff />);
    document.documentElement.setAttribute("data-tree-dragging", "");
    pointer(screen.getByTestId("icon"));
    wait(2000);
    expect(screen.queryByRole("tooltip")).toBeNull();
    document.documentElement.removeAttribute("data-tree-dragging");
    pointer(screen.getByTestId("icon"));
    wait(TOOLTIP_DELAY_MS + 1);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    pointer(document.body);
    pointer(screen.getByTestId("label")); // fits no cut-off rule here, but the delay is skipped right after a tooltip closed
    size(screen.getByTestId("label"), 300, 100);
    pointer(document.body);
    pointer(screen.getByTestId("label"));
    expect(screen.getByRole("tooltip").textContent).toBe("The whole page title");
  });

  it("sets the element's own title aside while it shows, and puts it back", () => {
    render(<Fixture cutOff />);
    const row = screen.getByTestId("row");
    row.setAttribute("title", "Docs/Plan.md");
    size(screen.getByTestId("label"), 300, 100);
    pointer(screen.getByTestId("label"));
    wait(TOOLTIP_DELAY_MS + 1);
    expect(row.hasAttribute("title")).toBe(false);
    pointer(document.body);
    expect(row.getAttribute("title")).toBe("Docs/Plan.md");
  });

  it("stays inside the window and goes above the element when there is no room below", () => {
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 400 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 300 });
    const rects = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const box = (x: number, y: number, w: number, h: number) => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
      return this.getAttribute("role") === "tooltip" ? box(0, 0, 120, 30) : box(2, 280, 20, 20); // an icon at the bottom-left corner
    });
    render(<Fixture cutOff />);
    pointer(screen.getByTestId("icon"));
    wait(TOOLTIP_DELAY_MS + 1);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.getAttribute("data-side")).toBe("top");
    expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(tooltip.style.top)).toBe(280 - 6 - 30);
    rects.mockRestore();
  });

  it("goes away with its element", () => {
    const { unmount } = render(<Fixture cutOff />);
    pointer(screen.getByTestId("icon"));
    wait(TOOLTIP_DELAY_MS + 1);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    unmount();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});

describe("tooltip style", () => {
  it("is themed with tokens, moves with the motion tokens (zero under reduced motion), and never takes the pointer", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const css = readFileSync(fileURLToPath(import.meta.url).replace(/test[\\/]tooltip\.test\.tsx$/, "src/ui.css"), "utf8");
    const rule = /\n\.tooltip \{([^}]*)\}/.exec(css)![1]!;
    expect(rule).toContain("animation: thoth-pop-in var(--thoth-dur-fast) var(--thoth-ease-out)");
    expect(rule).toContain("pointer-events: none");
    expect(rule).toContain("var(--thoth-shadow-pop)");
    expect(rule).not.toMatch(/#[0-9a-f]{3,6}\b|\d+ms|\d+s\b/i); // no literal colour or time
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after \{ animation: none !important/);
  });
});
