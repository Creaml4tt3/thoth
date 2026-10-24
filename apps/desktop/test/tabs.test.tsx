// @vitest-environment jsdom
// Tabs (ADR-0016 rule 5, Phase 3b AC 7) in the desktop app.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { cleanup, caretAtEnd, editorBox, openApp, paragraph, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";
import { initialTabs, serializeTabs } from "@thoth/app-ui/tabs/model.ts";
import { tabsKey } from "../src/app/tabs-store.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA, "Gamma.md": "# Gamma\n\nThe third page.\n" });
});
afterEach(async () => {
  cleanup();
  localStorage.clear();
  await dirs.cleanup();
});

const tabs = () => screen.queryAllByRole("tab");
/** The × next to the tab named `name`: a pointer affordance, not a button (a tablist owns tabs only). */
const closeButton = (name: string) => tabs().find((t) => t.textContent === name)!.parentElement!.querySelector<HTMLElement>(".tab-close")!;
const tabNames = () => tabs().map((t) => t.textContent);
const current = () => tabs().find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const row = async (name: string) => within(await screen.findByRole("tree", { name: "Pages in this Private Space" })).getByRole("treeitem", { name });

/** Opens the app and waits for the first page to open by itself. */
async function start(): Promise<Harness> {
  const app = await openApp(root);
  await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
  await editorBox();
  return app;
}

describe("opening pages in tabs", () => {
  it("starts with one tab holding the first page", async () => {
    await start();
    expect(current()).toBe("Alpha");
    expect(screen.getByRole("tablist", { name: "Open pages" })).toBeTruthy();
  });

  it("a click opens in the current tab", async () => {
    const app = await start();
    await app.user.click(await row("Beta"));
    await waitFor(() => expect(tabNames()).toEqual(["Beta"]));
    expect(await screen.findByRole("heading", { level: 1, name: "Beta" })).toBeTruthy();
  });

  it("Cmd/Ctrl+click opens a new tab next to the current one and shows it", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}");
    await app.user.click(await row("Beta"));
    await app.user.keyboard("{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));
    expect(current()).toBe("Beta");
    await app.user.keyboard("{Meta>}");
    await app.user.click(await row("Gamma"));
    await app.user.keyboard("{/Meta}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta", "Gamma"]));
    expect(current()).toBe("Gamma");
  });

  it("middle-click opens a new tab", async () => {
    const app = await start();
    fireEvent(await row("Beta"), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));
    expect(current()).toBe("Beta");
    expect(app.root).toBe(root);
  });

  it("Cmd/Ctrl+Enter on a focused page opens a new tab, and plain Enter opens in the current one", async () => {
    const app = await start();
    (await row("Beta")).focus();
    await app.user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));
    (await row("Gamma")).focus();
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Gamma"]));
    expect(current()).toBe("Gamma");
  });

  it("Settings opens as a tab, once, and closing it goes back to the page", async () => {
    const app = await start();
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Settings"]));
    expect(current()).toBe("Settings");
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    expect(tabNames()).toEqual(["Alpha", "Settings"]);
    await app.user.click(closeButton("Settings"));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    expect(current()).toBe("Alpha");
  });
});

describe("tab keys", () => {
  async function three() {
    const app = await start();
    for (const name of ["Beta", "Gamma"]) {
      await app.user.keyboard("{Control>}");
      await app.user.click(await row(name));
      await app.user.keyboard("{/Control}");
    }
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta", "Gamma"]));
    return app;
  }

  it("Cmd/Ctrl+T opens an empty tab and Cmd/Ctrl+W closes the current one", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}t{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "New tab"]));
    expect(current()).toBe("New tab");
    expect(screen.getByRole("heading", { name: "Nothing open" })).toBeTruthy();
    await app.user.keyboard("{Control>}w{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    expect(current()).toBe("Alpha");
  });

  it("Ctrl+Tab and Ctrl+Shift+Tab switch tabs, going round", async () => {
    const app = await three();
    expect(current()).toBe("Gamma");
    await app.user.keyboard("{Control>}{Tab}{/Control}");
    await waitFor(() => expect(current()).toBe("Alpha"));
    await app.user.keyboard("{Control>}{Shift>}{Tab}{/Shift}{/Control}");
    await waitFor(() => expect(current()).toBe("Gamma"));
    await app.user.keyboard("{Control>}{Shift>}{Tab}{/Shift}{/Control}");
    await waitFor(() => expect(current()).toBe("Beta"));
  });

  it("Cmd/Ctrl+1–9 jump to a tab; 9 is the last", async () => {
    const app = await three();
    await app.user.keyboard("{Control>}1{/Control}");
    await waitFor(() => expect(current()).toBe("Alpha"));
    await app.user.keyboard("{Control>}2{/Control}");
    await waitFor(() => expect(current()).toBe("Beta"));
    await app.user.keyboard("{Control>}9{/Control}");
    await waitFor(() => expect(current()).toBe("Gamma"));
    await app.user.keyboard("{Control>}7{/Control}"); // there is no seventh tab
    expect(current()).toBe("Gamma");
  });

  it("closing the last tab leaves one empty tab and does not open a page by itself", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}w{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["New tab"]));
    await new Promise((r) => setTimeout(r, 50));
    expect(tabNames()).toEqual(["New tab"]);
    expect(screen.getByRole("heading", { name: "Nothing open" })).toBeTruthy();
  });

  it("does not switch tabs behind an open dialog", async () => {
    const app = await three();
    await app.user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "Search" });
    await app.user.keyboard("{Control>}1{/Control}");
    expect(current()).toBe("Gamma");
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await app.user.keyboard("{Control>}1{/Control}");
    await waitFor(() => expect(current()).toBe("Alpha"));
  });
});

