// @vitest-environment jsdom
// The desktop sidebar: icon buttons with names and shortcuts, and the drag handle on its edge with its width kept per Private Space.
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, editorBox, openApp, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, seed } from "./support/fixtures.ts";
import { sidebarKey, loadSidebarLayout, loadSidebarWidth, saveSectionCollapsed, saveSectionOrder, saveSidebarHidden, saveSidebarWidth } from "../src/app/sidebar-store.ts";
import { arrangeSections, moveSection } from "../src/features/shell/sections.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA });
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

const handle = () => screen.getByRole("separator", { name: "Resize sidebar" });

describe("sidebar icon buttons", () => {
  it("New page, New folder and Settings are icon buttons: named, with a tooltip and the shortcut from the table", async () => {
    await openApp(root);
    const side = await screen.findByRole("complementary", { name: "Sidebar" });
    for (const [name, keys] of [
      ["New page", /^(⌘N|Ctrl\+N)$/],
      ["New folder", /^(⇧⌘N|Ctrl\+Shift\+N)$/],
      ["Settings", /^(⌘,|Ctrl\+,)$/],
    ] as const) {
      const button = within(side).getByRole("button", { name });
      expect(button.textContent).toBe("");
      expect(button.getAttribute("aria-label")).toBe(name);
      expect(button.getAttribute("data-tip")).toBe(name);
      expect(button.getAttribute("data-tip-keys")).toMatch(keys);
      expect(button.getAttribute("aria-keyshortcuts")).toMatch(/^(Meta|Control)\+/);
    }
  });

  it("New page creates Untitled and starts its rename in the tree", async () => {
    const app = await openApp(root);
    await app.user.click(await screen.findByRole("button", { name: "New page" }));
    expect(await screen.findByRole("textbox", { name: "Rename Untitled" })).toBeTruthy();
  });
});

describe("sidebar width", () => {
  it("has a labelled separator at the default, and Right moves it and remembers it for this Private Space", async () => {
    const app = await openApp(root);
    await screen.findByRole("tree");
    expect(handle().getAttribute("aria-valuenow")).toBe("260");
    expect(document.querySelector<HTMLElement>(".shell")!.style.getPropertyValue("--thoth-sidebar-width")).toBe("260px");
    handle().focus();
    await app.user.keyboard("{ArrowRight}{Shift>}{ArrowRight}{/Shift}");
    await waitFor(() => expect(handle().getAttribute("aria-valuenow")).toBe("340"));
    expect(JSON.parse(localStorage.getItem(sidebarKey(root))!)).toEqual({ v: 2, width: 340 });
    expect(document.querySelector<HTMLElement>(".shell")!.style.getPropertyValue("--thoth-sidebar-width")).toBe("340px");
  });

  it("comes back at the saved width when the Private Space is opened again, and double-click forgets it", async () => {
    saveSidebarWidth(root, 300);
    await openApp(root);
    await screen.findByRole("tree");
    expect(handle().getAttribute("aria-valuenow")).toBe("300");
    fireEvent.doubleClick(handle());
    await waitFor(() => expect(handle().getAttribute("aria-valuenow")).toBe("260"));
    expect(localStorage.getItem(sidebarKey(root))).toBeNull();
  });

  it("keeps the choice per Private Space and ignores a stored value that is not a width", () => {
    saveSidebarWidth("/a", 300);
    saveSidebarWidth("/b", 400);
    expect(loadSidebarWidth("/a")).toBe(300);
    expect(loadSidebarWidth("/b")).toBe(400);
    expect(loadSidebarWidth("/c")).toBeNull();
    localStorage.setItem(sidebarKey("/d"), "<script>");
    expect(loadSidebarWidth("/d")).toBeNull();
    localStorage.setItem(sidebarKey("/e"), "9999");
    expect(loadSidebarWidth("/e")).toBeNull();
  });
});

describe("the sidebar's stored layout (width, section order, folded sections)", () => {
  it("reads the old width-only value, and keeps that width when the order is first saved", () => {
    localStorage.setItem(sidebarKey("/old"), "300");
    expect(loadSidebarLayout("/old")).toEqual({ width: 300, order: [], collapsed: [], hidden: false });
    saveSectionOrder("/old", ["server:demo", "private"]);
    expect(JSON.parse(localStorage.getItem(sidebarKey("/old"))!)).toEqual({ v: 2, width: 300, order: ["server:demo", "private"] });
    expect(loadSidebarWidth("/old")).toBe(300);
  });

  it("changing the width keeps the order and the folded sections, and nothing is stored when all is the default", () => {
    saveSectionOrder("/a", ["agents", "private"]);
    saveSectionCollapsed("/a", ["agents"]);
    saveSidebarWidth("/a", 320);
    expect(loadSidebarLayout("/a")).toEqual({ width: 320, order: ["agents", "private"], collapsed: ["agents"], hidden: false });
    saveSidebarWidth("/a", null);
    saveSectionOrder("/a", []);
    saveSectionCollapsed("/a", []);
    expect(localStorage.getItem(sidebarKey("/a"))).toBeNull();
  });

  it("ignores what is not a layout: another version, bad ids, repeats, a bad width", () => {
    for (const bad of ["{", "[]", '{"v":3,"order":["private"]}', "null", '"private"']) {
      localStorage.setItem(sidebarKey("/x"), bad);
      expect(loadSidebarLayout("/x")).toEqual({ width: null, order: [], collapsed: [], hidden: false });
    }
    localStorage.setItem(sidebarKey("/x"), JSON.stringify({ v: 2, width: 12, order: ["private", 7, "", "private", "x".repeat(300), "server:a"], collapsed: "agents" }));
    expect(loadSidebarLayout("/x")).toEqual({ width: null, order: ["private", "server:a"], collapsed: [], hidden: false });
  });
});

