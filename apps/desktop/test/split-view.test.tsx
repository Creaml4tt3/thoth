// @vitest-environment jsdom
// Split view (ADR-0030) in the desktop app: two panes side by side, and one page open in both.
import { readdir, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { caretAtEnd, cleanup, editorBox, openApp, paragraph, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createFakeWindows, createNodePlatform, tempDirs, type FakeWindows } from "./support/node-platform.ts";
import { ALPHA, seed } from "./support/fixtures.ts";
import { parseLayout } from "@thoth/app-ui/tabs/layout.ts";
import { tabsKey } from "../src/app/tabs-store.ts";

const dirs = tempDirs();
let root: string;
let windows: FakeWindows;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": "# Beta\n\nSecond page.\n", "Gamma.md": "# Gamma\n\nThe third page.\n" });
  windows = createFakeWindows();
});
afterEach(async () => {
  cleanup();
  localStorage.clear();
  await dirs.cleanup();
});

const bar = (name: string) => screen.getByRole("tablist", { name });
const names = (list: HTMLElement) => within(list).queryAllByRole("tab").map((t) => t.textContent);
const left = () => names(bar("Open pages, left"));
const right = () => names(bar("Open pages, right"));
const row = async (name: string) => within(await screen.findByRole("tree", { name: "Pages in this Private Space" })).getByRole("treeitem", { name });
const menu = (tab: string, item: string) => {
  fireEvent.contextMenu(screen.getAllByRole("tab", { name: tab })[0]!, { clientX: 10, clientY: 10 });
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
};

/** Alpha and Beta open, Beta current. */
async function start(): Promise<Harness> {
  const app = await openApp(root, {}, createNodePlatform({ vault: root, windows }));
  await waitFor(() => expect(names(bar("Open pages"))).toEqual(["Alpha"]));
  await editorBox();
  await app.user.keyboard("{Control>}");
  await app.user.click(await row("Beta"));
  await app.user.keyboard("{/Control}");
  await waitFor(() => expect(names(bar("Open pages"))).toEqual(["Alpha", "Beta"]));
  return app;
}

describe("splitting", () => {
  it("Split right in the tab's menu moves the tab into a new right pane", async () => {
    await start();
    menu("Beta", "Split right");
    await waitFor(() => expect(right()).toEqual(["Beta"]));
    expect(left()).toEqual(["Alpha"]);
    expect(screen.queryByRole("tablist", { name: "Open pages" })).toBeNull();
    // Both panes show their page, and the separator is there.
    expect(await screen.findByRole("heading", { level: 1, name: "Beta" })).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 1, name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize panes" })).toBeTruthy();
    // Focus followed the tab, and the move was said.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Beta"));
    expect(document.querySelector("[data-panes-said]")?.textContent).toBe("Beta moved to the right pane");
  });

  it("the shortcut splits; Move to other pane brings it back and the window is one pane again", async () => {
    await start();
    // Ctrl+Alt+\ by physical key (Cmd+Option+\ on a Mac).
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "\\", code: "Backslash", ctrlKey: true, altKey: true });
    await waitFor(() => expect(right()).toEqual(["Beta"]));
    menu("Beta", "Move to other pane");
    await waitFor(() => expect(names(bar("Open pages"))).toEqual(["Alpha", "Beta"]));
    expect(screen.queryByRole("separator", { name: "Resize panes" })).toBeNull();
  });

  it("new pages and next tab act in the active pane; F6 moves to the other pane", async () => {
    const app = await start();
    menu("Beta", "Split right");
    await waitFor(() => expect(right()).toEqual(["Beta"]));
    // The right pane is active: a new tab opens there.
    await app.user.keyboard("{Control>}t{/Control}");
    await waitFor(() => expect(right()).toEqual(["Beta", "New tab"]));
    await app.user.keyboard("{F6}");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Alpha"));
    await app.user.keyboard("{Control>}{Enter}{/Control}"); // nothing: not a tree
    await app.user.click(await row("Gamma"));
    await waitFor(() => expect(left()).toEqual(["Gamma"]));
    expect(right()).toEqual(["Beta", "New tab"]);
  });

  it("closing a pane's last tab closes the pane", async () => {
    const app = await start();
    menu("Beta", "Split right");
    await waitFor(() => expect(right()).toEqual(["Beta"]));
    await app.user.keyboard("{Control>}w{/Control}");
    await waitFor(() => expect(names(bar("Open pages"))).toEqual(["Alpha"]));
  });

  it("Home stays one per window: opening it from the other pane goes there", async () => {
    const app = await start();
    menu("Beta", "Split right");
    await waitFor(() => expect(right()).toEqual(["Beta"]));
    await app.user.keyboard("{Alt>}{Shift>}h{/Shift}{/Alt}");
    await waitFor(() => expect(right()).toEqual(["Beta", "Home"]));
    await app.user.click(within(bar("Open pages, left")).getByRole("tab", { name: "Alpha" }));
    await app.user.keyboard("{Alt>}{Shift>}h{/Shift}{/Alt}");
    await waitFor(() => expect(within(bar("Open pages, right")).getByRole("tab", { name: "Home" }).getAttribute("aria-selected")).toBe("true"));
    expect(left()).toEqual(["Alpha"]);
  });
});

