// @vitest-environment jsdom
/**
 * The Thoth mascot (features/mascot): the shared state machine and its two versions, the shrink/expand control and
 * shortcut and Auto size, its preferences and their bounds, drag by pointer and keyboard with snapping and clamping
 * after a resize, the prompt bubble (open, close, focus back), run events to states, and the still pose for reduced
 * motion. The app parts run on the Node test host with the fake Claude Code CLI; nothing calls a model.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, editorBox, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";
import { FAKE_CLAUDE_DIR } from "../../../tests/helpers/agent.ts";
import { MASCOT_STATES, MascotArt, type MascotState } from "../src/features/mascot/MascotArt.tsx";
import { DONE_MS, SLEEP_AFTER_MS, mascotState, nextChange, type MascotInputs } from "../src/features/mascot/state.ts";
import { DEFAULT_MASCOT_PREFS, MASCOT_PREFS_KEY, clampScale, parseMascotPrefs } from "../src/features/mascot/prefs.ts";
import { CORNER_REACH, EDGE_MARGIN, boxSize, clampPoint, defaultInsets, facingFor, pointFor, positionFor, snapPoint } from "../src/features/mascot/placement.ts";
import { KEY_SNAP_MS } from "../src/features/mascot/Mascot.tsx";
import { TYPING_IDLE_MS } from "../src/features/mascot/hooks.ts";
import { setLangPreference } from "../src/strings/index.ts";

const base: MascotInputs = { phase: "idle", record: null, waiting: 0, bubbleOpen: false, doneAt: null, lastActivity: 1000, windowActive: true, now: 1000 };

describe("the state machine", () => {
  it("maps run events to states: start → working, awaiting review → review, success → done, failure → error", () => {
    expect(mascotState(base)).toBe("idle");
    expect(mascotState({ ...base, phase: "starting" })).toBe("working");
    expect(mascotState({ ...base, phase: "running", bubbleOpen: true })).toBe("working");
    expect(mascotState({ ...base, phase: "cancelling" })).toBe("working");
    expect(mascotState({ ...base, phase: "review", record: "review" })).toBe("review");
    expect(mascotState({ ...base, phase: "applying", record: "review" })).toBe("review");
    expect(mascotState({ ...base, phase: "finished", record: "applied", doneAt: 1000 })).toBe("done");
    expect(mascotState({ ...base, phase: "finished", record: "done", doneAt: 1000, bubbleOpen: true })).toBe("done");
    expect(mascotState({ ...base, phase: "finished", record: "failed" })).toBe("error");
    expect(mascotState({ ...base, phase: "finished", record: "failed", bubbleOpen: true })).toBe("error");
    // Cancelled and discarded are not a success.
    expect(mascotState({ ...base, phase: "finished", record: "cancelled" })).toBe("idle");
    expect(mascotState({ ...base, phase: "finished", record: "discarded" })).toBe("idle");
  });

  it("listens while the bubble is open, says done for a few seconds, and sleeps when idle or in the background", () => {
    expect(mascotState({ ...base, bubbleOpen: true })).toBe("listening");
    const done = { ...base, phase: "finished" as const, record: "applied" as const, doneAt: 1000 };
    expect(mascotState({ ...done, now: 1000 + DONE_MS - 1 })).toBe("done");
    expect(mascotState({ ...done, now: 1000 + DONE_MS })).toBe("idle");
    expect(nextChange({ ...done, now: 1500 })).toBe(1000 + DONE_MS);
    expect(mascotState({ ...base, now: 1000 + SLEEP_AFTER_MS })).toBe("sleeping");
    expect(nextChange(base)).toBe(1000 + SLEEP_AFTER_MS);
    expect(mascotState({ ...base, windowActive: false })).toBe("sleeping");
    // Work is never hidden by sleep.
    expect(mascotState({ ...base, phase: "running", windowActive: false })).toBe("working");
    expect(mascotState({ ...base, waiting: 1, windowActive: false })).toBe("review");
  });
});

describe("the two versions", () => {
  const parts = (el: Element) => [...el.querySelectorAll("[data-part][data-state]")].map((p) => [p.getAttribute("data-part"), p.getAttribute("data-state")]);

  it.each(MASCOT_STATES)("full and compact show the same state, and switching keeps it (%s)", (state: MascotState) => {
    const view = render(<MascotArt state={state} version="full" />);
    const svg = view.container.querySelector("svg")!;
    expect(svg.dataset["state"]).toBe(state);
    expect(parts(svg)).toEqual([
      ["full", state],
      ["compact", state],
    ]);
    view.rerender(<MascotArt state={state} version="compact" />);
    // The same element: a morph, never a remount (a pop).
    expect(view.container.querySelector("svg")).toBe(svg);
    expect([svg.dataset["state"], svg.dataset["version"]]).toEqual([state, "compact"]);
    expect(parts(svg)).toEqual([
      ["full", state],
      ["compact", state],
    ]);
    view.unmount();
  });

  it("is hand-drawn SVG with no raster and no hard-coded silhouette colour", () => {
    const { container } = render(<MascotArt state="idle" version="full" />);
    expect(container.querySelectorAll("image, foreignObject").length).toBe(0);
    for (const el of container.querySelectorAll("[fill]")) expect(el.getAttribute("fill"), el.outerHTML).not.toMatch(/^#/);
  });
});

describe("preferences", () => {
  it("parses what was stored, falls back to the defaults, and keeps the scale in bounds", () => {
    expect(parseMascotPrefs(null)).toEqual(DEFAULT_MASCOT_PREFS);
    expect(parseMascotPrefs("not json")).toEqual(DEFAULT_MASCOT_PREFS);
    expect(parseMascotPrefs(JSON.stringify({ show: false, size: "compact", scale: 120, motion: "calm", snap: false, position: { h: "left", x: 30, v: "top", y: 60 } }))).toEqual({ show: false, size: "compact", scale: 120, motion: "calm", snap: false, position: { h: "left", x: 30, v: "top", y: 60 } });
    expect(parseMascotPrefs(JSON.stringify({ size: "huge", motion: "wild", position: { h: "middle", x: 1, v: "top", y: 2 } }))).toMatchObject({ size: "auto", motion: "full", position: null });
    expect([clampScale(10), clampScale(500), clampScale(113), clampScale(Number.NaN), clampScale("90")]).toEqual([80, 140, 110, 100, 100]);
  });
});

describe("placement", () => {
  const view = { width: 1200, height: 800 };
  const insets = defaultInsets(48);

  it("remembers a position from its nearest edges, so it stays in its corner when the window changes", () => {
    const box = boxSize("full", 100);
    expect(box).toBe(88);
    expect(boxSize("compact", 140)).toBe(73);
    const pos = positionFor({ left: 1088, top: 688 }, box, view);
    expect(pos).toEqual({ h: "right", x: 24, v: "bottom", y: 24 });
    expect(facingFor(pos)).toBe("left");
    expect(pointFor(pos, box, { width: 1600, height: 900 }, insets)).toEqual({ left: 1488, top: 788 });
  });

  it("clamps into the window below the tab strip, and snaps to the nearest edge or corner", () => {
    expect(clampPoint({ left: -50, top: 0 }, 88, view, insets)).toEqual({ left: insets.left, top: 48 });
    expect(clampPoint({ left: 5000, top: 5000 }, 88, view, insets)).toEqual({ left: 1200 - insets.right - 88, top: 800 - insets.bottom - 88 });
    // Near the right edge, in the middle of the height: onto the right edge only.
    expect(snapPoint({ left: 1080, top: 400 }, 88, view, insets)).toEqual({ left: 1200 - insets.right - EDGE_MARGIN / 2 - 88, top: 400 });
    // Near the bottom-left corner: into the corner.
    const corner = snapPoint({ left: 40, top: 800 - 88 - CORNER_REACH / 2 }, 88, view, insets);
    expect(corner).toEqual({ left: insets.left + EDGE_MARGIN / 2, top: 800 - insets.bottom - EDGE_MARGIN / 2 - 88 });
  });
});

// ---------------------------------------------------------------- in the app

const dirs = tempDirs();
let root: string;
let data: string;
beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  data = await dirs.dir("thoth-ui-mascot-data-");
  await seed(root, { "Diary.md": "# Diary\n\nToday.\n" });
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setLangPreference("system");
  await dirs.cleanup();
});

async function openWithMascot(): Promise<Harness> {
  const app = await openApp(root, {}, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } }));
  await screen.findByRole("tree", { name: "Pages in this Private Space" });
  await screen.findByRole("button", { name: /^Thoth assistant/ });
  return app;
}
const mascot = () => screen.getByRole("button", { name: /^Thoth assistant/ });
const layer = () => screen.getByTestId("mascot");
const art = () => layer().querySelector("svg")!;
const translate = () => /translate3d\((-?\d+)px, (-?\d+)px/.exec(layer().style.transform)!.slice(1).map(Number);
const stored = () => JSON.parse(localStorage.getItem(MASCOT_PREFS_KEY) ?? "{}");
function resize(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  act(() => void window.dispatchEvent(new Event("resize")));
}

describe("the mascot in the window", () => {
  beforeEach(() => resize(1200, 800));

  it("is a named button that says its state, in English and Thai", async () => {
    await openWithMascot();
    expect(mascot().getAttribute("aria-label")).toBe("Thoth assistant, ready");
    expect(mascot().getAttribute("aria-haspopup")).toBe("dialog");
    expect(mascot().getAttribute("aria-keyshortcuts")).toMatch(/^(Meta|Control)\+J$/);
    expect(layer().dataset["state"]).toBe("idle");
    cleanup();
    setLangPreference("th");
    const app = await openApp(root, {}, createNodePlatform({ vault: root, agents: { dataDir: data, searchDirs: [FAKE_CLAUDE_DIR] } }));
    void app;
    expect((await screen.findByRole("button", { name: /^ผู้ช่วย Thoth/ })).getAttribute("aria-label")).toBe("ผู้ช่วย Thoth, พร้อม");
  });

  it("opens the bubble on click, puts focus in the task, closes on Escape and gives focus back", async () => {
    const app = await openWithMascot();
    await app.user.click(mascot());
    const dialog = await screen.findByRole("dialog", { name: "Ask Thoth" });
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    expect(mascot().getAttribute("aria-expanded")).toBe("true");
    expect(layer().dataset["state"]).toBe("listening");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("textbox", { name: "Task" })));
    await app.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Ask Thoth" })).toBeNull();
    expect(document.activeElement).toBe(mascot());
    expect(mascot().getAttribute("aria-expanded")).toBe("false");
    // The shortcut opens it too, and the close button closes it.
    await app.user.keyboard("{Meta>}j{/Meta}");
    const again = await screen.findByRole("dialog", { name: "Ask Thoth" });
    await app.user.click(within(again).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Ask Thoth" })).toBeNull();
    expect(document.activeElement).toBe(mascot());
  });

  it("closes the bubble on a press outside it", async () => {
    const app = await openWithMascot();
    await app.user.click(mascot());
    await screen.findByRole("dialog", { name: "Ask Thoth" });
    await app.user.click(await editorBox());
    expect(screen.queryByRole("dialog", { name: "Ask Thoth" })).toBeNull();
  });

  it("shrinks and expands with its button and the shortcut, keeping its state, and remembers the size", async () => {
    const app = await openWithMascot();
    const svg = art();
    expect(svg.dataset["version"]).toBe("full");
    await app.user.click(within(layer()).getByRole("button", { name: "Shrink the assistant" }));
    expect([art().dataset["version"], art().dataset["state"]]).toEqual(["compact", "idle"]);
    expect(art()).toBe(svg); // one drawing, morphed
    expect(stored().size).toBe("compact");
    expect(layer().style.width).toBe("52px");
    await app.user.keyboard("{Meta>}{Shift>}j{/Shift}{/Meta}");
    expect(art().dataset["version"]).toBe("full");
    expect(stored().size).toBe("full");
    expect(within(layer()).getByRole("button", { name: "Shrink the assistant" }).getAttribute("aria-keyshortcuts")).toMatch(/\+Shift\+J$/);
    // The palette has it as well.
    await app.user.keyboard("{Meta>}k{/Meta}");
    await app.user.keyboard(">shrink");
    expect(await screen.findByRole("option", { name: /Shrink or expand the assistant/ })).toBeTruthy();
  });

  it("Auto size: compact while typing in the editor and in a narrow window, full again after", async () => {
    const app = await openWithMascot();
    expect(art().dataset["version"]).toBe("full");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const box = await editorBox();
    fireEvent.keyDown(box.querySelector("p") ?? box, { key: "a" });
    expect(art().dataset["version"]).toBe("compact");
    expect(art().dataset["state"]).toBe("idle");
    await act(async () => void vi.advanceTimersByTime(TYPING_IDLE_MS + 50));
    expect(art().dataset["version"]).toBe("full");
    resize(800, 700);
    expect(art().dataset["version"]).toBe("compact");
    resize(1200, 800);
    expect(art().dataset["version"]).toBe("full");
    void app;
  });

  it("drags with the pointer, snaps to the edge when let go, and remembers where", async () => {
    await openWithMascot();
    const [x0, y0] = translate();
    expect([x0, y0]).toEqual([1200 - 24 - 88, 800 - 24 - 88]);
    fireEvent.pointerDown(mascot(), { pointerId: 1, button: 0, clientX: 1130, clientY: 730 });
    fireEvent.pointerMove(mascot(), { pointerId: 1, clientX: 900, clientY: 430 });
    expect(layer().dataset["dragging"]).toBe("");
    expect(translate()).toEqual([x0! - 230, y0! - 300]);
    fireEvent.pointerUp(mascot(), { pointerId: 1, clientX: 600 + 400, clientY: 430 });
    // It was dropped in the right half, mid-height: onto the right edge, at that height.
    const [x1, y1] = translate();
    expect(x1).toBe(1200 - defaultInsets().right - EDGE_MARGIN / 2 - 88);
    expect(y1).toBe(y0! - 300);
    expect(layer().dataset["settling"]).toBe("");
    expect(stored().position).toEqual({ h: "right", x: 1200 - x1! - 88, v: "bottom", y: 800 - y1! - 88 });
    // A drag is not a click: no bubble.
    expect(screen.queryByRole("dialog", { name: "Ask Thoth" })).toBeNull();
    // A small move is still a click.
    fireEvent.pointerDown(mascot(), { pointerId: 2, button: 0, clientX: 1100, clientY: 400 });
    fireEvent.pointerMove(mascot(), { pointerId: 2, clientX: 1102, clientY: 401 });
    fireEvent.pointerUp(mascot(), { pointerId: 2, clientX: 1102, clientY: 401 });
    fireEvent.click(mascot());
    expect(await screen.findByRole("dialog", { name: "Ask Thoth" })).toBeTruthy();
  });

  it("moves with the arrow keys (no animation), snaps when the keys stop, and faces the middle of the window", async () => {
    const app = await openWithMascot();
    localStorage.setItem(MASCOT_PREFS_KEY, JSON.stringify({ ...DEFAULT_MASCOT_PREFS, snap: true }));
    mascot().focus();
    const [x0, y0] = translate();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await app.user.keyboard("{ArrowUp}{ArrowUp}");
    expect(translate()).toEqual([x0, y0! - 32]);
    expect(layer().dataset["settling"]).toBeUndefined();
    await app.user.keyboard("{Shift>}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{/Shift}");
    expect(translate()[0]).toBe(x0! - 9 * 64);
    // Now in the left half: it turns to face right.
    expect(art().dataset["facing"]).toBe("right");
    expect(stored().position.h).toBe("left");
    // Snapping waits for the keys to stop, then puts it on the nearest edge (the bottom, where it still is).
    await act(async () => void vi.advanceTimersByTime(KEY_SNAP_MS + 20));
    expect(translate()[1]).toBe(800 - defaultInsets().bottom - EDGE_MARGIN / 2 - 88);
    // Enter still opens the bubble.
    await app.user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Ask Thoth" })).toBeTruthy();
  });

  it("is clamped back inside the window after a resize, and keeps its corner", async () => {
    await openWithMascot();
    expect(translate()).toEqual([1088, 688]);
    resize(1000, 700);
    expect(translate()).toEqual([1000 - 24 - 88, 700 - 24 - 88]);
    // A window too small to keep the remembered distance: clamped inside, below the tab strip.
    localStorage.setItem(MASCOT_PREFS_KEY, "{}");
    cleanup();
    localStorage.setItem(MASCOT_PREFS_KEY, JSON.stringify({ ...DEFAULT_MASCOT_PREFS, size: "full", position: { h: "left", x: 5000, v: "top", y: 5000 } }));
    resize(1200, 800);
    await openWithMascot();
    const [x, y] = translate();
    expect(x).toBe(1200 - defaultInsets().right - 88);
    expect(y).toBe(800 - defaultInsets().bottom - 88);
  });

  it("announces state changes politely", async () => {
    const app = await openWithMascot();
    const live = screen.getByTestId("mascot-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    // Going to the background: it rests, and says so.
    act(() => void window.dispatchEvent(new Event("blur")));
    expect(layer().dataset["state"]).toBe("sleeping");
    expect(live.textContent).toBe("Thoth assistant is resting.");
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(layer().dataset["state"]).toBe("idle");
    expect(live.textContent).toBe("Thoth assistant is ready.");
    void app;
  });
});

describe("the mascot's settings", () => {
  beforeEach(() => resize(1200, 800));

  it("changes size, scale, motion, snapping and visibility at once, keeps them per user, and resets the position", async () => {
    const app = await openWithMascot();
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const section = await screen.findByRole("region", { name: "Mascot" });
    await app.user.click(within(section).getByRole("radio", { name: "Compact" }));
    expect(art().dataset["version"]).toBe("compact");
    const scale = within(section).getByRole("slider", { name: "Scale" }) as HTMLInputElement;
    expect([scale.min, scale.max, scale.step, scale.value]).toEqual(["80", "140", "10", "100"]);
    fireEvent.change(scale, { target: { value: "140" } });
    expect(layer().style.width).toBe(`${boxSize("compact", 140)}px`);
    expect(scale.getAttribute("aria-valuetext")).toBe("140%");
    await app.user.click(within(section).getByRole("radio", { name: "Calm" }));
    expect(art().dataset["motion"]).toBe("calm");
    await app.user.click(within(section).getByRole("switch", { name: "Snap to the edges" }));
    expect(stored()).toMatchObject({ size: "compact", scale: 140, motion: "calm", snap: false });
    // Per user, not per Private Space: one key, without the vault in it.
    expect(Object.keys(localStorage).filter((k) => k.includes("mascot"))).toEqual([MASCOT_PREFS_KEY]);

    localStorage.setItem(MASCOT_PREFS_KEY, JSON.stringify({ ...stored(), position: { h: "left", x: 100, v: "top", y: 100 } }));
    cleanup();
    await openWithMascot();
    expect(translate()).toEqual([100, 100]);
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const again = await screen.findByRole("region", { name: "Mascot" });
    await app.user.click(within(again).getByRole("button", { name: "Reset position" }));
    expect(within(again).getByRole("status").textContent).toBe("Back in the bottom-right corner.");
    expect(stored().position).toBeNull();
    const box = boxSize("compact", 140);
    expect(translate()).toEqual([1200 - 24 - box, 800 - 24 - box]);

    await app.user.click(within(again).getByRole("switch", { name: "Show the mascot" }));
    expect(screen.queryByTestId("mascot")).toBeNull();
    // Asking for it brings it back.
    await app.user.keyboard("{Meta>}j{/Meta}");
    expect(await screen.findByRole("dialog", { name: "Ask Thoth" })).toBeTruthy();
    expect(screen.getByTestId("mascot")).toBeTruthy();
  });

  it("keeps still when the OS asks for reduced motion, and with Motion off", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
    await openWithMascot();
    expect(art().dataset["motion"]).toBe("off");
    cleanup();
    vi.unstubAllGlobals();
    localStorage.setItem(MASCOT_PREFS_KEY, JSON.stringify({ ...DEFAULT_MASCOT_PREFS, motion: "off" }));
    await openWithMascot();
    expect(art().dataset["motion"]).toBe("off");
    // Off is a still pose: no animation and no transition anywhere in the drawing, under either rule.
    const css = await readFile(join(import.meta.dirname, "../src/features/mascot/mascot.css"), "utf8");
    expect(css).toMatch(/\.mascot-art\[data-motion="off"\] \*, \.mascot-art\[data-motion="off"\] \{ animation: none !important; transition: none !important; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.mascot-art, \.mascot-art \* \{ animation: none !important; transition: none !important; \}/);
    // Every state still has its own still pose (props and eyes are opacity, set without motion).
    for (const state of MASCOT_STATES) expect(css).toContain(`[data-state="${state}"]`);
  });
});
