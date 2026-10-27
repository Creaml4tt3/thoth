// @vitest-environment jsdom
// Home (ADR-0029) in the desktop app: the tab at start, its Recent and Favorites lists, the ways to open it (the brand
// row, the tab bar's button, the shortcut, the palette), new tabs showing it, and the recent pages kept per Private Space.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, editorBox, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA, "Notes/Plan.md": "# Plan\n\nSoon.\n", "Notes/Diary.md": "# Diary\n", "Gamma.md": "# Gamma\n", "Delta.md": "# Delta\n" });
});
afterEach(async () => {
  cleanup();
  localStorage.clear();
  await dirs.cleanup();
});

const tabs = () => screen.queryAllByRole("tab");
const tabNames = () => tabs().map((t) => t.textContent);
const current = () => tabs().find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const tree = () => screen.findByRole("tree", { name: "Pages in this Private Space" });
const row = async (name: string) => within(await tree()).getByRole("treeitem", { name });
const home = () => screen.findByTestId("home");
const list = async (name: "Recent" | "Favorites") => within(await home()).queryByRole("list", { name });
const titles = async (name: "Recent" | "Favorites") => [...((await list(name))?.querySelectorAll(".home-row-title") ?? [])].map((el) => el.textContent);
const homeRow = async (name: "Recent" | "Favorites", title: string) => within((await list(name))!).getByRole("button", { name: new RegExp(`^${title}`) });

async function start(): Promise<Harness> {
  const app = await openApp(root, { startOnHome: true });
  await tree();
  await waitFor(() => expect(tabNames()).toEqual(["Home"]));
  return app;
}

/** Opens each page in turn in the current tab. */
async function visit(app: Harness, ...names: string[]) {
  for (const name of names) {
    await app.user.click(await row(name));
    await waitFor(() => expect(current()).toBe(name));
  }
}

describe("Home", () => {
  it("is what a Private Space opens on when nothing was open: the mark, a greeting, and the two lists with their hints", async () => {
    await start();
    const view = await home();
    expect(within(view).getByRole("heading", { level: 1, name: "Welcome back" })).toBeTruthy();
    expect(within(view).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Recent", "Favorites"]);
    expect(view.textContent).toContain("Pages you open show here.");
    expect(view.textContent).toContain("Star a page to keep it here.");
    expect(screen.getByRole("tab", { name: "Home" }).querySelector("svg")).toBeTruthy(); // the house
  });

  it("lists the last five distinct pages opened, newest first, with their space and folder", async () => {
    const app = await start();
    await (await row("Notes")).click();
    await visit(app, "Alpha", "Beta", "Plan", "Alpha", "Gamma", "Delta", "Diary");
    await app.user.click(screen.getByRole("button", { name: "Home" }));
    await waitFor(async () => expect(await titles("Recent")).toEqual(["Diary", "Delta", "Gamma", "Alpha", "Plan"]));
    const plan = await homeRow("Recent", "Plan");
    expect(plan.textContent).toContain("Local");
    expect(plan.textContent).toContain("Notes");
    expect((await homeRow("Recent", "Gamma")).textContent).toContain("Top level");
    // Kept per Private Space in localStorage, by path, with no title.
    const stored = Object.entries(localStorage).find(([key]) => key === `thoth.desktop.recent.${root}`)?.[1] ?? "";
    expect(stored).toContain('"path":"Notes/Diary.md"');
    expect(stored).not.toContain("Diary\"");
  });

  it("opens a page in this tab on click or Enter, and in a new tab on Cmd/Ctrl+click and middle-click", async () => {
    const app = await start();
    await visit(app, "Alpha", "Beta");
    await app.user.click(screen.getByRole("button", { name: "Home" }));
    await waitFor(() => expect(tabNames()).toEqual(["Beta", "Home"]));
    await app.user.keyboard("{Control>}");
    await app.user.click(await homeRow("Recent", "Alpha"));
    await app.user.keyboard("{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Beta", "Home", "Alpha"]));
    await app.user.click(screen.getByRole("tab", { name: "Home" }));
    fireEvent(await homeRow("Recent", "Beta"), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    await waitFor(() => expect(tabNames()).toEqual(["Beta", "Home", "Beta", "Alpha"]));
    await app.user.click(screen.getByRole("tab", { name: "Home" }));
    (await homeRow("Recent", "Alpha")).focus();
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(tabNames()).toEqual(["Beta", "Alpha", "Beta", "Alpha"]));
    await editorBox();
  });

  it("is one tab, opened by the brand row, the tab bar's Home button, Alt/Option+Shift+H and the palette", async () => {
    const app = await start();
    await visit(app, "Alpha");
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    await app.user.click(within(sidebar).getByRole("button", { name: "Thoth home" }));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Home"]));
    await app.user.click(screen.getByRole("tab", { name: "Alpha" }));
    await app.user.click(screen.getByRole("button", { name: "Home" }));
    await waitFor(() => expect(current()).toBe("Home"));
    expect(tabNames()).toEqual(["Alpha", "Home"]);
    await app.user.click(screen.getByRole("tab", { name: "Alpha" }));
    await app.user.keyboard("{Alt>}{Shift>}H{/Shift}{/Alt}");
    await waitFor(() => expect(current()).toBe("Home"));
    await app.user.click(screen.getByRole("tab", { name: "Alpha" }));
    await app.user.keyboard("{Control>}k{/Control}");
    await app.user.keyboard(">go home");
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(current()).toBe("Home"));
    expect(tabNames()).toEqual(["Alpha", "Home"]);
  });

  it("is what a new tab shows, so a new tab is never empty", async () => {
    const app = await start();
    await visit(app, "Alpha");
    await app.user.keyboard("{Control>}t{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "New tab"]));
    expect(within(await home()).getByRole("heading", { level: 1, name: "Welcome back" })).toBeTruthy();
    expect(await titles("Recent")).toEqual(["Alpha"]);
  });

  it("lists every favorite, and opens them the same way", async () => {
    const app = await start();
    await visit(app, "Beta");
    await app.user.click(await screen.findByRole("button", { name: "Favorite" }));
    await waitFor(async () => expect((await screen.findByRole("button", { name: "Favorite" })).getAttribute("aria-pressed")).toBe("true"));
    await app.user.keyboard("{Control>}t{/Control}");
    await waitFor(async () => expect(await titles("Favorites")).toEqual(["Beta"]));
    await app.user.click(await homeRow("Favorites", "Beta"));
    await waitFor(() => expect(tabNames()).toEqual(["Beta", "Beta"]));
  });

  it("follows a renamed page, and drops one that is gone", async () => {
    const app = await start();
    await visit(app, "Alpha", "Gamma");
    await app.user.click(await row("Alpha"));
    await waitFor(() => expect(current()).toBe("Alpha"));
    await app.user.keyboard("{F2}");
    const input = await screen.findByRole("textbox", { name: /rename/i });
    await app.user.clear(input);
    await app.user.type(input, "First{Enter}");
    await waitFor(async () => expect(within(await tree()).queryByRole("treeitem", { name: "First" })).toBeTruthy());
    await rm(join(root, "Gamma.md"));
    app.platform.emit({ paths: ["Gamma.md"] });
    await waitFor(async () => expect(within(await tree()).queryByRole("treeitem", { name: "Gamma" })).toBeNull());
    await app.user.click(screen.getByRole("button", { name: "Home" }));
    await waitFor(async () => expect(await titles("Recent")).toEqual(["First"]));
  });
});
