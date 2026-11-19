// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select, type SelectOption } from "../src/ui/Select.tsx";
import { Modal } from "../src/ui/Modal.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const FRUIT: SelectOption<string>[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana", disabled: true },
  { value: "cherry", label: "Cherry" },
  { value: "date", label: "Date" },
];

function Harness({ options = FRUIT, initial = "apple", disabled, onChange }: { options?: SelectOption<string>[]; initial?: string; disabled?: boolean; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <Select
      value={value}
      options={options}
      aria-label="Fruit"
      disabled={disabled}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

const box = () => screen.getByRole("combobox", { name: "Fruit" });
const list = () => screen.queryByRole("listbox");
const active = () => {
  const id = box().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent : null;
};

describe("Select", () => {
  it("shows the chosen label and the combobox roles", () => {
    render(<Harness initial="cherry" />);
    expect(box().textContent).toContain("Cherry");
    expect(box().getAttribute("aria-haspopup")).toBe("listbox");
    expect(box().getAttribute("aria-expanded")).toBe("false");
    expect(box().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it.each<[string, { altKey?: boolean }]>([["Enter", {}], [" ", {}], ["ArrowDown", { altKey: true }]])("opens on %s, on the chosen option", (key, extra) => {
    render(<Harness initial="cherry" />);
    box().focus();
    fireEvent.keyDown(box(), { key, ...extra });
    const lb = list()!;
    expect(lb).toBeTruthy();
    expect(box().getAttribute("aria-expanded")).toBe("true");
    expect(box().getAttribute("aria-controls")).toBe(lb.id);
    expect(active()).toBe("Cherry");
    expect(within(lb).getByRole("option", { name: "Cherry" }).getAttribute("aria-selected")).toBe("true");
    expect(within(lb).getByRole("option", { name: "Apple" }).getAttribute("aria-selected")).toBe("false");
    expect(within(lb).getByRole("option", { name: "Banana" }).getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(box());
  });

  it("opens on a click, and a second click closes it", () => {
    render(<Harness />);
    fireEvent.click(box());
    expect(list()).toBeTruthy();
    fireEvent.click(box());
    expect(list()).toBeNull();
  });

  it("ArrowDown/Up/Home/End move the active option and skip disabled ones", () => {
    render(<Harness />);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(active()).toBe("Apple");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(active()).toBe("Cherry");
    fireEvent.keyDown(box(), { key: "End" });
    expect(active()).toBe("Date");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(active()).toBe("Date");
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(active()).toBe("Apple");
    fireEvent.keyDown(box(), { key: "End" });
    fireEvent.keyDown(box(), { key: "Home" });
    expect(active()).toBe("Apple");
  });

  it("ArrowDown on a closed select opens it", () => {
    render(<Harness />);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(list()).toBeTruthy();
  });

  it("Enter chooses and closes, focus stays on the button", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    box().focus();
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("cherry");
    expect(list()).toBeNull();
    expect(box().textContent).toContain("Cherry");
    expect(document.activeElement).toBe(box());
  });

  it("a click on an option chooses it; a disabled one does nothing", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(box());
    fireEvent.click(screen.getByRole("option", { name: "Banana" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(list()).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Date" }));
    expect(onChange).toHaveBeenCalledWith("date");
    expect(list()).toBeNull();
  });

  it("does not call onChange when the chosen option is chosen again", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(list()).toBeNull();
  });

  it("Escape closes without changing and does not reach a parent keydown listener", () => {
    const onChange = vi.fn();
    const parent = vi.fn();
    render(
      <div onKeyDown={parent}>
        <Harness onChange={onChange} />
      </div>,
    );
    fireEvent.keyDown(box(), { key: "Enter" });
    parent.mockClear();
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    parent.mockClear();
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(list()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(parent).not.toHaveBeenCalled();
    // Closed, Escape is the parent's again.
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(parent).toHaveBeenCalledTimes(1);
  });

  it("Escape inside a Modal closes the list only; a second Escape closes the dialog", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Move" onClose={onClose}>
        <Harness />
      </Modal>,
    );
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(list()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tab chooses the active option and closes, without stopping focus from moving on", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.keyDown(box(), { key: "End" });
    const tab = fireEvent.keyDown(box(), { key: "Tab" });
    expect(tab).toBe(true); // not prevented: the browser moves focus on
    expect(onChange).toHaveBeenCalledWith("date");
    expect(list()).toBeNull();
  });

  it("a click outside closes without changing", () => {
    const onChange = vi.fn();
    render(
      <>
        <p>Outside</p>
        <Harness onChange={onChange} />
      </>,
    );
    fireEvent.click(box());
    fireEvent.pointerDown(screen.getByText("Outside"));
    expect(list()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("type-ahead jumps by first letter, Thai included, and a pause starts a new search", () => {
    vi.useFakeTimers();
    const thai: SelectOption<string>[] = [
      { value: "a", label: "กา" },
      { value: "b", label: "ไก่" },
      { value: "c", label: "ขา" },
      { value: "d", label: "ไข่" },
    ];
    render(<Harness options={thai} initial="a" />);
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.keyDown(box(), { key: "ไ" });
    expect(active()).toBe("ไก่");
    fireEvent.keyDown(box(), { key: "ข" });
    expect(active()).toBe("ไข่");
    act(() => vi.advanceTimersByTime(600));
    fireEvent.keyDown(box(), { key: "ข" });
    expect(active()).toBe("ขา");
  });

  it("type-ahead on a closed select opens it at the match (the WAI-ARIA pattern); case does not matter", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(box(), { key: "d" });
    expect(list()).toBeTruthy();
    expect(active()).toBe("Date");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Space while typing a search is part of the search, not a choice", () => {
    const onChange = vi.fn();
    render(<Harness options={[{ value: "a", label: "New York" }, { value: "b", label: "New Delhi" }, { value: "c", label: "Newark" }]} initial="c" onChange={onChange} />);
    fireEvent.keyDown(box(), { key: "Enter" });
    for (const key of ["n", "e", "w", " ", "d"]) fireEvent.keyDown(box(), { key });
    expect(list()).toBeTruthy();
    expect(active()).toBe("New Delhi");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens upward when there is no room below, and stays inside the window", () => {
    vi.stubGlobal("innerHeight", 600);
    render(<Harness />);
    box().getBoundingClientRect = () => ({ top: 560, bottom: 590, left: 20, right: 220, width: 200, height: 30, x: 20, y: 560, toJSON: () => ({}) });
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.getAttribute("role") === "listbox") return { top: 0, bottom: 160, left: 0, right: 200, width: 200, height: 160, x: 0, y: 0, toJSON: () => ({}) };
      return original.call(this);
    };
    try {
      fireEvent.keyDown(box(), { key: "Enter" });
      const lb = list()!;
      expect(lb.dataset["side"]).toBe("top");
      const top = parseFloat(lb.style.top);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top + 160).toBeLessThanOrEqual(600);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
      vi.unstubAllGlobals();
    }
  });

  it("stays open when something around it scrolls (a dialog growing), and follows its button", () => {
    render(<Harness />);
    let top = 100;
    box().getBoundingClientRect = () => ({ top, bottom: top + 30, left: 20, right: 220, width: 200, height: 30, x: 20, y: top, toJSON: () => ({}) });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    try {
      fireEvent.click(box());
      expect(parseFloat(list()!.style.top)).toBe(134);
      fireEvent.scroll(document);
      expect(list()).toBeTruthy();
      top = 200;
      act(() => frames.shift()?.(0));
      expect(parseFloat(list()!.style.top)).toBe(234);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a press on the list's padding or scrollbar keeps focus on the button, so Escape still closes only the list", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Move" onClose={onClose}>
        <Harness />
      </Modal>,
    );
    fireEvent.click(box());
    expect(fireEvent.mouseDown(list()!)).toBe(false); // prevented: focus does not move to the dialog
  });

  it("an option can say its language, for a screen reader (a language named in itself)", () => {
    render(<Harness options={[{ value: "en", label: "English", lang: "en" }, { value: "th", label: "ไทย", lang: "th" }]} initial="th" />);
    expect(box().querySelector(".select-value")!.getAttribute("lang")).toBe("th");
    fireEvent.click(box());
    expect(screen.getByRole("option", { name: "English" }).getAttribute("lang")).toBe("en");
  });

  it("measures the list's layout height, not its size mid-animation, to choose a side", () => {
    vi.stubGlobal("innerHeight", 600);
    render(<Harness />);
    box().getBoundingClientRect = () => ({ top: 400, bottom: 430, left: 20, right: 220, width: 200, height: 30, x: 20, y: 400, toJSON: () => ({}) });
    const rect = HTMLElement.prototype.getBoundingClientRect;
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      // scaled to 0.97 by the open animation
      if (this.getAttribute("role") === "listbox") return { top: 0, bottom: 155, left: 0, right: 194, width: 194, height: 155, x: 0, y: 0, toJSON: () => ({}) };
      return rect.call(this);
    };
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: HTMLElement) { return this.getAttribute("role") === "listbox" ? 160 : 0; } });
    try {
      fireEvent.click(box());
      expect(list()!.dataset["side"]).toBe("top"); // 160 does not fit in the 158 below
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect;
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
      vi.unstubAllGlobals();
    }
  });

  it("closes when its button scrolls out of the area that shows it, instead of floating over the rest", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    render(
      <div className="page-scroll" style={{ overflowY: "auto" }}>
        <Harness />
      </div>,
    );
    const scroller = document.querySelector<HTMLElement>(".page-scroll")!;
    scroller.getBoundingClientRect = () => ({ top: 100, bottom: 500, left: 0, right: 800, width: 800, height: 400, x: 0, y: 100, toJSON: () => ({}) });
    let top = 200;
    box().getBoundingClientRect = () => ({ top, bottom: top + 30, left: 20, right: 220, width: 200, height: 30, x: 20, y: top, toJSON: () => ({}) });
    try {
      fireEvent.click(box());
      act(() => frames.shift()?.(0));
      expect(list()).toBeTruthy();
      top = 40; // scrolled up under whatever is above the area (the tab bar)
      act(() => frames.shift()?.(0));
      expect(list()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a disabled select does not open", () => {
    render(<Harness disabled />);
    expect((box() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(box());
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(list()).toBeNull();
  });

  it("a description is the option's accessible description", () => {
    render(<Harness options={[{ value: "x", label: "Ex", description: "The letter" }, { value: "y", label: "Why" }]} initial="x" />);
    fireEvent.click(box());
    const option = screen.getByRole("option", { name: "Ex" });
    expect(document.getElementById(option.getAttribute("aria-describedby")!)?.textContent).toBe("The letter");
  });
});
