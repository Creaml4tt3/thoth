// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_DEFAULT, SidebarResizer, clampSidebar, parseSidebarWidth, sidebarMax, useSidebarWidth } from "../src/ui/SidebarResizer.tsx";

function setViewport(width: number) {
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width });
  act(() => void window.dispatchEvent(new Event("resize")));
}

/** A shell with the resizer, and the store behind it. */
function Harness({ stored, save }: { stored: number | null; save(width: number | null): void }) {
  const shell = useRef<HTMLDivElement>(null);
  const sidebar = useSidebarWidth({ initial: () => stored, save });
  return (
    <div ref={shell} className="shell" data-testid="shell" style={sidebar.style}>
      <SidebarResizer sidebar={sidebar} shell={shell} />
    </div>
  );
}

const handle = () => screen.getByRole("separator", { name: "Resize sidebar" });
const width = () => screen.getByTestId("shell").style.getPropertyValue("--thoth-sidebar-width");

beforeEach(() => {
  setViewport(1200);
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("limits", () => {
  it("is 200 to 480px, or 40% of the window if that is less", () => {
    expect(sidebarMax(1200)).toBe(480);
    expect(sidebarMax(2000)).toBe(480);
    expect(sidebarMax(800)).toBe(320);
    expect(sidebarMax(300)).toBe(200); // never under the minimum
    expect(clampSidebar(100, 1200)).toBe(200);
    expect(clampSidebar(900, 1200)).toBe(480);
    expect(clampSidebar(900, 800)).toBe(320);
  });

  it("reads back only a whole number in range", () => {
    expect(parseSidebarWidth("300")).toBe(300);
    for (const bad of [null, undefined, "", "abc", "300px", "99", "481", "1e3", "-300", "300.5"]) expect(parseSidebarWidth(bad)).toBeNull();
  });
});

describe("the separator", () => {
  it("is a focusable vertical separator with its value, minimum and maximum", () => {
    render(<Harness stored={null} save={() => undefined} />);
    expect(handle().getAttribute("tabindex")).toBe("0");
    expect(handle().getAttribute("aria-orientation")).toBe("vertical");
    expect(handle().getAttribute("aria-valuenow")).toBe(String(SIDEBAR_DEFAULT));
    expect(handle().getAttribute("aria-valuemin")).toBe("200");
    expect(handle().getAttribute("aria-valuemax")).toBe("480");
    expect(width()).toBe("260px");
  });

  it("starts from the stored width", () => {
    render(<Harness stored={340} save={() => undefined} />);
    expect(handle().getAttribute("aria-valuenow")).toBe("340");
    expect(width()).toBe("340px");
  });

  it("Left and Right move it by 16px, Shift by 64px, Home and End go to the ends, Enter resets; each is stored", () => {
    const save = vi.fn();
    render(<Harness stored={null} save={save} />);
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(handle().getAttribute("aria-valuenow")).toBe("276");
    expect(save).toHaveBeenLastCalledWith(276);
    fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    expect(handle().getAttribute("aria-valuenow")).toBe("340");
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(handle().getAttribute("aria-valuenow")).toBe("324");
    fireEvent.keyDown(handle(), { key: "End" });
    expect(handle().getAttribute("aria-valuenow")).toBe("480");
    fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    expect(handle().getAttribute("aria-valuenow")).toBe("480");
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(handle().getAttribute("aria-valuenow")).toBe("200");
    fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
    expect(handle().getAttribute("aria-valuenow")).toBe("200");
    fireEvent.keyDown(handle(), { key: "Enter" });
    expect(handle().getAttribute("aria-valuenow")).toBe("260");
    expect(save).toHaveBeenLastCalledWith(null); // the default is stored as nothing
    expect(width()).toBe("260px");
  });

  it("a double-click resets and forgets", () => {
    const save = vi.fn();
    render(<Harness stored={400} save={save} />);
    fireEvent.doubleClick(handle());
    expect(handle().getAttribute("aria-valuenow")).toBe("260");
    expect(save).toHaveBeenCalledWith(null);
  });

  it("a pointer drag follows the pointer one frame at a time, marks the shell while it runs, and stores once at the end", () => {
    const save = vi.fn();
    render(<Harness stored={null} save={save} />);
    const shell = screen.getByTestId("shell");
    fireEvent.pointerDown(handle(), { button: 0, clientX: 260, pointerId: 1 });
    expect(shell.hasAttribute("data-resizing")).toBe(true);
    fireEvent.pointerMove(handle(), { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 360, pointerId: 1 });
    expect(width()).toBe("260px"); // nothing is written until the frame
    act(() => void vi.advanceTimersByTime(20));
    expect(width()).toBe("360px");
    expect(handle().getAttribute("aria-valuenow")).toBe("360");
    expect(save).not.toHaveBeenCalled();
    fireEvent.pointerMove(handle(), { clientX: 2000, pointerId: 1 });
    act(() => void vi.advanceTimersByTime(20));
    expect(width()).toBe("480px"); // the limit
    fireEvent.pointerMove(handle(), { clientX: -500, pointerId: 1 });
    act(() => void vi.advanceTimersByTime(20));
    expect(width()).toBe("200px");
    fireEvent.pointerMove(handle(), { clientX: 330, pointerId: 1 });
    fireEvent.pointerUp(handle(), { pointerId: 1 });
    expect(shell.hasAttribute("data-resizing")).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(330);
    expect(handle().getAttribute("aria-valuenow")).toBe("330");
  });

  it("Escape during a drag puts the old width back and stores nothing; a press without a move stores nothing", () => {
    const save = vi.fn();
    render(<Harness stored={300} save={save} />);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 400, pointerId: 1 });
    act(() => void vi.advanceTimersByTime(20));
    expect(width()).toBe("400px");
    fireEvent.keyDown(handle(), { key: "Escape" });
    expect(width()).toBe("300px");
    expect(screen.getByTestId("shell").hasAttribute("data-resizing")).toBe(false);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 300, pointerId: 2 });
    fireEvent.pointerUp(handle(), { pointerId: 2 });
    expect(save).not.toHaveBeenCalled();
  });

  it("only the main button drags", () => {
    render(<Harness stored={null} save={() => undefined} />);
    fireEvent.pointerDown(handle(), { button: 2, clientX: 260, pointerId: 1 });
    expect(screen.getByTestId("shell").hasAttribute("data-resizing")).toBe(false);
  });

  it("a smaller window clamps what is shown and gives the chosen width back when it grows", () => {
    render(<Harness stored={480} save={() => undefined} />);
    setViewport(800);
    expect(handle().getAttribute("aria-valuemax")).toBe("320");
    expect(handle().getAttribute("aria-valuenow")).toBe("320");
    expect(width()).toBe("320px");
    setViewport(1200);
    expect(handle().getAttribute("aria-valuenow")).toBe("480");
  });
});