describe("the order of the sidebar's sections", () => {
  it("is the natural order until someone moves one", () => {
    expect(arrangeSections([], ["private", "server:demo", "agents"])).toEqual(["private", "server:demo", "agents"]);
  });

  it("follows the stored order, ignores ids that are not there, and adds a new section at the end", () => {
    // `server:gone` was removed; `agents` is new (another branch adds it): it goes last, whatever the stored order says.
    expect(arrangeSections(["server:demo", "server:gone", "private"], ["private", "server:demo", "agents"])).toEqual(["server:demo", "private", "agents"]);
  });

  it("puts the Favorites first when the stored order does not name them, new or old; once moved they keep their place (ADR-0027)", () => {
    expect(arrangeSections([], ["favorites", "private", "server:demo"])).toEqual(["favorites", "private", "server:demo"]);
    expect(arrangeSections(["server:demo", "private"], ["private", "server:demo", "favorites"])).toEqual(["favorites", "server:demo", "private"]);
    const moved = moveSection(["server:demo", "private"], ["favorites", "server:demo", "private"], "favorites", 2);
    expect(arrangeSections(moved, ["favorites", "private", "server:demo"])).toEqual(["server:demo", "private", "favorites"]);
    // Hidden while empty, they keep that place for when they come back.
    expect(arrangeSections(moved, ["private", "server:demo"])).toEqual(["server:demo", "private"]);
  });

  it("moving a section keeps the places of stored ids that are not shown now", () => {
    const stored = ["server:demo", "server:gone", "private"];
    const present = ["private", "server:demo"];
    expect(moveSection(stored, present, "private", 0)).toEqual(["private", "server:gone", "server:demo"]);
    expect(moveSection([], ["private", "server:demo", "agents"], "agents", 0)).toEqual(["agents", "private", "server:demo"]);
    expect(moveSection([], ["private", "server:demo"], "private", 5)).toEqual(["server:demo", "private"]); // past the end: last
  });
});

describe("hiding the whole sidebar", () => {
  const sidebar = () => document.querySelector<HTMLElement>("aside.sidebar")!;
  const showButton = () => screen.queryByRole("button", { name: "Show sidebar" });

  it("the brand row's Hide sidebar button takes it out of the tab order and the accessibility tree, and focus goes to Show sidebar", async () => {
    const app = await openApp(root);
    await screen.findByRole("tree");
    expect(showButton()).toBeNull();
    const hide = within(screen.getByRole("complementary", { name: "Sidebar" })).getByRole("button", { name: "Hide sidebar" });
    expect(hide.getAttribute("data-tip-keys")).toMatch(/^(⌘\\|Ctrl\+\\)$/);
    await app.user.click(hide);
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull());
    expect(sidebar().hasAttribute("inert")).toBe(true);
    expect(sidebar().getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector("[data-sidebar-hidden]")).toBe(document.querySelector(".shell"));
    expect(screen.queryByRole("separator", { name: "Resize sidebar" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(showButton()));
    // The Show button sits at the start of the tab bar, before the house (back to Private Spaces).
    expect(showButton()!.closest(".tab-start")!.querySelectorAll("button")[1]!.getAttribute("aria-label")).toBe("Back to Private Spaces");
    await app.user.click(showButton()!);
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Sidebar" })).toBeTruthy());
    expect(sidebar().hasAttribute("inert")).toBe(false);
    expect(showButton()).toBeNull();
    expect(document.activeElement).toBe(within(sidebar()).getByRole("button", { name: "Hide sidebar" }));
    expect(handle()).toBeTruthy();
  });

  it("Cmd/Ctrl+\\ and the palette hide and show it, and it is remembered for this Private Space", async () => {
    const app = await openApp(root);
    await editorBox();
    await app.user.keyboard("{Control>}\\{/Control}");
    await waitFor(() => expect(showButton()).toBeTruthy());
    expect(JSON.parse(localStorage.getItem(sidebarKey(root))!)).toEqual({ v: 2, hidden: true });
    expect(loadSidebarLayout(root).hidden).toBe(true);
    await app.user.keyboard("{Control>}k{/Control}");
    await app.user.keyboard(">show sidebar");
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(showButton()).toBeNull());
    expect(localStorage.getItem(sidebarKey(root))).toBeNull();
    await app.user.keyboard("{Control>}k{/Control}");
    await app.user.keyboard(">hide sidebar");
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(showButton()).toBeTruthy());
    cleanup();
    await openApp(root);
    await waitFor(() => expect(showButton()).toBeTruthy());
    expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();
  });

  it("comes back to show a folder a breadcrumb asks for", async () => {
    await seed(root, { "Notes/Plan.md": "# Plan\n" });
    saveSidebarHidden(root, true);
    const app = await openApp(root);
    await screen.findByRole("tree", { hidden: true });
    await waitFor(() => expect(showButton()).toBeTruthy());
    await app.user.keyboard("{Control>}k{/Control}");
    await app.user.keyboard("Plan");
    await app.user.click(await screen.findByRole("option", { name: /Plan/ }));
    await app.user.click(await screen.findByRole("button", { name: "Notes" }));
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Sidebar" })).toBeTruthy());
    expect(loadSidebarLayout(root).hidden).toBe(false);
  });
});
