// @vitest-environment jsdom
// The Board tab (ADR-0056) on a real Private Space: the header's switcher, New board in the sidebar's folder, Add note,
// pinning a suggestion and moving notes saved once after 500 ms of quiet, undo of a move, a drawn link that refreshes
// the session (and its undo too), "Board from this page", and the graph read again when the index changes.
import "../../../tests/helpers/jsdom-shims.ts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openNodeVault } from "@thoth/local-store/node";
import type { Vault } from "@thoth/local-store";
import { SessionContext, type Session } from "../src/app/context.ts";
import { BoardTab } from "../src/features/board/BoardTab.tsx";
import { boardFromPage } from "../src/features/board/from-page.ts";
import { setTargetFolder } from "../src/features/shell/target-folder.ts";

let root: string;
let vault: Vault;
const put = async (path: string, text: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
};
const read = (path: string) => readFile(join(root, path), "utf8");
const nodes = async (path: string) => (JSON.parse(await read(path)) as { nodes: { id: string; file?: string; x: number; y: number }[] }).nodes;
const board = (...pins: [string, string, number, number][]) => JSON.stringify({ nodes: pins.map(([id, file, x, y]) => ({ id, type: "file", file, x, y, width: 160, height: 120 })), edges: [] });

beforeEach(async () => {
  setTargetFolder("");
  root = await mkdtemp(join(tmpdir(), "thoth-board-tab-"));
  await put("A.md", "# A\n\nAbout A.\n");
  await put("B.md", "# B\n\nB links [[A]].\n");
  await put("C.md", "# C\n");
  await put("Research/Deep.md", "# Deep\n");
  await put("Zeta.canvas", board());
  await put("Research/Alpha board.canvas", board(["a", "A.md", 0, 0]));
  ({ vault } = await openNodeVault(root));
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await vault.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function setup(path?: string, options: { tabId?: string } = {}) {
  const tabId = options.tabId ?? "t1";
  const refresh = vi.fn(async (changed?: readonly string[]) => {
    await vault.reconcile(changed ? { changed } : {});
  });
  // The session's flush registry, as VaultHost keeps it.
  const flushers = new Set<() => Promise<boolean>>();
  const registerFlush = (f: () => Promise<boolean>) => (flushers.add(f), () => void flushers.delete(f));
  const flushAll = async () => (await Promise.all([...flushers].map((f) => f().catch(() => false)))).every(Boolean);
  const tabs = { open: vi.fn(), layout: { panes: [{ tabs: [{ id: tabId, target: path === undefined ? { kind: "board" } : { kind: "board", path } }] }] } };
  const openPage = vi.fn();
  const session = (revision: number) =>
    ({ vault, connection: { root }, revision, refresh, flushAll, registerFlush, openPage, openFolder: vi.fn(), tabs }) as unknown as Session;
  const ui = (revision: number, mounted = true) => (
    <SessionContext value={session(revision)}>{mounted && <BoardTab tabId={tabId} path={path} />}</SessionContext>
  );
  const view = render(ui(1));
  return {
    refresh,
    tabs,
    openPage,
    flushAll,
    flushers,
    rerender: (revision: number) => view.rerender(ui(revision)),
    /** Another tab becomes current (this one unmounts), then this one again. */
    unmount: () => view.rerender(ui(1, false)),
    remount: () => view.rerender(ui(1)),
    user: userEvent.setup({ delay: null }),
  };
}

/** Lets the file system and promise chains run without timers (they may be fake). */
async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await act(() => new Promise((r) => setImmediate(r)));
  }
  throw new Error("never happened");
}
const note = (name: RegExp) => screen.getByRole("button", { name });
const fake = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("BoardTab", () => {
  it("the switcher lists the Overview, then the boards by name; choosing one opens it", async () => {
    const { tabs } = setup();
    const switcher = await screen.findByRole("combobox", { name: "Board" });
    await waitFor(() => expect(within(switcher).getAllByRole("option").map((o) => o.textContent)).toEqual(["Overview", "Alpha board", "Zeta"]));
    fireEvent.change(switcher, { target: { value: "Zeta.canvas" } });
    expect(tabs.open).toHaveBeenCalledWith({ kind: "board", path: "Zeta.canvas" }, { replace: true });
  });

  it("New board creates <name>.canvas in the sidebar's selected folder and opens it", async () => {
    setTargetFolder("Research");
    const { tabs, user } = setup();
    await user.click(await screen.findByRole("button", { name: "New board" }));
    await user.type(screen.getByRole("textbox", { name: "Board name" }), "OCR{Enter}");
    await waitFor(() => expect(tabs.open).toHaveBeenCalledWith({ kind: "board", path: "Research/OCR.canvas" }));
    expect(JSON.parse(await read("Research/OCR.canvas"))).toEqual({ nodes: [], edges: [] });
  });

  it("New board says why a name is refused and keeps the dialog", async () => {
    const { tabs, user } = setup();
    await user.click(await screen.findByRole("button", { name: "New board" }));
    await user.type(screen.getByRole("textbox", { name: "Board name" }), "zeta{Enter}");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(tabs.open).not.toHaveBeenCalled();
  });

  it("the Overview shows every page, filters by tag and folder, and reads the graph again when the index changes", async () => {
    const { rerender } = setup();
    await waitFor(() => expect(note(/^Deep,/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Add note" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Folder" }), { target: { value: "Research" } });
    expect(screen.queryByRole("button", { name: /^A,/ })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Folder" }), { target: { value: "" } });
    await put("New.md", "# New\n\n#idea\n");
    await vault.reconcile();
    rerender(2);
    await waitFor(() => expect(note(/^New,/)).toBeTruthy());
    fireEvent.change(screen.getByRole("combobox", { name: "Tag" }), { target: { value: "idea" } });
    expect(screen.getAllByRole("button", { name: /links?$/ }).map((b) => b.getAttribute("aria-label")!.split(",")[0])).toEqual(["New"]);
  });

  it("Add note pins a page found by its title, saved 500 ms later", async () => {
    const { user } = setup("Zeta.canvas");
    await user.click(await screen.findByRole("button", { name: "Add note" }));
    fake(); // user-event waits on timers: synchronous events from here on
    const find = screen.getByRole("textbox", { name: "Find a page" });
    fireEvent.change(find, { target: { value: "dee" } });
    fireEvent.keyDown(find, { key: "Enter" });
    expect(note(/^Deep,/).getAttribute("data-state")).toBe("pinned");
    await advance(499);
    expect(await nodes("Zeta.canvas")).toEqual([]);
    await advance(1);
    await until(async () => (await nodes("Zeta.canvas")).length === 1);
    expect((await nodes("Zeta.canvas"))[0]).toMatchObject({ file: "Research/Deep.md", width: 160, height: 120 });
  });

  it("a click on a suggestion pins it where it was drawn, saved after 500 ms", async () => {
    setup("Research/Alpha board.canvas");
    const suggestion = await screen.findByRole("button", { name: /^B, .*suggested$/ });
    const at = { x: parseFloat(suggestion.style.left), y: parseFloat(suggestion.style.top) };
    fake();
    fireEvent.click(suggestion, { detail: 1 });
    expect(note(/^B,/).getAttribute("data-state")).toBe("pinned");
    await advance(500);
    await until(async () => (await nodes("Research/Alpha board.canvas")).length === 2);
    expect((await nodes("Research/Alpha board.canvas"))[1]).toMatchObject({ type: "file", file: "B.md", ...at });
  });

  it("several moves are one save; Cmd/Ctrl+Z puts the note back and saves that too", async () => {
    const { user } = setup("Research/Alpha board.canvas");
    await user.click(await screen.findByRole("button", { name: /^A,/ }));
    const writes = vi.spyOn(vault, "writeFileAtomic");
    fake();
    for (const key of ["ArrowRight", "ArrowRight", "ArrowDown"]) fireEvent.keyDown(note(/^A,/), { key });
    await advance(500);
    await until(async () => (await nodes("Research/Alpha board.canvas"))[0]!.x === 16);
    expect(writes).toHaveBeenCalledTimes(1);
    expect((await nodes("Research/Alpha board.canvas"))[0]).toMatchObject({ x: 16, y: 8 });
    fireEvent.keyDown(note(/^A,/), { key: "z", ctrlKey: true });
    await advance(500);
    await until(async () => (await nodes("Research/Alpha board.canvas"))[0]!.y === 0);
    expect((await nodes("Research/Alpha board.canvas"))[0]).toMatchObject({ x: 16, y: 0 });
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it("a saved move is written when the tab closes before the 500 ms", async () => {
    const { user } = setup("Research/Alpha board.canvas");
    await user.click(await screen.findByRole("button", { name: /^A,/ }));
    fake();
    fireEvent.keyDown(note(/^A,/), { key: "ArrowRight" });
    cleanup();
    await until(async () => (await nodes("Research/Alpha board.canvas"))[0]!.x === 8);
  });

  it("a drawn link refreshes the session for the source page, and so does its undo", async () => {
    await put("Research/Alpha board.canvas", board(["a", "A.md", 0, 0], ["c", "C.md", 300, 0]));
    const { refresh, user } = setup("Research/Alpha board.canvas");
    (await screen.findByRole("button", { name: /^C,/ })).focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    await user.click(screen.getByRole("menuitem", { name: "Link to…" }));
    await user.keyboard("{Enter}"); // the first other note: A
    await waitFor(() => expect(refresh).toHaveBeenCalledWith(["C.md"]));
    expect(await read("C.md")).toBe("# C\n[[A]]\n");
    refresh.mockClear();
    await user.keyboard("{Control>}z{/Control}");
    await waitFor(() => expect(refresh).toHaveBeenCalledWith(["C.md"]));
    expect(await read("C.md")).toBe("# C\n");
  });

  it("a board that is gone or not a canvas says so and is never written", async () => {
    await put("Bad.canvas", "{ not json");
    setup("Bad.canvas");
    expect(await screen.findByText(/can’t be read/)).toBeTruthy();
    expect(await read("Bad.canvas")).toBe("{ not json");
    cleanup();
    setup("Gone.canvas");
    expect(await screen.findByText(/This board is gone/)).toBeTruthy();
  });
});

describe("BoardTab: saves and history across tabs and windows", () => {
  const BOARD = "Research/Alpha board.canvas";
  const moveA = async (key = "ArrowRight") => fireEvent.keyDown(note(/^A,/), { key });
  async function selectA(user: ReturnType<typeof setup>["user"]) {
    await user.click(await screen.findByRole("button", { name: /^A,/ }));
  }

  it("the session's flushAll writes a queued move before the 500 ms (window close, Quit, Space switch)", async () => {
    const { flushAll, user } = setup(BOARD);
    await selectA(user);
    fake();
    await moveA();
    expect(await flushAll()).toBe(true);
    expect((await nodes(BOARD))[0]).toMatchObject({ x: 8 });
  });

  it("flushAll also waits for a save already running, and says false when it fails", async () => {
    const { flushAll, user } = setup(BOARD);
    await selectA(user);
    fake();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const write = vault.writeFileAtomic.bind(vault);
    const spy = vi.spyOn(vault, "writeFileAtomic").mockImplementationOnce(async (...args) => (await held, write(...args)));
    await moveA();
    await advance(500); // the save starts and waits
    await moveA(); // a second change while it runs
    const all = flushAll();
    release();
    expect(await all).toBe(true);
    expect((await nodes(BOARD))[0]).toMatchObject({ x: 16 });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRejectedValueOnce(new Error("disk full"));
    await moveA();
    expect(await flushAll()).toBe(false);
  });

  it("a failed save says so and reads the file again; the next good change clears the message", async () => {
    const { user } = setup(BOARD);
    await selectA(user);
    fake();
    vi.spyOn(vault, "writeFileAtomic").mockRejectedValueOnce(new Error("disk full"));
    await moveA();
    await advance(500);
    await until(() => screen.queryByText(/Couldn’t save the board/) !== null);
    // Read again: the note is back where the file has it.
    await until(() => note(/^A,/).style.left === "0px");
    await moveA();
    expect(screen.queryByText(/Couldn’t save the board/)).toBeNull();
  });

  it("Cmd/Ctrl+Z after leaving the tab and coming back still undoes the move", async () => {
    const { unmount, remount, user } = setup(BOARD);
    await selectA(user);
    fake();
    await moveA();
    unmount(); // another tab became current: the move is written on the way out
    await until(async () => (await nodes(BOARD))[0]!.x === 8);
    remount();
    await until(() => screen.queryByRole("button", { name: /^A,/ })?.style.left === "8px");
    fireEvent.keyDown(note(/^A,/), { key: "z", ctrlKey: true });
    await advance(500);
    await until(async () => (await nodes(BOARD))[0]!.x === 0);
  });

  it("history ends with its tab: a tab gone from the window starts a new history", async () => {
    const first = setup(BOARD, { tabId: "t1" });
    await selectA(first.user);
    fake();
    await moveA();
    cleanup();
    await until(async () => (await nodes(BOARD))[0]!.x === 8);
    setup(BOARD, { tabId: "t2" }); // t1 is not in this window any more
    await until(() => screen.queryByRole("button", { name: /^A,/ })?.style.left === "8px");
    fireEvent.keyDown(note(/^A,/), { key: "z", ctrlKey: true });
    await advance(600);
    expect((await nodes(BOARD))[0]).toMatchObject({ x: 8 });
  });

  it("an index change reads the board again; while a change is queued it waits until that is written", async () => {
    const { rerender, user } = setup(BOARD);
    await selectA(user);
    // Another app adds B to the board.
    await put(BOARD, board(["a", "A.md", 0, 0], ["b", "B.md", 400, 0]));
    rerender(2);
    await until(() => screen.queryByRole("button", { name: /^B,/ })?.getAttribute("data-state") === "pinned");
    // Another app moves B; meanwhile A is moved here and not yet written.
    fake();
    await moveA();
    await put(BOARD, board(["a", "A.md", 0, 0], ["b", "B.md", 400, 200]));
    const reads = vi.spyOn(vault.fs, "readFile");
    rerender(3);
    await act(async () => {});
    expect(reads).not.toHaveBeenCalled();
    await advance(500);
    // Written on top of what the other app wrote, then shown with B where that app put it.
    await until(async () => (await nodes(BOARD))[0]!.x === 8);
    expect((await nodes(BOARD))[1]).toMatchObject({ file: "B.md", y: 200 });
    await until(() => note(/^B,/).style.top === "200px");
  });

  it("a drawn link's outcome resolves only after the session was refreshed", async () => {
    await put(BOARD, board(["a", "A.md", 0, 0], ["c", "C.md", 300, 0]));
    const { refresh, user } = setup(BOARD);
    let release!: () => void;
    refresh.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    (await screen.findByRole("button", { name: /^C,/ })).focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    await user.click(screen.getByRole("menuitem", { name: "Link to…" }));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(refresh).toHaveBeenCalledWith(["C.md"]));
    const said = () => document.querySelector(".board-status")!.textContent;
    await new Promise((r) => setTimeout(r, 150));
    expect(said()).toBe("");
    release();
    await waitFor(() => expect(said()).toBe("Linked."));
  });
});

describe("Board from this page", () => {
  it("makes <folder>/<page>.canvas with the page in the middle and its neighbours around it; a second one is “… 2”", async () => {
    await put("D.md", "# D\n\n[[A]] and [[C]]\n");
    await vault.reconcile();
    expect(await boardFromPage(vault, "A.md")).toBe("A.canvas");
    const pinned = await nodes("A.canvas");
    expect(pinned.map((n) => n.file)).toEqual(["A.md", "B.md", "D.md"]);
    // The page sits centred on the origin; each neighbour is about 260 away from it.
    const centre = (n: { x: number; y: number }) => ({ x: n.x + 80, y: n.y + 60 });
    expect(centre(pinned[0]!)).toEqual({ x: 0, y: 0 });
    for (const n of pinned.slice(1)) expect(Math.round(Math.hypot(centre(n).x, centre(n).y))).toBeGreaterThanOrEqual(259);
    expect(await boardFromPage(vault, "A.md")).toBe("A 2.canvas");
    expect(await boardFromPage(vault, "Research/Deep.md")).toBe("Research/Deep.canvas");
  });
});
