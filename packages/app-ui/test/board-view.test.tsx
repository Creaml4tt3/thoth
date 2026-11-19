// @vitest-environment jsdom
// The Board view (ADR-0056): notes as buttons in an application region, select / open / move, strings that turn Moon
// for the selected note, pan and zoom, squares below 40 %, only notes in view in the DOM, the List view, the context
// menu, undo keys, reduced motion, and Thai titles that wrap inside a note.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardView, type BoardActions } from "../src/board/BoardView.tsx";
import type { BoardNote, BoardString } from "../src/board/model.ts";

const note = (path: string, x: number, y: number, extra: Partial<BoardNote> = {}): BoardNote => ({
  path, title: path.replace(/\.md$/, ""), excerpt: `About ${path}`, tags: [], color: null, x, y, state: "pinned", links: 0, ...extra,
});

const A = note("A.md", 0, 0, { tags: ["idea", "ocr"], links: 2, color: "blue" });
const B = note("B.md", 300, 0, { links: 1 });
const C = note("C.md", 0, 300, { links: 1 });
const notes = [A, B, C];
const strings: BoardString[] = [{ from: "A.md", to: "B.md" }, { from: "A.md", to: "C.md" }];

let reduced = false;
beforeEach(() => {
  reduced = false;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup(props: { notes?: BoardNote[]; strings?: BoardString[]; actions?: Partial<BoardActions>; noMove?: boolean } = {}) {
  const actions: BoardActions = { open: vi.fn(), ...(props.noMove ? {} : { move: vi.fn() }), ...props.actions };
  const view = render(<BoardView label="OCR research" notes={props.notes ?? notes} strings={props.strings ?? strings} actions={actions} />);
  const region = screen.getByRole("application", { name: "OCR research" });
  const plane = () => region.querySelector<HTMLElement>(".board-plane")!;
  return { actions, region, plane, container: view.container, user: userEvent.setup() };
}
const noteButton = (name: RegExp) => screen.getByRole("button", { name });
const activeStrings = (root: HTMLElement) => [...root.querySelectorAll("path[data-active]")].map((p) => `${p.getAttribute("data-from")}–${p.getAttribute("data-to")}`);

describe("BoardView", () => {
  it("is an application region with instructions, and each note is a button named by title, tags and links", () => {
    const { region } = setup();
    expect(region.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(region.getAttribute("aria-describedby")!)!.textContent).toMatch(/arrow keys/i);
    expect(noteButton(/^A,/).getAttribute("aria-label")).toBe("A, #idea #ocr, 2 links");
    expect(noteButton(/^B,/).getAttribute("aria-label")).toBe("B, 1 link");
    expect(noteButton(/^A,/).getAttribute("data-color")).toBe("blue");
    expect(noteButton(/^B,/).hasAttribute("data-color")).toBe(false);
    expect(noteButton(/^A,/).getAttribute("data-state")).toBe("pinned");
    // Strings are decoration: one quadratic path per pair, hidden from assistive technology.
    const svg = region.querySelector("svg.board-strings")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelectorAll("path")).toHaveLength(2);
    expect(svg.querySelector("path")!.getAttribute("d")).toMatch(/^M[\d.-]+ [\d.-]+Q/);
  });

  it("walks notes in reading order: top to bottom, then left to right", () => {
    setup({ notes: [note("Low.md", 0, 400), note("Right.md", 400, 0), note("Left.md", 0, 0)] });
    expect(screen.getAllByRole("button", { name: /links?$/ }).map((b) => b.getAttribute("aria-label")!.split(",")[0])).toEqual(["Left", "Right", "Low"]);
  });

  it("a click selects a note and turns its strings Moon; empty paper and Escape clear it", async () => {
    const { region, user } = setup();
    await user.click(noteButton(/^B,/));
    expect(noteButton(/^B,/).getAttribute("aria-pressed")).toBe("true");
    expect(noteButton(/^A,/).getAttribute("aria-pressed")).toBe("false");
    expect(activeStrings(region)).toEqual(["A.md–B.md"]);
    await user.click(noteButton(/^A,/));
    expect(activeStrings(region)).toEqual(["A.md–B.md", "A.md–C.md"]);
    fireEvent.pointerDown(region, { button: 0, clientX: 900, clientY: 700 });
    fireEvent.pointerUp(window, { button: 0, clientX: 900, clientY: 700 });
    expect(activeStrings(region)).toEqual([]);
    await user.click(noteButton(/^A,/));
    await user.keyboard("{Escape}");
    expect(noteButton(/^A,/).getAttribute("aria-pressed")).toBe("false");
  });

  it("double-click and Enter open the page; Cmd/Ctrl+click opens it in a new tab without selecting it", async () => {
    const { actions, user } = setup();
    await user.dblClick(noteButton(/^A,/));
    expect(actions.open).toHaveBeenLastCalledWith("A.md");
    noteButton(/^B,/).focus();
    await user.keyboard("{Enter}");
    expect(actions.open).toHaveBeenLastCalledWith("B.md");
    await user.keyboard("{Control>}");
    await user.click(noteButton(/^C,/));
    await user.keyboard("{/Control}");
    expect(actions.open).toHaveBeenLastCalledWith("C.md", { newTab: true });
    expect(noteButton(/^C,/).getAttribute("aria-pressed")).toBe("false");
  });

  it("arrow keys move the selected note 8 px, Shift 40 px", async () => {
    const { actions, user } = setup();
    await user.click(noteButton(/^B,/));
    await user.keyboard("{ArrowRight}");
    expect(actions.move).toHaveBeenLastCalledWith("B.md", 308, 0);
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(actions.move).toHaveBeenLastCalledWith("B.md", 308, 40);
    expect(noteButton(/^B,/).style.left).toBe("308px");
  });

  it("an unselected note does not move with the arrow keys", async () => {
    const { actions, user } = setup();
    noteButton(/^B,/).focus();
    await user.keyboard("{ArrowRight}");
    expect(actions.move).not.toHaveBeenCalled();
  });

  it("dragging a note lifts it, moves it on drop, and it wobbles for 300 ms", () => {
    vi.useFakeTimers();
    const { actions } = setup();
    const b = noteButton(/^B,/);
    fireEvent.pointerDown(b, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 12, clientY: 10 }); // under the 4 px threshold
    expect(b.hasAttribute("data-lifted")).toBe(false);
    fireEvent.pointerMove(window, { clientX: 40, clientY: 30 });
    expect(b.hasAttribute("data-lifted")).toBe(true);
    fireEvent.pointerUp(window, { clientX: 40, clientY: 30 });
    expect(actions.move).toHaveBeenCalledWith("B.md", 330, 20);
    expect(b.hasAttribute("data-lifted")).toBe(false);
    expect(b.hasAttribute("data-wobble")).toBe(true);
    act(() => void vi.advanceTimersByTime(300));
    expect(noteButton(/^B,/).hasAttribute("data-wobble")).toBe(false);
  });

  it("under prefers-reduced-motion a dropped note does not wobble", () => {
    reduced = true;
    const { actions } = setup();
    const b = noteButton(/^B,/);
    fireEvent.pointerDown(b, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 40, clientY: 10 });
    expect(actions.move).toHaveBeenCalledWith("B.md", 330, 0);
    expect(b.hasAttribute("data-wobble")).toBe(false);
  });

  it("without move (the Overview) a dragged note still moves for the session", () => {
    setup({ noMove: true });
    const b = noteButton(/^B,/);
    fireEvent.pointerDown(b, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 60, clientY: 10 });
    expect(b.style.left).toBe("350px");
  });

  it("dragging empty paper pans; Ctrl+wheel zooms around the pointer; plain wheel pans", () => {
    const { region, plane } = setup();
    const before = plane().style.transform;
    fireEvent.pointerDown(region, { button: 0, clientX: 900, clientY: 700 });
    fireEvent.pointerMove(window, { clientX: 950, clientY: 720 });
    fireEvent.pointerUp(window, { clientX: 950, clientY: 720 });
    const [x, y] = translate(plane());
    const [x0, y0] = translate({ style: { transform: before } } as HTMLElement);
    expect([x - x0, y - y0]).toEqual([50, 20]);
    fireEvent.wheel(region, { deltaX: 10, deltaY: 30 });
    expect(translate(plane())).toEqual([x - 10, y - 30]);
    fireEvent.wheel(region, { ctrlKey: true, deltaY: -100, clientX: 0, clientY: 0 });
    expect(zoom(plane())).toBeGreaterThan(1);
    // The point under the pointer (the region's corner) stays put: the translate scales with the zoom.
    const z = zoom(plane());
    expect(translate(plane())[0]).toBeCloseTo((x - 10) * z, 5);
  });

  it("+, - and 0 zoom; the zoom buttons and percent show it; zoom stays within 10 %–200 %", async () => {
    const { region, user } = setup();
    region.focus();
    await user.keyboard("-");
    expect(screen.getByText("80%")).toBeTruthy();
    await user.keyboard("0");
    expect(screen.getByText("100%")).toBeTruthy();
    await user.keyboard("=");
    expect(screen.getByText("125%")).toBeTruthy();
    for (let i = 0; i < 10; i++) await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("200%")).toBeTruthy();
    for (let i = 0; i < 20; i++) await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByText("10%")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Zoom to fit" }));
    expect(screen.queryByText("10%")).toBeNull();
  });

  it("below 40 % notes are coloured squares in one SVG, with no note buttons", async () => {
    const { region, user } = setup();
    for (let i = 0; i < 5; i++) await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByText("33%")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /links?$/ })).toEqual([]);
    const rects = region.querySelectorAll("svg.board-squares rect");
    expect(rects).toHaveLength(3);
    expect((rects[0] as SVGRectElement).style.fill).toContain("--thoth-note-blue");
  });

  it("only notes in view are in the DOM", () => {
    setup({ notes: [...notes, note("Far.md", 100_000, 100_000)] });
    expect(screen.queryByRole("button", { name: /^Far,/ })).toBeNull();
    expect(noteButton(/^A,/)).toBeTruthy();
  });

  it("List view shows the same notes and their links as a plain list", async () => {
    const { actions, user } = setup();
    const toggle = screen.getByRole("button", { name: "List view" });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("application")).toBeNull();
    const list = screen.getByRole("list", { name: "OCR research" });
    const a = within(list).getAllByRole("listitem")[0]!;
    expect(within(a).getByRole("list", { name: "Links of A" }).textContent).toBe("BC");
    await user.click(within(a).getByRole("button", { name: "A" }));
    expect(actions.open).toHaveBeenLastCalledWith("A.md");
    await user.click(toggle);
    expect(screen.getByRole("application")).toBeTruthy();
  });

  it("the context menu (Shift+F10) opens, opens in a new tab, removes and reveals", async () => {
    const unpin = vi.fn();
    const reveal = vi.fn();
    const { actions, user } = setup({ actions: { unpin, reveal } });
    noteButton(/^A,/).focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open", "Open in new tab", "Remove from board", "Reveal in sidebar"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Open in new tab" }));
    expect(actions.open).toHaveBeenLastCalledWith("A.md", { newTab: true });
    fireEvent.contextMenu(noteButton(/^A,/), { clientX: 20, clientY: 20 });
    await user.click(screen.getByRole("menuitem", { name: "Remove from board" }));
    expect(unpin).toHaveBeenCalledWith("A.md");
    fireEvent.keyDown(noteButton(/^A,/), { key: "ContextMenu" });
    await user.click(screen.getByRole("menuitem", { name: "Reveal in sidebar" }));
    expect(reveal).toHaveBeenCalledWith("A.md");
  });

  it("without unpin or reveal the menu has only Open and Open in new tab", async () => {
    const { user } = setup();
    noteButton(/^A,/).focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open", "Open in new tab"]);
  });

  it("a suggested note is faded and a click pins it; a missing note says so and can be removed", async () => {
    const pin = vi.fn();
    const unpin = vi.fn();
    const { user } = setup({
      notes: [A, note("S.md", 300, 0, { state: "suggested" }), note("Gone.md", 0, 300, { state: "missing", excerpt: "" })],
      actions: { pin, unpin },
    });
    const s = noteButton(/^S,/);
    expect(s.getAttribute("data-state")).toBe("suggested");
    expect(s.getAttribute("aria-label")).toBe("S, 0 links, suggested");
    await user.click(s);
    expect(pin).toHaveBeenCalledWith("S.md");
    const gone = noteButton(/^Gone,/);
    expect(gone.getAttribute("aria-label")).toBe("Gone, missing note");
    expect(gone.textContent).toContain("Missing note");
    gone.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect((screen.getByRole("menuitem", { name: "Open" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("menuitem", { name: "Remove from board" }));
    expect(unpin).toHaveBeenCalledWith("Gone.md");
  });

  it("Cmd/Ctrl+Z undoes and Shift+Cmd/Ctrl+Z redoes", async () => {
    const undo = vi.fn();
    const redo = vi.fn();
    const { region, user } = setup({ actions: { undo, redo } });
    region.focus();
    await user.keyboard("{Control>}z{/Control}");
    expect(undo).toHaveBeenCalledTimes(1);
    await user.keyboard("{Control>}{Shift>}Z{/Shift}{/Control}");
    expect(redo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("Thai titles wrap and clamp inside the note", () => {
    setup({ notes: [note("ไทย.md", 0, 0, { title: "บันทึกการวิจัยเรื่องการรู้จำอักขระด้วยแสงสำหรับภาษาไทยที่ยาวมาก" })] });
    const button = screen.getByRole("button", { name: /^บันทึก/ });
    const title = button.querySelector(".board-title")!;
    const excerpt = button.querySelector(".board-excerpt")!;
    expect(title).toBeTruthy();
    expect(excerpt).toBeTruthy();
    const css = readFileSync(fileURLToPath(import.meta.url).replace(/test[\\/][^\\/]+$/, "src/board/board.css"), "utf8");
    for (const cls of [".board-title", ".board-excerpt"]) {
      const rule = new RegExp(`${cls.replace(".", "\\.")}[^{]*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
      expect(rule).toMatch(/-webkit-line-clamp:\s*\d/);
    }
  });
});

function translate(el: HTMLElement): [number, number] {
  const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)/.exec(el.style.transform)!;
  return [Number(m[1]), Number(m[2])];
}
function zoom(el: HTMLElement): number {
  return Number(/scale\(([\d.e-]+)\)/.exec(el.style.transform)![1]);
}
