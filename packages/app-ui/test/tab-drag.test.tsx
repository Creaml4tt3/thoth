// @vitest-environment jsdom
// Reordering tabs and moving one out (ADR-0019): the tab bar's pointer drag, its drop indicator, the keyboard and the
// tab's menu. jsdom has no layout, so each tab is given a box: 100px wide, side by side, in a bar 32px high.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HintContext } from "../src/keyboard/hints.ts";
import { TabBar, type TabItem } from "../src/tabs/TabBar.tsx";

const WIDTH = 100;
const HEIGHT = 32;

function box(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}

/** How far a tab is moved by its inline `transform: translateX(…)` (what a browser's box includes); 0 for none. */
const shiftOf = (el: HTMLElement): number => Number(/translateX\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0);

/** Right to left (the tabs run from the right edge), and how far the list has scrolled (it moves every tab). */
const view = { rtl: false, scroll: 0 };

/**
 * Lays the bar out: tabs in DOM order, 100px each, from the left (or the right, right to left), the strip and the
 * list as wide as the window. A tab's box includes its transform and the list's scroll, as in a browser.
 */
function layout(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("tab")) {
      const i = [...document.querySelectorAll(".tablist > .tab")].indexOf(this);
      const left = view.rtl ? 1000 - (i + 1) * WIDTH : i * WIDTH;
      return box(left - view.scroll + shiftOf(this), 0, WIDTH, HEIGHT);
    }
    if (this.classList.contains("tablist") || this.classList.contains("tabstrip")) return box(0, 0, 1000, HEIGHT);
    return box(0, 0, 0, 0);
  });
  // jsdom has no scrolling: the list reports `view.scroll`, and a right-to-left list says so in its computed style.
  Object.defineProperty(HTMLElement.prototype, "scrollLeft", { configurable: true, get: () => view.scroll, set: () => undefined });
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
    const style = real(el, pseudo);
    return new Proxy(style, {
      get(target, key) {
        if (key === "direction") return view.rtl ? "rtl" : "ltr";
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  });
}

let reduced = false;
const animate = vi.fn();
beforeEach(() => {
  reduced = false;
  view.rtl = false;
  view.scroll = 0;
  layout();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  animate.mockReset();
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 700);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  delete (HTMLElement.prototype as unknown as { scrollLeft?: unknown }).scrollLeft;
});

const items = (...names: string[]): TabItem[] => names.map((n) => ({ id: n, label: n }));

interface Spies {
  onMove: ReturnType<typeof vi.fn<(id: string, to: number) => void>>;
  onDetach: ReturnType<typeof vi.fn<(id: string, at: { x: number; y: number } | null) => void>>;
  onActivate: ReturnType<typeof vi.fn<(id: string) => void>>;
  onClose: ReturnType<typeof vi.fn<(id: string) => void>>;
}

/** A bar that applies its own moves, as the apps do through `useTabs`. */
function Bar({ start, spies, detach = true }: { start: TabItem[]; spies: Spies; detach?: boolean }) {
  const [tabs, setTabs] = useState(start);
  const [active, setActive] = useState(start[0]!.id);
  return (
    <HintContext value={{ client: "desktop", platform: "other" }}>
      <TabBar
        tabs={tabs}
        active={active}
        onActivate={(id) => {
          spies.onActivate(id);
          setActive(id);
        }}
        onClose={(id) => {
          spies.onClose(id);
          setTabs((t) => t.filter((x) => x.id !== id));
        }}
        onNew={() => undefined}
        onMove={(id, to) => {
          spies.onMove(id, to);
          setTabs((t) => {
            const next = t.filter((x) => x.id !== id);
            next.splice(to, 0, t.find((x) => x.id === id)!);
            return next;
          });
        }}
        {...(detach
          ? {
              onDetach: (id: string, at: { x: number; y: number } | null) => {
                spies.onDetach(id, at);
                setTabs((t) => t.filter((x) => x.id !== id));
              },
            }
          : {})}
      />
    </HintContext>
  );
}

function setup(names = ["A", "B", "C", "D"], detach = true) {
  const spies: Spies = { onMove: vi.fn<(id: string, to: number) => void>(), onDetach: vi.fn<(id: string, at: { x: number; y: number } | null) => void>(), onActivate: vi.fn<(id: string) => void>(), onClose: vi.fn<(id: string) => void>() };
  render(<Bar start={items(...names)} spies={spies} detach={detach} />);
  return spies;
}

