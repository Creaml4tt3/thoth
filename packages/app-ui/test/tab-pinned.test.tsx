// @vitest-environment jsdom
// Pinned tabs in the tab bar (ADR-0027): compact at the start, no close button, a menu to pin and unpin, and a drag
// that stops at the boundary between pinned and unpinned tabs. jsdom has no layout, so each tab is 100px wide.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HintContext } from "../src/keyboard/hints.ts";
import { close, closeOthers, initialTabs, move, setPinned, type TabsState } from "../src/tabs/model.ts";
import { TabBar } from "../src/tabs/TabBar.tsx";

const WIDTH = 100;
function box(left: number, width: number, height = 32): DOMRect {
  return { x: left, y: 0, left, top: 0, width, height, right: left + width, bottom: height, toJSON: () => ({}) } as DOMRect;
}
const shiftOf = (el: HTMLElement): number => Number(/translateX\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0);

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("tab")) {
      const i = [...document.querySelectorAll(".tablist > .tab")].indexOf(this);
      return box(i * WIDTH + shiftOf(this), WIDTH);
    }
    if (this.classList.contains("tablist") || this.classList.contains("tabstrip")) return box(0, 1000);
    return box(0, 0, 0);
  });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 700);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const page = (path: string) => ({ kind: "page" as const, path });

/** A bar over the real tab model, as the apps wire it through `useTabs`. */
function Bar({ start }: { start: TabsState }) {
  const [state, setState] = useState(start);
  const label = (id: string) => {
    const t = state.tabs.find((x) => x.id === id)!.target;
    return t.kind === "page" ? t.path.replace(/\.md$/, "") : t.kind;
  };
  return (
    <HintContext value={{ client: "desktop", platform: "other" }}>
      <TabBar
        tabs={state.tabs.map((t) => ({ id: t.id, label: label(t.id), ...(t.pinned ? { pinned: true } : {}) }))}
        active={state.active}
        onActivate={(id) => setState((s) => ({ ...s, active: id }))}
        onClose={(id) => setState((s) => close(s, id))}
        onNew={() => undefined}
        onMove={(id, to) => setState((s) => move(s, id, to))}
        onPin={(id, pinned) => setState((s) => setPinned(s, id, pinned))}
        onCloseOthers={(id) => setState((s) => closeOthers(s, id))}
      />
    </HintContext>
  );
}

function setup(pinned: string[] = []) {
  let s = initialTabs([page("Alpha.md"), page("Beta.md"), page("Gamma.md"), page("Delta.md")], 0);
  for (const name of pinned) s = setPinned(s, s.tabs.find((t) => t.target.kind === "page" && t.target.path === `${name}.md`)!.id, true);
  render(<Bar start={s} />);
}

const tabs = () => screen.getAllByRole("tab");
const names = () => tabs().map((t) => t.getAttribute("aria-label") ?? t.textContent);
const openMenu = (name: RegExp) => {
  fireEvent.contextMenu(screen.getByRole("tab", { name }), { clientX: 10, clientY: 10 });
  return screen.getByRole("menu");
};

describe("pinned tabs in the bar", () => {
  it("Pin tab in the tab's menu moves it to the start and makes it compact, named in full for a screen reader", () => {
    setup();
    const menu = openMenu(/^Gamma$/);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Pin tab" }));
    expect(names()).toEqual(["Gamma, pinned", "Alpha", "Beta", "Delta"]);
    const gamma = screen.getByRole("tab", { name: "Gamma, pinned" });
    const box = gamma.closest(".tab") as HTMLElement;
    expect(box.dataset["pinned"]).toBe("");
    expect(gamma.textContent).toBe("Ga"); // the first letters
    expect(gamma.getAttribute("data-tip")).toBe("Gamma"); // the full title on hover and focus
    expect(box.querySelector(".tab-close")).toBeNull(); // nothing to close it by accident
    expect(screen.getByText("Gamma pinned", { selector: "[data-tabs-said]" })).toBeTruthy();
  });

  it("Unpin tab puts it back first among the others, with its close button", () => {
    setup(["Beta", "Delta"]);
    expect(names()).toEqual(["Beta, pinned", "Delta, pinned", "Alpha", "Gamma"]);
    fireEvent.click(within(openMenu(/^Beta, pinned$/)).getByRole("menuitem", { name: "Unpin tab" }));
    expect(names()).toEqual(["Delta, pinned", "Beta", "Alpha", "Gamma"]);
    expect(screen.getByRole("tab", { name: "Beta" }).closest(".tab")!.querySelector(".tab-close")).not.toBeNull();
  });

  it("a pinned tab's menu has no Close; Close other tabs leaves the pinned ones", () => {
    setup(["Alpha"]);
    const pinnedMenu = openMenu(/^Alpha, pinned$/);
    expect(within(pinnedMenu).queryByRole("menuitem", { name: "Close tab" })).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.click(within(openMenu(/^Gamma$/)).getByRole("menuitem", { name: "Close other tabs" }));
    expect(names()).toEqual(["Alpha, pinned", "Gamma"]);
  });

  it("middle-click and Delete do not close a pinned tab, and say how to", () => {
    setup(["Alpha"]);
    const alpha = screen.getByRole("tab", { name: "Alpha, pinned" });
    fireEvent(alpha, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "Delete" });
    expect(names()).toEqual(["Alpha, pinned", "Beta", "Gamma", "Delta"]);
    expect(screen.getByText("Pinned tab: unpin it to close it", { selector: "[data-tabs-said]" })).toBeTruthy();
  });

  it("Alt+Shift+Right stops at the boundary", async () => {
    setup(["Alpha", "Beta"]);
    const beta = screen.getByRole("tab", { name: "Beta, pinned" });
    beta.focus();
    fireEvent.keyDown(beta, { key: "ArrowRight", altKey: true, shiftKey: true });
    await act(() => new Promise((r) => setTimeout(r, 1)));
    expect(names()).toEqual(["Alpha, pinned", "Beta, pinned", "Gamma", "Delta"]);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Beta, pinned" }), { key: "ArrowLeft", altKey: true, shiftKey: true });
    await act(() => new Promise((r) => setTimeout(r, 1)));
    expect(names()).toEqual(["Beta, pinned", "Alpha, pinned", "Gamma", "Delta"]);
  });

  it("a drag stops at the boundary, and the live preview opens no gap past it", () => {
    setup(["Alpha"]);
    const delta = screen.getByRole("tab", { name: "Delta" }).closest(".tab") as HTMLElement;
    fireEvent.pointerDown(delta, { clientX: 350, clientY: 16, button: 0, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerMove(window, { clientX: 340, clientY: 16, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 16, pointerId: 1, pointerType: "mouse" }); // over the pinned tab
    const shifts = Object.fromEntries([...document.querySelectorAll<HTMLElement>(".tablist > .tab")].map((el) => [el.querySelector('[role="tab"]')!.getAttribute("aria-label") ?? el.textContent, shiftOf(el)]));
    expect(shifts["Alpha, pinned"]).toBe(0); // the pinned tab does not slide aside
    expect(shifts["Beta"]).toBe(100);
    fireEvent.pointerUp(window, { clientX: 20, clientY: 16, pointerId: 1, pointerType: "mouse" });
    expect(names()).toEqual(["Alpha, pinned", "Delta", "Beta", "Gamma"]);
  });
});
