// @vitest-environment jsdom
// Show in Finder / File Explorer / Files for a page or folder of the Private Space: the row's menu asks the host to
// reveal that entry (the host checks the path itself: crates/thoth-host/tests/reveal.rs).
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, editorBox, openApp, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, seed } from "./support/fixtures.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Notes/Plan.md": "# Plan\n" });
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await dirs.cleanup();
});

const tree = () => screen.findByRole("tree", { name: "Pages in this Private Space" });
const menuFor = async (name: string) => {
  fireEvent.contextMenu(within(await tree()).getByRole("treeitem", { name }));
  return screen.findByRole("menu");
};

describe("Show in Finder for a page or folder", () => {
  it("is in a page's and a folder's menu, named for the system, and reveals that entry", async () => {
    const app = await openApp(root);
    await editorBox();
    const reveal = vi.fn(async (_path?: string) => undefined);
    app.platform.connections[0]!.reveal = reveal;
    // jsdom's user agent is neither macOS nor Windows: the Linux name.
    await app.user.click(within(await menuFor("Alpha")).getByRole("menuitem", { name: "Show in Files" }));
    expect(reveal).toHaveBeenLastCalledWith("Alpha.md");
    await app.user.click(within(await menuFor("Notes")).getByRole("menuitem", { name: "Show in Files" }));
    expect(reveal).toHaveBeenLastCalledWith("Notes");
  });

  it("names Finder on a Mac", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)");
    const app = await openApp(root);
    await editorBox();
    app.platform.connections[0]!.reveal = async () => undefined;
    expect(within(await menuFor("Alpha")).getByRole("menuitem", { name: "Show in Finder" })).toBeTruthy();
  });

  it("is not offered where the host cannot reveal, and says why when it fails", async () => {
    const app = await openApp(root);
    await editorBox();
    expect(within(await menuFor("Alpha")).queryByRole("menuitem", { name: /^Show in/ })).toBeNull();
    await app.user.keyboard("{Escape}");
    app.platform.connections[0]!.reveal = async () => {
      throw new Error("The file manager is not there.");
    };
    await app.user.click(within(await menuFor("Alpha")).getByRole("menuitem", { name: /^Show in/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("The file manager is not there."));
  });
});
