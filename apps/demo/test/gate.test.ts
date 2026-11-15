// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { arm, mayLoad } from "../src/gate.ts";

const media = (matching: string[]) => ({ innerHeight: 800, matchMedia: (q: string) => ({ matches: matching.includes(q) }) as MediaQueryList });
const PHONE = "(max-width: 640px)";
const REDUCED_DATA = "(prefers-reduced-data: reduce)";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function page() {
  document.body.innerHTML = '<div data-thoth-demo="compare"><p id="capture">capture</p><button data-thoth-demo-load>Try it here</button></div>';
  return document.querySelector<HTMLElement>("[data-thoth-demo]")!;
}

describe("mayLoad", () => {
  it("is yes on a desktop with data to spare", () => expect(mayLoad({ window: media([]), connection: undefined })).toBe(true));
  it.each([
    ["a phone", media([PHONE]), undefined],
    ["Save-Data", media([]), { saveData: true }],
    ["a reduced-data preference", media([REDUCED_DATA]), undefined],
  ])("is no on %s", (_name, window, connection) => expect(mayLoad({ window, connection })).toBe(false));
});

describe("arm", () => {
  it("does not load on a phone, not even from the button, and leaves the capture alone", () => {
    const root = page();
    const load = vi.fn();
    arm({ document, window: media([PHONE]), load });
    root.querySelector<HTMLElement>("[data-thoth-demo-load]")!.click();
    expect(load).not.toHaveBeenCalled();
    expect(document.getElementById("capture")).not.toBeNull();
  });

  it("does not load under Save-Data", () => {
    const root = page();
    const load = vi.fn();
    arm({ document, window: media([]), connection: { saveData: true }, load });
    root.querySelector<HTMLElement>("[data-thoth-demo-load]")!.click();
    expect(load).not.toHaveBeenCalled();
  });

  it("loads once, from the button", () => {
    const root = page();
    const load = vi.fn();
    arm({ document, window: media([]), load });
    const button = root.querySelector<HTMLElement>("[data-thoth-demo-load]")!;
    button.click();
    button.click();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(root);
  });

  it("loads when the root comes within a screen of the viewport", () => {
    const root = page();
    let report: (entries: Partial<IntersectionObserverEntry>[]) => void = () => undefined;
    const observed: { margin: string | undefined }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof report, options?: IntersectionObserverInit) {
          report = callback;
          observed.push({ margin: options?.rootMargin });
        }
        observe() {}
        unobserve() {}
      },
    );
    const load = vi.fn();
    arm({ document, window: media([]), load });
    expect(observed[0]?.margin).toBe("800px 0px");
    expect(load).not.toHaveBeenCalled();
    report([{ target: root, isIntersecting: false }]);
    expect(load).not.toHaveBeenCalled();
    report([{ target: root, isIntersecting: true }]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
