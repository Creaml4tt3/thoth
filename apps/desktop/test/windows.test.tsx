// @vitest-environment jsdom
// Moving a tab to a new window, and windows on one Private Space (ADR-0019), against a recorded desktop shell.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { planImport, saveManifest } from "@thoth/importer-core";
import { ObsidianVaultImporter } from "@thoth/importer-obsidian/node";
import { JOURNAL_DIR, TEMP_DIR } from "@thoth/local-store";
import { openNodeVault } from "@thoth/local-store/node";
import { createImportService } from "../src/features/import/service.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { initialTabs, serializeTabs, type TabTarget } from "@thoth/app-ui/tabs/model.ts";
import { parseLayout } from "@thoth/app-ui/tabs/layout.ts";
import { App, DEFAULT_OPTIONS } from "../src/app/App.tsx";
import { readLaunch } from "../src/app/windows.ts";
import { tabsKey } from "../src/app/tabs-store.ts";
import { WINDOWS_KEY, rememberWindow, windowsOn } from "../src/app/windows-store.ts";
import { caretAtEnd, cleanup, editorBox, openApp, paragraph, screen, TEST_OPTIONS, waitFor, within } from "./support/render.tsx";
import { createFakeWindows, createNodePlatform, tempDirs, type FakeWindows } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";

/** The first pane's stored tabs (`v: 2`, ADR-0030). */
const storedTabs = (text: string | null) => (text ? JSON.parse(text)?.panes?.[0]?.tabs : undefined);

const OBSIDIAN = resolve(import.meta.dirname, "../../../tests/fixtures/obsidian-vault");
const dirs = tempDirs();
let root: string;
let windows: FakeWindows;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA, "Gamma.md": "# Gamma\n\nThe third page.\n" });
  windows = createFakeWindows();
});
afterEach(async () => {
  cleanup();
  localStorage.clear();
  await dirs.cleanup();
});

const tabs = () => screen.queryAllByRole("tab");
const tabNames = () => tabs().map((t) => t.textContent);
const current = () => tabs().find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const row = async (name: string) => within(await screen.findByRole("tree", { name: "Pages in this Private Space" })).getByRole("treeitem", { name });
const page = (path: string): TabTarget => ({ kind: "page", path });
const opened = (i = 0) => parseLayout(windows.opened[i]!.tabs)!.panes[0]!.tabs.map((t) => (t.target.kind === "page" ? t.target.path : t.target.kind));

/** The main window with Alpha, Beta and Gamma open in tabs, Gamma current. */
async function mainWindow() {
  const app = await openApp(root, {}, createNodePlatform({ vault: root, windows }));
  await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
  for (const name of ["Beta", "Gamma"]) {
    await app.user.keyboard("{Control>}");
    await app.user.click(await row(name));
    await app.user.keyboard("{/Control}");
  }
  await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta", "Gamma"]));
  return app;
}

describe("the window a window was opened as", () => {
  it("reads its id, folder and tabs from its address; anything else is the main window", () => {
    const tabsText = serializeTabs(initialTabs([page("Beta.md")]));
    const query = `?window=space-ab12cd34&root=${encodeURIComponent("/Users/a/Notes & more")}&tabs=${encodeURIComponent(tabsText)}`;
    expect(readLaunch(query)).toEqual({ id: "space-ab12cd34", root: "/Users/a/Notes & more", tabs: tabsText });
    for (const bad of ["", "?window=main", "?window=space-", "?window=Space-AB", "?window=space-../x", `?window=space-${"a".repeat(40)}`, "?root=/x"]) expect(readLaunch(bad), bad).toEqual({ id: "main", root: null, tabs: null });
    expect(readLaunch("?window=space-ab12cd34")).toEqual({ id: "space-ab12cd34", root: null, tabs: null });
  });
});