describe("one page in both panes", () => {
  /** Beta in both panes: split it right, then open it in the left pane too. */
  async function twice(app: Harness) {
    menu("Beta", "Split right");
    await waitFor(() => expect(right()).toEqual(["Beta"]));
    await app.user.click(within(bar("Open pages, left")).getByRole("tab", { name: "Alpha" }));
    await app.user.click(await row("Beta"));
    await waitFor(() => expect(left()).toEqual(["Beta"]));
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 1, name: "Beta" })).toHaveLength(2));
    const boxes = await screen.findAllByRole("textbox", { name: /page content/i });
    expect(boxes).toHaveLength(2);
    return boxes as [HTMLElement, HTMLElement];
  }
  const conflictFiles = async () => (await readdir(root)).filter((f) => f.includes("conflict"));

  it("an edit in one pane shows in the other, and is saved once with no conflict", async () => {
    const app = await start();
    const [one, two] = await twice(app);
    one.focus();
    caretAtEnd(paragraph(one, "Second page."));
    await app.user.keyboard(" Typed on the left.");
    await waitFor(() => expect(two.textContent).toContain("Second page. Typed on the left."));
    await app.user.keyboard("{Control>}s{/Control}");
    await waitFor(async () => expect(await readFile(`${root}/Beta.md`, "utf8")).toContain("Second page. Typed on the left."));
    // Then on the right: no conflict with the left's save.
    two.focus();
    caretAtEnd(paragraph(two, "Second page. Typed on the left."));
    await app.user.keyboard(" And on the right.");
    await waitFor(() => expect(one.textContent).toContain("And on the right."));
    await app.user.keyboard("{Control>}s{/Control}");
    await waitFor(async () => expect(await readFile(`${root}/Beta.md`, "utf8")).toContain("Second page. Typed on the left. And on the right."));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await conflictFiles()).toEqual([]);
  });

  it("a switch away writes the edit once (flushAll), and the other pane keeps it", async () => {
    const app = await start();
    const [one, two] = await twice(app);
    one.focus();
    caretAtEnd(paragraph(one, "Second page."));
    await app.user.keyboard(" Before the switch.");
    await app.user.click(await row("Alpha")); // the left pane leaves Beta: its edit is written first
    await waitFor(() => expect(left()).toEqual(["Alpha"]));
    await waitFor(async () => expect(await readFile(`${root}/Beta.md`, "utf8")).toContain("Before the switch."));
    expect(two.textContent).toContain("Before the switch.");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await conflictFiles()).toEqual([]);
  });
});

describe("layout across restarts and windows", () => {
  it("comes back after a restart: panes, tabs, the active pane and the ratio", async () => {
    await start();
    menu("Beta", "Split right");
    await waitFor(() => expect(right()).toEqual(["Beta"]));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(tabsKey(root))!).panes).toHaveLength(2));
    const saved = parseLayout(localStorage.getItem(tabsKey(root)))!;
    expect(saved.active).toBe(1);
    cleanup();
    await openApp(root, {}, createNodePlatform({ vault: root, windows }));
    await waitFor(() => expect(right()).toEqual(["Beta"]));
    expect(left()).toEqual(["Alpha"]);
  });

  it("a tab of the right pane moves to a new window, and its pane closes", async () => {
    await start();
    menu("Beta", "Split right");
    await waitFor(() => expect(right()).toEqual(["Beta"]));
    menu("Beta", "Move tab to new window");
    await waitFor(() => expect(names(bar("Open pages"))).toEqual(["Alpha"]));
    expect(parseLayout(windows.opened[0]!.tabs)!.panes[0]!.tabs.map((t) => t.target)).toEqual([{ kind: "page", path: "Beta.md" }]);
  });
});