describe("accessibility", () => {
  it("is a tablist of tabs with one panel, labelled by the current tab", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}t{/Control}");
    await waitFor(() => expect(tabs()).toHaveLength(2));
    const [alpha, fresh] = tabs() as [HTMLElement, HTMLElement];
    expect(alpha.getAttribute("aria-selected")).toBe("false");
    expect(fresh.getAttribute("aria-selected")).toBe("true");
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(fresh.id);
    expect(fresh.getAttribute("aria-controls")).toBe(panel.id);
    expect(within(screen.getByRole("tablist")).queryAllByRole("tab")).toHaveLength(2);
  });

  it("keeps one tab in the Tab order, moves focus with the arrow keys and opens a tab with Enter", async () => {
    const app = await start();
    for (const name of ["Beta", "Gamma"]) {
      await app.user.keyboard("{Control>}");
      await app.user.click(await row(name));
      await app.user.keyboard("{/Control}");
    }
    await waitFor(() => expect(tabs()).toHaveLength(3));
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, -1, 0]);
    tabs()[2]!.focus();
    await app.user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tabs()[1]);
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    expect(current()).toBe("Gamma"); // arrows move focus; they do not open the tab
    await app.user.keyboard("{Home}");
    expect(document.activeElement).toBe(tabs()[0]);
    await app.user.keyboard("{End}");
    expect(document.activeElement).toBe(tabs()[2]);
    await app.user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tabs()[0]); // wraps
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(current()).toBe("Alpha"));
  });

  it("Delete closes the tab that has focus, and focus lands on a tab that is still there", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}");
    await app.user.click(await row("Beta"));
    await app.user.keyboard("{/Control}");
    await waitFor(() => expect(tabs()).toHaveLength(2));
    tabs()[0]!.focus();
    await app.user.keyboard("{Delete}");
    await waitFor(() => expect(tabNames()).toEqual(["Beta"]));
    await waitFor(() => expect(document.activeElement).toBe(tabs()[0]));
  });

  it("closes a tab with its close button", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}");
    await app.user.click(await row("Beta"));
    await app.user.keyboard("{/Control}");
    await waitFor(() => expect(tabs()).toHaveLength(2));
    expect(closeButton("Alpha").getAttribute("aria-hidden")).toBe("true");
    await app.user.click(closeButton("Alpha"));
    await waitFor(() => expect(tabNames()).toEqual(["Beta"]));
  });

  it("closes a tab with a middle-click", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}t{/Control}");
    await waitFor(() => expect(tabs()).toHaveLength(2));
    fireEvent(tabs()[0]!, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    await waitFor(() => expect(tabNames()).toEqual(["New tab"]));
  });
});