describe("moving a tab to a new window", () => {
  it("from the tab's menu: a new window opens on this Private Space with that tab, and the tab leaves this one", async () => {
    await mainWindow();
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Beta" }), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Move tab to new window" }));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Gamma"]));
    expect(windows.opened).toHaveLength(1);
    const request = windows.opened[0]!;
    expect(request.id).toMatch(/^space-[a-z0-9]{16}$/);
    expect(request.root).toBe(root);
    expect(request.at).toBeUndefined();
    expect(opened()).toEqual(["Beta.md"]);
    expect(current()).toBe("Gamma");
    // Both come back on restart: this window without Beta, the new one with it.
    expect(storedTabs(localStorage.getItem(tabsKey(root)))).toEqual([{ k: "page", path: "Alpha.md" }, { k: "page", path: "Gamma.md" }]);
    expect(windowsOn(root)).toEqual([request.id]);
  });

  it("from the palette, the current tab goes, after its edits are written", async () => {
    const app = await mainWindow();
    await app.user.keyboard("{Control>}k{/Control}");
    await app.user.keyboard("> move tab to new window");
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));
    expect(opened()).toEqual(["Gamma.md"]);
    expect(current()).toBe("Beta");
  });

  it("dragged out of the bar, it opens where it was let go", async () => {
    await mainWindow();
    const alpha = screen.getByRole("tab", { name: "Alpha" }).closest(".tab")!;
    fireEvent.pointerDown(alpha, { clientX: 20, clientY: 10, screenX: 120, screenY: 110, button: 0, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 300, screenX: 140, screenY: 400, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerUp(window, { clientX: 40, clientY: 300, screenX: 900, screenY: 500, button: 0, pointerId: 1, pointerType: "mouse" });
    await waitFor(() => expect(tabNames()).toEqual(["Beta", "Gamma"]));
    expect(windows.opened[0]!.at).toEqual({ x: 900, y: 500 });
    expect(opened()).toEqual(["Alpha.md"]);
  });

  it("keeps the tab, and says so, when the new window cannot open", async () => {
    windows.open = async () => {
      throw new Error("The window could not be opened");
    };
    await mainWindow();
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Beta" }), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Move tab to new window" }));
    expect(await screen.findByText(/could not be opened/)).toBeTruthy();
    expect(tabNames()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("is not offered for a window's only tab", async () => {
    const app = await openApp(root, {}, createNodePlatform({ vault: root, windows }));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    await app.user.keyboard("{Control>}k{/Control}");
    await app.user.keyboard("> move tab");
    const options = within(await screen.findByRole("dialog", { name: "Search" })).queryAllByRole("option").map((o) => o.textContent ?? "");
    expect(options.some((o) => o.startsWith("Move tab to new window"))).toBe(false);
  });
});

describe("a window opened on a Private Space", () => {
  async function launched(id: string, targets: TabTarget[], platform = createNodePlatform({ vault: root, windows, recent: [root] })) {
    const launch = { id, root, tabs: serializeTabs(initialTabs(targets)) };
    render(<App platform={platform} launch={launch} options={{ ...DEFAULT_OPTIONS, ...TEST_OPTIONS }} />);
    return { platform, user: userEvent.setup() };
  }

  it("opens the folder by itself with its tabs, and keeps them under its own name", async () => {
    await launched("space-0000000000000001", [page("Beta.md")]);
    await waitFor(() => expect(tabNames()).toEqual(["Beta"]));
    expect(await screen.findByRole("heading", { level: 1, name: "Beta" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /choose or create a private space/i })).toBeNull();
    await waitFor(() => expect(storedTabs(localStorage.getItem(tabsKey(root, "space-0000000000000001")))).toEqual([{ k: "page", path: "Beta.md" }]));
    expect(localStorage.getItem(tabsKey(root))).toBeNull(); // the main window's list is not touched
    expect(windowsOn(root)).toEqual(["space-0000000000000001"]);
    // The whole shell: the page tree and the tab bar.
    expect(await row("Gamma")).toBeTruthy();
  });

  it("does not run start-up recovery while another window has the folder open: what it would sweep is in flight", async () => {
    await mkdir(join(root, ".thoth", "tmp"), { recursive: true });
    await writeFile(join(root, ".thoth", "tmp", "01J00000000000000000000000.tmp"), "the other window's save");
    const platform = createNodePlatform({ vault: root, windows, recent: [root] });
    platform.sharedWith.push(root);
    await launched("space-0000000000000002", [page("Alpha.md")], platform);
    await editorBox();
    expect(platform.connections[0]!.shared).toBe(true);
    expect(await readdir(join(root, ".thoth", "tmp"))).toEqual(["01J00000000000000000000000.tmp"]);
  });

  it("runs the recovery it skipped once the other window has closed and it is the only one", async () => {
    // The other window closed in the middle of a delete (ADR-0001): the page waits in Thoth's temp folder.
    const id = "0190a5b0-0000-7000-8000-000000000001";
    await mkdir(join(root, TEMP_DIR), { recursive: true });
    await mkdir(join(root, JOURNAL_DIR), { recursive: true });
    await writeFile(join(root, TEMP_DIR, `${id}.tmp`), "# Delta\n\nHalf deleted.\n");
    await writeFile(join(root, JOURNAL_DIR, `${id}.json`), JSON.stringify({ id, kind: "delete-file", path: "Delta.md", tempPath: `${TEMP_DIR}/${id}.tmp`, expectedHash: "x", newHash: null, createdAt: 0 }));
    const platform = createNodePlatform({ vault: root, windows, recent: [root] });
    platform.sharedWith.push(root);
    await launched("space-0000000000000006", [page("Alpha.md")], platform);
    await editorBox();
    expect(await readdir(join(root, TEMP_DIR))).toEqual([`${id}.tmp`]);

    // Another Private Space's window closing changes nothing here.
    windows.emitClosed("space-00000000000000ff");
    await new Promise((r) => setTimeout(r, 50));
    expect(await readdir(join(root, TEMP_DIR))).toEqual([`${id}.tmp`]);

    platform.sharedWith.splice(0);
    windows.emitClosed("space-0000000000000007");
    await waitFor(async () => expect(await readdir(join(root, JOURNAL_DIR))).toEqual([]));
    expect(await readdir(join(root, TEMP_DIR))).toEqual([]);
    expect(await readFile(join(root, "Delta.md"), "utf8")).toBe("# Delta\n\nHalf deleted.\n");
    expect(await row("Delta")).toBeTruthy();
  });

  it("is reopened with its own tabs when the main window opens the Private Space again", async () => {
    rememberWindow("space-0000000000000003", root);
    localStorage.setItem(tabsKey(root, "space-0000000000000003"), serializeTabs(initialTabs([page("Gamma.md"), page("Beta.md")], 1)));
    rememberWindow("space-0000000000000004", `${root}-elsewhere`);
    await openApp(root, {}, createNodePlatform({ vault: root, windows }));
    await waitFor(() => expect(windows.opened.map((w) => w.id)).toEqual(["space-0000000000000003"]));
    expect(opened()).toEqual(["Gamma.md", "Beta.md"]);
    const back = parseLayout(windows.opened[0]!.tabs)!.panes[0]!;
    expect(back.active).toBe(back.tabs[1]!.id);
  });

  it("is forgotten when it is closed, so it does not come back", async () => {
    rememberWindow("space-0000000000000005", root);
    localStorage.setItem(tabsKey(root, "space-0000000000000005"), serializeTabs(initialTabs([page("Gamma.md")])));
    await openApp(root, {}, createNodePlatform({ vault: root, windows }));
    await waitFor(() => expect(windows.opened).toHaveLength(1));
    windows.emitClosed("space-0000000000000005");
    await waitFor(() => expect(windowsOn(root)).toEqual([]));
    expect(localStorage.getItem(tabsKey(root, "space-0000000000000005"))).toBeNull();
    expect(JSON.parse(localStorage.getItem(WINDOWS_KEY)!)).toEqual({ v: 1, windows: [] });
  });
});