const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);
const tabEl = (name: string) => screen.getByRole("tab", { name }).closest(".tab") as HTMLElement;
const drops = () => [...document.querySelectorAll<HTMLElement>(".tab[data-drop]")].map((el) => `${el.textContent}: ${el.dataset["drop"]}`);
/** How far each tab is shifted right now, by name, in bar order. */
const shifts = () => Object.fromEntries([...document.querySelectorAll<HTMLElement>(".tablist > .tab")].map((el) => [el.textContent, shiftOf(el)]));

/** Presses on `name` and moves the pointer, as a hand does: down, a few pixels, then to each point. */
function press(name: string) {
  const el = tabEl(name);
  const at = el.getBoundingClientRect().left + 50;
  fireEvent.pointerDown(el, { clientX: at, clientY: 16, screenX: at + 300, screenY: 116, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse" });
  const move = (x: number, y = 16) => fireEvent.pointerMove(window, { clientX: x, clientY: y, screenX: x + 300, screenY: y + 100, buttons: 1, pointerId: 1, pointerType: "mouse" });
  return {
    move,
    up: (x: number, y = 16) => fireEvent.pointerUp(window, { clientX: x, clientY: y, screenX: x + 300, screenY: y + 100, button: 0, pointerId: 1, pointerType: "mouse" }),
    from: at,
  };
}

describe("dragging a tab along the bar", () => {
  it("lifts the tab, which follows the pointer, while the others slide aside to show where it will land", () => {
    const spies = setup();
    const drag = press("A");
    drag.move(drag.from + 8);
    expect(tabEl("A").dataset["dragging"]).toBe("");
    expect(shifts()).toEqual({ A: 8, B: 0, C: 0, D: 0 }); // still in its place: nobody moves aside
    drag.move(260); // its middle past B's and C's middles: B and C slide back to open the gap after them
    expect(shifts()).toEqual({ A: 210, B: -100, C: -100, D: 0 });
    drag.move(160); // past B's middle only
    expect(shifts()).toEqual({ A: 110, B: -100, C: 0, D: 0 });
    expect(drops()).toEqual([]); // the gap shows the place: no line
    expect(screen.queryByText("A", { selector: ".tab-drag-label" })).toBeNull(); // nor a picture under the pointer
    drag.up(160);
    expect(spies.onMove).toHaveBeenCalledWith("A", 1);
    expect(tabNames()).toEqual(["B", "A", "C", "D"]);
    expect(shifts()).toEqual({ A: 0, B: 0, C: 0, D: 0 });
    expect(tabEl("A").dataset["dragging"]).toBeUndefined();
    expect(spies.onActivate).not.toHaveBeenCalled(); // a drag is not a click
  });

  it("drags to the very start and the very end, and the tab stays within the bar", () => {
    const spies = setup();
    let drag = press("C");
    drag.move(drag.from - 10);
    drag.move(5);
    expect(shifts()).toEqual({ A: 100, B: 100, C: -200, D: 0 }); // C's left edge stops at the bar's start
    drag.up(5);
    expect(tabNames()).toEqual(["C", "A", "B", "D"]);
    drag = press("C");
    drag.move(drag.from + 10);
    drag.move(990);
    expect(shifts()).toEqual({ C: 300, A: -100, B: -100, D: -100 }); // and its right edge at the last tab's end
    drag.up(990);
    expect(spies.onMove).toHaveBeenLastCalledWith("C", 3);
    expect(tabNames()).toEqual(["A", "B", "D", "C"]);
  });

  it("in a right-to-left bar, the others slide the other way", () => {
    view.rtl = true; // A is rightmost: 900–1000, then B 800, C 700, D 600
    const spies = setup();
    const drag = press("A");
    drag.move(drag.from - 10);
    drag.move(740); // past B's (850) and C's (750) middles, reading from the right
    expect(shifts()).toEqual({ A: -210, B: 100, C: 100, D: 0 });
    drag.up(740);
    expect(spies.onMove).toHaveBeenCalledWith("A", 2);
  });

  it("measures from where the tabs were when the drag began, plus how far the bar has scrolled since", () => {
    setup();
    const drag = press("A");
    drag.move(drag.from + 10);
    drag.move(160);
    expect(shifts()).toEqual({ A: 110, B: -100, C: 0, D: 0 });
    view.scroll = 100; // the bar scrolls by 100px (at an edge): every tab is 100px further left on screen
    drag.move(161);
    // A stays under the pointer (its own place moved with the scroll), and now its middle is past C's too.
    expect(shifts()).toEqual({ A: 211, B: -100, C: -100, D: 0 });
  });

  it("only the dropped tab settles into the gap; the others are already where they land", () => {
    setup();
    const drag = press("A");
    drag.move(drag.from + 10);
    drag.move(260);
    drag.up(260);
    expect(tabNames()).toEqual(["B", "C", "A", "D"]);
    expect(animate).toHaveBeenCalledTimes(1);
    const [frames] = animate.mock.calls[0] as [Keyframe[]];
    expect(frames).toEqual([{ transform: "translateX(10px)" }, { transform: "translateX(0)" }]); // from under the pointer (260) to its place (200)
  });

  it("a press that hardly moves is a click", () => {
    const spies = setup();
    const drag = press("B");
    drag.move(drag.from + 2);
    drag.up(drag.from + 2);
    fireEvent.click(screen.getByRole("tab", { name: "B" }));
    expect(spies.onMove).not.toHaveBeenCalled();
    expect(spies.onActivate).toHaveBeenCalledWith("B");
  });

  it("Escape puts the tab back where it was, and everything slides back", () => {
    const spies = setup();
    const drag = press("A");
    drag.move(drag.from + 10);
    drag.move(260);
    expect(shifts()).toEqual({ A: 210, B: -100, C: -100, D: 0 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(shifts()).toEqual({ A: 0, B: 0, C: 0, D: 0 });
    // Each tab that was moved slides from where it was shown back to its place.
    expect(animate.mock.calls.map(([frames]) => (frames as Keyframe[])[0])).toEqual([{ transform: "translateX(210px)" }, { transform: "translateX(-100px)" }, { transform: "translateX(-100px)" }]);
    drag.up(260);
    expect(spies.onMove).not.toHaveBeenCalled();
    expect(tabNames()).toEqual(["A", "B", "C", "D"]);
  });

  it("a drag cancelled with Escape does not open the tab when the button is let go later", async () => {
    const spies = setup();
    const drag = press("B");
    drag.move(drag.from + 10);
    drag.move(360);
    fireEvent.keyDown(window, { key: "Escape" });
    // A person lets go of the button well after pressing Escape.
    await act(() => new Promise((r) => setTimeout(r, 20)));
    drag.up(360);
    fireEvent.click(screen.getByRole("tab", { name: "B" }));
    expect(spies.onActivate).not.toHaveBeenCalled();
    // The next real click opens it.
    await act(() => new Promise((r) => setTimeout(r, 5)));
    fireEvent.click(screen.getByRole("tab", { name: "B" }));
    expect(spies.onActivate).toHaveBeenCalledWith("B");
  });

  it("a cancelled pointer or the window losing focus puts everything back too", () => {
    const spies = setup();
    let drag = press("B");
    drag.move(drag.from + 10);
    drag.move(360);
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(shifts()).toEqual({ A: 0, B: 0, C: 0, D: 0 });
    drag = press("B");
    drag.move(drag.from + 10);
    drag.move(360);
    fireEvent.blur(window);
    expect(shifts()).toEqual({ A: 0, B: 0, C: 0, D: 0 });
    drag.up(360);
    expect(spies.onMove).not.toHaveBeenCalled();
  });

  it("says where the tab went, for a screen reader", () => {
    setup();
    const drag = press("A");
    drag.move(drag.from + 10);
    drag.move(260);
    drag.up(260);
    expect(document.querySelector("[data-tabs-said]")?.textContent).toBe("A moved to position 3 of 4");
  });
});

describe("dragging a tab out of the bar (desktop)", () => {
  it("well below the bar, it offers a new window: the others go back to their places, and come aside again back in the bar", () => {
    const spies = setup();
    const drag = press("B");
    drag.move(drag.from + 10);
    drag.move(360);
    expect(shifts()).toEqual({ A: 0, B: 200, C: -100, D: -100 });
    drag.move(200, 140);
    expect(shifts()).toEqual({ A: 0, B: 0, C: 0, D: 0 }); // the dragged tab waits in its place, the picture follows the pointer
    expect(tabEl("B").dataset["detach"]).toBe("");
    expect(screen.getByText("Release to open in a new window")).toBeTruthy();
    drag.move(360);
    expect(shifts()).toEqual({ A: 0, B: 200, C: -100, D: -100 });
    expect(screen.queryByText("Release to open in a new window")).toBeNull();
    drag.move(200, 140);
    drag.up(220, 150);
    expect(spies.onDetach).toHaveBeenCalledWith("B", { x: 520, y: 250 });
    expect(spies.onMove).not.toHaveBeenCalled();
    expect(screen.queryByText("Release to open in a new window")).toBeNull();
  });

  it("let go outside the window, it opens a new one there too", () => {
    const spies = setup();
    const drag = press("A");
    drag.move(drag.from + 10);
    drag.move(1200, 10);
    drag.up(1200, 10);
    expect(spies.onDetach).toHaveBeenCalledWith("A", { x: 1500, y: 110 });
  });

  it("just below the bar is still a reorder", () => {
    const spies = setup();
    const drag = press("A");
    drag.move(drag.from + 10);
    drag.move(260, HEIGHT + 20);
    expect(shifts()).toEqual({ A: 210, B: -100, C: -100, D: 0 }); // the tab stays in the bar: it moves along it only
    drag.up(260, HEIGHT + 20);
    expect(spies.onMove).toHaveBeenCalledWith("A", 2);
    expect(spies.onDetach).not.toHaveBeenCalled();
  });

  it("the only tab of a window, and the web client, have no new window to go to", () => {
    let spies = setup(["Only"]);
    let drag = press("Only");
    drag.move(drag.from + 10);
    drag.move(50, 300);
    expect(screen.queryByText("Release to open in a new window")).toBeNull();
    drag.up(50, 300);
    expect(spies.onDetach).not.toHaveBeenCalled();
    cleanup();

    spies = setup(["A", "B"], false);
    drag = press("A");
    drag.move(drag.from + 10);
    drag.move(160, 300);
    expect(screen.queryByText("Release to open in a new window")).toBeNull();
    drag.up(160, 300);
    expect(spies.onMove).toHaveBeenCalledWith("A", 1); // on the web it is only ever a reorder
  });
});

describe("the keyboard", () => {
  it("Alt+Shift+Right and Left move the focused tab and keep focus on it; the ends stop it", async () => {
    const spies = setup(["A", "B", "C"]);
    const a = screen.getByRole("tab", { name: "A" });
    a.focus();
    fireEvent.keyDown(a, { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(spies.onMove).toHaveBeenLastCalledWith("A", 1);
    expect(tabNames()).toEqual(["B", "A", "C"]);
    await act(() => new Promise((r) => setTimeout(r, 5)));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "A" }));
    expect(document.querySelector("[data-tabs-said]")?.textContent).toBe("A moved to position 2 of 3");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft", altKey: true, shiftKey: true });
    expect(tabNames()).toEqual(["A", "B", "C"]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft", altKey: true, shiftKey: true });
    expect(spies.onMove).toHaveBeenCalledTimes(2); // already first
    expect(screen.getByRole("tab", { name: "A" }).getAttribute("aria-keyshortcuts")).toContain("Alt+Shift+ArrowRight");
  });

  it("does not animate a move made with the keyboard", async () => {
    setup(["A", "B", "C"]);
    const a = screen.getByRole("tab", { name: "A" });
    a.focus();
    fireEvent.keyDown(a, { key: "ArrowRight", altKey: true, shiftKey: true });
    await act(() => new Promise((r) => setTimeout(r, 5)));
    expect(animate).not.toHaveBeenCalled();
  });
});

describe("the tab's menu", () => {
  it("opens on right click with Move left, Move right, Move tab to new window and Close", () => {
    const spies = setup(["A", "B", "C"]);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "A" }), { clientX: 40, clientY: 20 });
    const menu = screen.getByRole("menu", { name: "Tab: A" });
    const item = (name: string) => within(menu).getByRole("menuitem", { name: new RegExp(`^${name}`) }) as HTMLButtonElement;
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Move tab leftAlt+Shift+←", "Move tab rightAlt+Shift+→", "Move tab to new window", "Close tab"]);
    expect(item("Move tab left").disabled).toBe(true); // already first
    fireEvent.click(item("Move tab right"));
    expect(spies.onMove).toHaveBeenCalledWith("A", 1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Shift+F10 opens it from the keyboard; Escape gives focus back to the tab", () => {
    setup(["A", "B"]);
    const b = screen.getByRole("tab", { name: "B" });
    b.focus();
    fireEvent.keyDown(b, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "Tab: B" });
    expect(document.activeElement?.closest('[role="menu"]')).toBe(menu);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "B" }));
  });

  it("Move tab to new window sends the tab away, and focus goes to the tab that is current", async () => {
    const spies = setup(["A", "B", "C"]);
    const b = screen.getByRole("tab", { name: "B" });
    b.focus();
    fireEvent.keyDown(b, { key: "ContextMenu" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Move tab to new window" }));
    expect(spies.onDetach).toHaveBeenCalledWith("B", null);
    expect(tabNames()).toEqual(["A", "C"]);
    await act(() => new Promise((r) => setTimeout(r, 5)));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "A" }));
  });

  it("has no new window for the only tab, nor on the web", () => {
    setup(["A"]);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "A" }), { clientX: 10, clientY: 10 });
    expect((screen.getByRole("menuitem", { name: "Move tab to new window" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    setup(["A", "B"], false);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "A" }), { clientX: 10, clientY: 10 });
    expect(screen.queryByRole("menuitem", { name: "Move tab to new window" })).toBeNull();
  });
});

