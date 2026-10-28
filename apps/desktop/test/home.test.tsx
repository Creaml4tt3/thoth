// @vitest-environment jsdom
// Home on the desktop is the Private Space picker (ADR-0029, amendment of 2026-10-28): the logo, the tab bar's house,
// Alt/Option+Shift+H and the palette close this Private Space in this window, after writing its edits, and the picker
// lists it first. Opened again, it has its tabs. There is no Home tab: a saved one is dropped. A new tab
// shows the recent pages and favorites (ADR-0029).
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, caretAtEnd, editorBox, openApp, paragraph, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";
import { initialTabs, serializeTabs } from "@thoth/app-ui/tabs/model.ts";
import { tabsKey } from "../src/app/tabs-store.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA });
});
afterEach(async () => {
  cleanup();
  localStorage.clear();
  await dirs.cleanup();
});

const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);
const current = () => screen.queryAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const row = async (name: string) => within(await screen.findByRole("tree", { name: "Pages in this Private Space" })).getByRole("treeitem", { name });
const leaf = () => root.split("/").pop()!;
const picker = () => screen.findByRole("button", { name: "Choose or create a Private Space" });
const recentSpaces = async () => within(await screen.findByRole("region", { name: "Recent" })).getAllByRole("button");

async function start(): Promise<Harness> {
  const app = await openApp(root);
  await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
  return app;
}

/** The picker is shown, with this Private Space first in Recent, and focus on its main button. */
async function onPicker() {
  const choose = await picker();
  expect(screen.queryByRole("tablist")).toBeNull();
  await waitFor(async () => expect((await recentSpaces())[0]!.textContent).toContain(leaf()));
  await waitFor(() => expect(document.activeElement).toBe(choose));
}

async function editAlpha(app: Harness) {
  const box = await editorBox();
  await waitFor(() => expect(box.textContent).toContain("First paragraph stays exactly."));
  box.focus();
  caretAtEnd(paragraph(box, "First paragraph stays exactly."));
  await app.user.keyboard(" Typed before leaving.");
  return box;
}

describe("Back to Private Spaces", () => {
  it("the logo closes this Private Space and shows the picker, with it first in Recent", async () => {
    // The host lists another Private Space first (opened later in another window): the one just left still leads.
    const app = await openApp(root, {}, createNodePlatform({ vault: root, recent: ["/elsewhere/Other", root] }));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    await app.user.click(within(sidebar).getByRole("button", { name: "Thoth, back to Private Spaces" }));
    await onPicker();
    expect((await recentSpaces()).map((b) => b.querySelector("b")!.textContent)).toEqual([leaf(), "Other"]);
  });

  it("the tab bar's house does the same", async () => {
    const app = await start();
    await app.user.click(screen.getByRole("button", { name: "Back to Private Spaces" }));
    await onPicker();
  });

  it("Alt/Option+Shift+H does the same", async () => {
    const app = await start();
    await app.user.keyboard("{Alt>}{Shift>}H{/Shift}{/Alt}");
    await onPicker();
  });

  it("the palette's Back to Private Spaces does the same", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}k{/Control}");
    await app.user.keyboard(">back to private");
    await app.user.keyboard("{Enter}");
    await onPicker();
  });

  it("writes the open page's edits first", async () => {
    const app = await start();
    await editAlpha(app);
    expect(await app.read("Alpha.md")).not.toContain("Typed before leaving.");
    await app.user.click(screen.getByRole("button", { name: "Back to Private Spaces" }));
    await onPicker();
    expect(await app.read("Alpha.md")).toContain("First paragraph stays exactly. Typed before leaving.");
  });

  it("stays, and says so, when an edit cannot be saved", async () => {
    const app = await start();
    const box = await editAlpha(app);
    await app.external("Alpha.md", ALPHA.replace("First paragraph stays exactly.", "Rewritten elsewhere."));
    await app.user.click(screen.getByRole("button", { name: "Back to Private Spaces" }));
    await screen.findByRole("dialog", { name: /changed on disk/i });
    expect(await screen.findByText(/this Private Space stays open/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Choose or create a Private Space" })).toBeNull();
    expect(tabNames()).toEqual(["Alpha"]);
    expect(box.textContent).toContain("Typed before leaving.");
  });

  it("opens the Private Space again with its tabs as they were", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}");
    await app.user.click(await row("Beta"));
    await app.user.keyboard("{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));
    await app.user.click(screen.getByRole("button", { name: "Back to Private Spaces" }));
    await onPicker();
    await app.user.click((await recentSpaces())[0]!);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));
    expect(current()).toBe("Beta");
  });
});

describe("no Home tab on the desktop", () => {
  it("a saved layout with a Home tab opens without it", async () => {
    localStorage.setItem(tabsKey(root), serializeTabs(initialTabs([{ kind: "page", path: "Beta.md" }, { kind: "home" }], 1)));
    await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Beta"]));
    expect(current()).toBe("Beta");
  });

  it("a saved layout of only a Home tab opens on the first page", async () => {
    localStorage.setItem(tabsKey(root), serializeTabs(initialTabs([{ kind: "home" }])));
    await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
  });

  it("a new tab lists the pages opened last, newest first, with their space and folder, and the favorites", async () => {
    const app = await start();
    await app.user.click(await row("Beta"));
    await waitFor(() => expect(current()).toBe("Beta"));
    await app.user.click(await screen.findByRole("button", { name: "Favorite" }));
    await app.user.keyboard("{Control>}t{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Beta", "New tab"]));
    const view = await screen.findByTestId("home");
    expect(within(view).getByRole("heading", { level: 1, name: "Welcome back" })).toBeTruthy();
    const titles = (name: string) => [...(within(view).getByRole("list", { name }).querySelectorAll(".home-row-title"))].map((el) => el.textContent);
    await waitFor(() => expect(titles("Recent")).toEqual(["Beta", "Alpha"]));
    expect(within(within(view).getByRole("list", { name: "Recent" })).getAllByRole("button")[0]!.textContent).toContain("Local");
    await waitFor(() => expect(titles("Favorites")).toEqual(["Beta"]));
    // Kept per Private Space in localStorage, by path.
    expect(localStorage.getItem(`thoth.desktop.recent.${root}`)).toContain('"path":"Beta.md"');
    await app.user.click(within(within(view).getByRole("list", { name: "Recent" })).getByRole("button", { name: /^Alpha/ }));
    await waitFor(() => expect(tabNames()).toEqual(["Beta", "Alpha"]));
  });

  it("a new tab drops a recent page that is gone", async () => {
    const app = await start();
    await app.user.click(await row("Beta"));
    await waitFor(() => expect(current()).toBe("Beta"));
    await rm(join(root, "Alpha.md"));
    app.platform.emit({ paths: ["Alpha.md"] });
    await waitFor(async () => expect(within(await screen.findByRole("tree", { name: "Pages in this Private Space" })).queryByRole("treeitem", { name: "Alpha" })).toBeNull());
    await app.user.keyboard("{Control>}t{/Control}");
    const view = await screen.findByTestId("home");
    await waitFor(() => expect([...(within(view).getByRole("list", { name: "Recent" }).querySelectorAll(".home-row-title"))].map((el) => el.textContent)).toEqual(["Beta"]));
  });
});