describe("an unfinished import with another window open", () => {
  it("is offered for resume only while this window is the only one on the Private Space", async () => {
    const { vault } = await openNodeVault(root);
    const opened = await ObsidianVaultImporter.open(OBSIDIAN);
    const { manifest } = await planImport({ vault, source: opened.source, provider: opened.provider });
    await opened.source.close();
    await saveManifest(vault.fs, { ...manifest, state: "staging" });
    let shared = true;
    const service = createImportService(vault, () => Promise.reject(new Error("not used")), { shared: async () => shared });
    expect(await service.listJobs()).toEqual([]); // it may be running in the other window
    shared = false;
    expect((await service.listJobs()).map((j) => j.jobId)).toEqual([manifest.jobId]);
    await vault.close();
  });
});

describe("the window's close button", () => {
  it("writes the edits first, then closes the window, even the last one", async () => {
    const app = await openApp(root, { autosaveMs: 60_000 }, createNodePlatform({ vault: root, windows }));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("First paragraph stays exactly."));
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    await app.user.keyboard(" Typed just before closing.");
    windows.emitCloseRequested();
    await waitFor(() => expect(windows.closed).toBe(1));
    expect(await app.read("Alpha.md")).toContain("First paragraph stays exactly. Typed just before closing.");
  });

  it("closes a window that has no Private Space open at once", async () => {
    render(<App platform={createNodePlatform({ vault: root, windows })} options={{ ...DEFAULT_OPTIONS, ...TEST_OPTIONS }} />);
    await screen.findByRole("button", { name: /choose or create a private space/i });
    windows.emitCloseRequested();
    await waitFor(() => expect(windows.closed).toBe(1));
  });
});

describe("Cmd/Ctrl+W", () => {
  it("closes the window after its last tab when another window is open", async () => {
    windows.others = 1;
    const app = await openApp(root, {}, createNodePlatform({ vault: root, windows }));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    await app.user.keyboard("{Control>}w{/Control}");
    await waitFor(() => expect(windows.closed).toBe(1));
    expect(tabNames()).toEqual(["Alpha"]); // the window goes as it is
  });

  it("leaves an empty tab in the last window, as before", async () => {
    const app = await openApp(root, {}, createNodePlatform({ vault: root, windows }));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    await app.user.keyboard("{Control>}w{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["New tab"]));
    expect(windows.closed).toBe(0);
  });
});