describe("edits are never lost when tabs change", () => {
  async function editAlpha(app: Harness) {
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("First paragraph stays exactly."));
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    await app.user.keyboard(" Typed in the tab.");
    return box;
  }

  it("switching to another tab writes the edit first", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}");
    await app.user.click(await row("Beta"));
    await app.user.keyboard("{/Control}");
    await waitFor(() => expect(current()).toBe("Beta"));
    await app.user.keyboard("{Control>}1{/Control}");
    await waitFor(() => expect(current()).toBe("Alpha"));
    await editAlpha(app);
    expect(await app.read("Alpha.md")).not.toContain("Typed in the tab.");
    await app.user.keyboard("{Control>}2{/Control}");
    await waitFor(() => expect(current()).toBe("Beta"));
    expect(await app.read("Alpha.md")).toContain("First paragraph stays exactly. Typed in the tab.");
    // And it is still there when the tab is opened again.
    await app.user.keyboard("{Control>}1{/Control}");
    await waitFor(() => expect(current()).toBe("Alpha"));
    expect((await editorBox()).textContent).toContain("Typed in the tab.");
  });

  it("closing the current tab writes the edit first", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}t{/Control}");
    await waitFor(() => expect(current()).toBe("New tab"));
    await app.user.keyboard("{Control>}1{/Control}");
    await waitFor(() => expect(current()).toBe("Alpha"));
    await editAlpha(app);
    await app.user.keyboard("{Control>}w{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["New tab"]));
    expect(await app.read("Alpha.md")).toContain("Typed in the tab.");
  });

  it("opening a page in the same tab writes the edit first", async () => {
    const app = await start();
    await editAlpha(app);
    await app.user.click(await row("Beta"));
    await waitFor(() => expect(tabNames()).toEqual(["Beta"]));
    expect(await app.read("Alpha.md")).toContain("Typed in the tab.");
  });

  it("stays on the tab when a conflict needs the user, and keeps the edit on screen", async () => {
    const app = await start();
    const box = await editAlpha(app);
    await app.external("Alpha.md", ALPHA.replace("First paragraph stays exactly.", "Rewritten elsewhere."));
    await app.user.keyboard("{Control>}t{/Control}");
    await screen.findByRole("dialog", { name: /changed on disk/i });
    expect(tabNames()).toEqual(["Alpha"]);
    expect(box.textContent).toContain("Typed in the tab.");
    expect(await app.read("Alpha.md")).toContain("Rewritten elsewhere.");
  });
});

describe("restoring tabs on restart", () => {
  it("brings the tabs back for this Private Space, with the one that was current", async () => {
    localStorage.setItem(
      tabsKey(root),
      serializeTabs(initialTabs([{ kind: "page", path: "Beta.md" }, { kind: "settings" }, { kind: "page", path: "Gamma.md" }], 2)),
    );
    await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Beta", "Settings", "Gamma"]));
    expect(current()).toBe("Gamma");
    expect(await screen.findByRole("heading", { level: 1, name: "Gamma" })).toBeTruthy();
  });

  it("saves the tabs under the vault's own key, as the user changes them", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}");
    await app.user.click(await row("Beta"));
    await app.user.keyboard("{/Control}");
    await waitFor(() => expect(JSON.parse(localStorage.getItem(tabsKey(root)) ?? "null")?.tabs).toHaveLength(2));
    expect(JSON.parse(localStorage.getItem(tabsKey(root))!)).toEqual({ v: 1, active: 1, tabs: [{ k: "page", path: "Alpha.md" }, { k: "page", path: "Beta.md" }] });
    // Another Private Space has its own list.
    expect(localStorage.getItem(tabsKey(`${root}-other`))).toBeNull();
  });

  it("drops tabs whose page is gone, but keeps the page that is current", async () => {
    localStorage.setItem(
      tabsKey(root),
      serializeTabs(initialTabs([{ kind: "page", path: "Gone.md" }, { kind: "page", path: "Beta.md" }, { kind: "page", path: "AlsoGone.md" }], 1)),
    );
    await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Beta"]));
    expect(current()).toBe("Beta");
  });

  it("shows a clear state, not a blank page, when the current tab's page is gone", async () => {
    localStorage.setItem(tabsKey(root), serializeTabs(initialTabs([{ kind: "page", path: "Gone.md" }])));
    await openApp(root);
    expect(await screen.findByText(/Gone\.md/, { selector: "p, h1" })).toBeTruthy();
    expect(current()).toBe("Gone");
  });

  it("starts with one tab when the stored text is damaged", async () => {
    localStorage.setItem(tabsKey(root), "{not json");
    await openApp(root);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
  });

  it("closes a background tab whose page was deleted while the app is open", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}");
    await app.user.click(await row("Beta"));
    await app.user.keyboard("{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));
    await app.user.keyboard("{Control>}1{/Control}");
    await waitFor(() => expect(current()).toBe("Alpha"));
    await rm(join(root, "Beta.md"));
    app.platform.emit({ paths: ["Beta.md"] });
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
  });
});
