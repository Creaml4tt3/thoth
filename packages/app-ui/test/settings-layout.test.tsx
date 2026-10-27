// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsLayout } from "../src/ui/SettingsLayout.tsx";

/** jsdom has no IntersectionObserver: this one lets a test say which sections are on screen. */
let observed: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];
class FakeObserver {
  targets: Element[] = [];
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observed.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {}
}
const show = (visible: string[]) =>
  act(() => {
    for (const o of observed)
      o.callback(o.targets.map((target) => ({ target, isIntersecting: visible.includes(target.querySelector("h2")!.id) }) as unknown as IntersectionObserverEntry), o as unknown as IntersectionObserver);
  });

beforeEach(() => {
  observed = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as Element["scrollTo"];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Fixture({ extra = false }: { extra?: boolean }) {
  const sections = [
    { id: "s-a", label: "Alpha" },
    { id: "s-b", label: "Beta" },
    { id: "s-c", label: "Gamma" },
  ];
  return (
    <SettingsLayout sections={sections}>
      <h1>Settings</h1>
      {["s-a", "s-b"].map((id) => (
        <section key={id} aria-labelledby={id}>
          <h2 id={id}>{id}</h2>
        </section>
      ))}
      {extra && (
        <section aria-labelledby="s-c">
          <h2 id="s-c">s-c</h2>
        </section>
      )}
    </SettingsLayout>
  );
}

describe("SettingsLayout", () => {
  it("lists only the sections on the page, as links to their headings", async () => {
    const { rerender } = render(<Fixture />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Alpha", "#s-a"],
      ["Beta", "#s-b"],
    ]);
    rerender(<Fixture extra />);
    expect(await within(nav).findByRole("link", { name: "Gamma" })).toBeTruthy();
  });

  it("a link scrolls to its section and moves focus to its heading", () => {
    render(<Fixture />);
    fireEvent.click(screen.getByRole("link", { name: "Beta" }));
    const heading = document.getElementById("s-b")!;
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("-1");
    const scroller = document.querySelector(".settings-scroll")!;
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" }); // no matchMedia: reduced motion
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Beta" }).getAttribute("aria-current")).toBe("true");
  });

  it("scrolls smoothly unless reduced motion is asked for", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
    render(<Fixture />);
    fireEvent.click(screen.getByRole("link", { name: "Alpha" }));
    expect(document.querySelector(".settings-scroll")!.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("scrolls only its own area, to the section's top less its scroll margin, never an ancestor (the WebKit trap)", () => {
    const { container } = render(
      <div className="pane">
        <Fixture extra />
      </div>,
    );
    const scroller = container.querySelector<HTMLElement>(".settings-scroll")!;
    const section = document.getElementById("s-c")!.closest("section")!;
    scroller.scrollTop = 40;
    scroller.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    section.getBoundingClientRect = () => ({ top: 700 }) as DOMRect;
    section.style.scrollMarginTop = "16px";
    fireEvent.click(screen.getByRole("link", { name: "Gamma" }));
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 700 - 100 + 40 - 16, behavior: "auto" });
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(vi.mocked(Element.prototype.scrollTo).mock.contexts.every((c) => c === scroller)).toBe(true);
    expect(screen.getByRole("link", { name: "Gamma" }).getAttribute("aria-current")).toBe("true");
    // The keyboard path: Enter on a focused link is a click, so it scrolls the same way.
    fireEvent.click(screen.getByRole("link", { name: "Beta" }), { detail: 0 });
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps the chosen section marked (a short last one cannot reach the top) until the person scrolls", () => {
    render(<Fixture extra />);
    fireEvent.click(screen.getByRole("link", { name: "Gamma" }));
    show(["s-b", "s-c"]);
    expect(screen.getByRole("link", { name: "Gamma" }).getAttribute("aria-current")).toBe("true");
    fireEvent.wheel(document.querySelector(".settings-scroll")!);
    show(["s-b"]);
    expect(screen.getByRole("link", { name: "Beta" }).getAttribute("aria-current")).toBe("true");
  });

  it("marks the first section in view as current", () => {
    render(<Fixture />);
    expect(screen.getByRole("link", { name: "Alpha" }).getAttribute("aria-current")).toBe("true");
    show(["s-b"]);
    expect(screen.getByRole("link", { name: "Beta" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("link", { name: "Alpha" }).hasAttribute("aria-current")).toBe(false);
  });
});
