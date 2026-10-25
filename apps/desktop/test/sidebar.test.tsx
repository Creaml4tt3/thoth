// @vitest-environment jsdom
// The desktop sidebar: icon buttons with names and shortcuts, and the drag handle on its edge with its width kept per Private Space.
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, openApp, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, seed } from "./support/fixtures.ts";
import { sidebarKey, loadSidebarWidth, saveSidebarWidth } from "../src/app/sidebar-store.ts";

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

  it("New page still opens its dialog", async () => {
    const app = await openApp(root);
    await app.user.click(await screen.findByRole("button", { name: "New page" }));
    expect(await screen.findByRole("dialog", { name: "New page" })).toBeTruthy();
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
    expect(localStorage.getItem(sidebarKey(root))).toBe("340");
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
