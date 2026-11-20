// @vitest-environment jsdom
// The Board in the app (ADR-0056): the sidebar's Board link opens the Overview, a `.canvas` in the tree opens as a board
// tab (named by its file) without page actions, and "Board from this page" in a page's menu makes and opens one.
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, openApp, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA, "Plans/Research.canvas": JSON.stringify({ nodes: [], edges: [] }), "Plans/Upper.CANVAS": JSON.stringify({ nodes: [], edges: [] }) });
});
afterEach(async () => {
  cleanup();
  localStorage.clear();
  await dirs.cleanup();
});

const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);
const tree = () => screen.findByRole("tree", { name: "Pages in this Private Space" });

describe("the Board in the app", () => {
  it("the sidebar's Board link opens the Overview, once, and is current while it shows", async () => {
    const app = await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    const link = within(screen.getByRole("complementary", { name: "Sidebar" })).getByRole("button", { name: "Board" });
    await app.user.click(link);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Overview"]));
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(await screen.findByRole("application", { name: "Overview" })).toBeTruthy();
    await app.user.click(screen.getAllByRole("tab")[0]!);
    await app.user.click(link);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Overview"]));
  });

  it("a .canvas in the tree opens as a board tab, and its menu has no page actions", async () => {
    const app = await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    await app.user.click(await within(await tree()).findByRole("treeitem", { name: "Plans" }));
    const row = await within(await tree()).findByRole("treeitem", { name: "Research" });
    await app.user.click(row);
    // One tab per board, like Timeline: it opens beside the page instead of replacing it.
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Research"]));
    expect(await screen.findByRole("application", { name: "Research" })).toBeTruthy();
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("page"));
    // Letter case of the extension does not matter (Upper.CANVAS).
    await app.user.click(await within(await tree()).findByRole("treeitem", { name: "Upper" }));
    expect(await screen.findByRole("application", { name: "Upper" })).toBeTruthy();
    await app.user.click(row);
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem").map((m) => m.textContent ?? "");
    expect(items.some((i) => /favorite|duplicate|board from/i.test(i))).toBe(false);
    expect(items.some((i) => /rename/i.test(i))).toBe(true);
    await app.user.click(within(menu).getByRole("menuitem", { name: /^Delete/ }));
    expect((await screen.findByRole("dialog")).textContent).toMatch(/This board moves to the/);
  });

  it("Board from this page in a page's menu makes <page>.canvas beside it, pins the page and its neighbours, and opens it", async () => {
    const app = await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    fireEvent.contextMenu(await within(await tree()).findByRole("treeitem", { name: "Alpha" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Board from this page" }));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Alpha"]));
    const file = JSON.parse(await app.read("Alpha.canvas")) as { nodes: { file: string }[] };
    expect(file.nodes.map((n) => n.file)).toEqual(["Alpha.md", "Beta.md"]);
    const board = await screen.findByRole("application", { name: "Alpha" });
    await waitFor(() => expect(within(board).getAllByRole("button", { name: /links?$/ }).length).toBe(2));
  });
});