describe("motion", () => {
  it("after a drop, the tabs that changed place slide there (transform only)", () => {
    setup();
    const drag = press("A");
    drag.move(drag.from + 10);
    drag.move(260);
    drag.up(260);
    expect(animate).toHaveBeenCalled();
    for (const [frames] of animate.mock.calls as [Keyframe[]][]) {
      for (const frame of frames) expect(Object.keys(frame).filter((k) => k !== "offset" && k !== "easing")).toEqual(["transform"]);
    }
  });

  it("does not move at all with reduced motion", () => {
    reduced = true;
    setup();
    const drag = press("A");
    drag.move(drag.from + 10);
    drag.move(260);
    drag.up(260);
    expect(tabNames()).toEqual(["B", "C", "A", "D"]);
    expect(animate).not.toHaveBeenCalled();
  });
});

describe("dragging a tab to a pane (ADR-0030)", () => {
  /** A bar whose pane zone is everything right of x = 600 and below the bar. */
  function withZone() {
    const spies = { onMove: vi.fn(), onDetach: vi.fn(), drop: vi.fn(), show: vi.fn() };
    render(
      <HintContext value={{ client: "desktop", platform: "other" }}>
        <TabBar
          tabs={items("A", "B", "C")}
          active="A"
          onActivate={() => undefined}
          onClose={() => undefined}
          onNew={() => undefined}
          onMove={spies.onMove}
          onDetach={spies.onDetach}
          paneDrop={{ at: (x, y) => (x > 600 && y > HEIGHT ? "split" : null), label: () => "Release to split right", show: spies.show, drop: spies.drop }}
        />
      </HintContext>,
    );
    return spies;
  }

  it("over the zone, a release moves the tab there: not a new window, not a reorder", () => {
    const spies = withZone();
    const drag = press("B");
    drag.move(drag.from + 10);
    drag.move(800, 300);
    expect(screen.getByText("Release to split right")).toBeTruthy();
    expect(shifts()).toEqual({ A: 0, B: 0, C: 0 });
    expect(spies.show).toHaveBeenLastCalledWith(true, "split");
    drag.up(800, 300);
    expect(spies.drop).toHaveBeenCalledWith("B", "split");
    expect(spies.onDetach).not.toHaveBeenCalled();
    expect(spies.onMove).not.toHaveBeenCalled();
    expect(spies.show).toHaveBeenLastCalledWith(false, null);
  });

  it("elsewhere below the bar it is still a new window, and the shell is told a drag is on", () => {
    const spies = withZone();
    const drag = press("B");
    drag.move(drag.from + 10);
    expect(spies.show).toHaveBeenLastCalledWith(true, null);
    drag.move(200, 300);
    drag.up(200, 300);
    expect(spies.onDetach).toHaveBeenCalled();
    expect(spies.drop).not.toHaveBeenCalled();
  });
});
