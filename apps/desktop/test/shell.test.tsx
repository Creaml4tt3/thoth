// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTree } from "../src/features/shell/tree.ts";
import { displayPath } from "../src/features/settings/path.ts";
import { createUnavailablePlatform, selectPlatform } from "../src/platform/select.ts";
import { cleanup, editorBox, openApp, screen, waitFor, within } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";
import { WELCOME_RECORD } from "../src/features/onboarding/welcome.ts";

const tauriPlatform = createNodePlatform();
vi.mock("../src/platform/load-tauri.ts", () => ({ loadTauriPlatform: async () => tauriPlatform }));

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA });
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

describe("onboarding", () => {
  it("explains the local-first promise and lists recent Private Spaces", async () => {
    const platform = createNodePlatform({ vault: null });
    platform.recent = [root];
    const { render } = await import("@testing-library/react");
    const { App } = await import("../src/app/App.tsx");
    render(<App platform={platform} />);
    expect(await screen.findByText(/files stay on your computer as Markdown/i)).toBeTruthy();
    expect(document.querySelector('[data-theme="night"]')).not.toBeNull();
    const recent = await screen.findByRole("button", { name: new RegExp(root.split("/").pop()!) });
    expect(recent).toBeTruthy();
  });

  it("opens the vault the picker returns, and shows an error when opening fails", async () => {
    const platform = createNodePlatform({ vault: root });
    platform.openVault = async () => {
      throw new Error("Folder is locked");
    };
    const { render } = await import("@testing-library/react");
    const { userEvent } = await import("@testing-library/user-event");
    const { App } = await import("../src/app/App.tsx");
    render(<App platform={platform} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: /choose or create/i }));
    expect((await screen.findByRole("alert")).textContent).toContain("Folder is locked");
  });
});

describe("shell", () => {
  it("New page makes Untitled in the folder last clicked, opens it and starts the rename; the name is kept", async () => {
    await seed(root, { "Projects/Old.md": "# Old\n" });
    const app = await openApp(root);
    const tree = await screen.findByRole("tree");
    await app.user.click(within(tree).getByRole("treeitem", { name: "Projects" }));
    expect(within(tree).getByRole("treeitem", { name: "Projects" }).hasAttribute("data-target")).toBe(true);
    await app.user.click(screen.getByRole("button", { name: "New page" }));
    const field = await screen.findByRole("textbox", { name: "Rename Untitled" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    await waitFor(async () => expect(await app.read("Projects/Untitled.md")).toMatch(/^---\nthoth_id: .+\n---\n# Untitled\n$/));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Untitled" })).toBeTruthy());
    await app.user.keyboard("Plan{Enter}");
    await waitFor(async () => expect(await app.read("Projects/Plan.md")).toMatch(/# Plan\n$/));
    expect(within(screen.getByRole("tree")).getByRole("treeitem", { name: "Plan" })).toBeTruthy();
  });

  it("New page never overwrites a page: a taken name gets a number; a click beside the rows goes back to the top level", async () => {
    await seed(root, { "Untitled.md": "# Untitled\n", "Projects/Old.md": "# Old\n" });
    const app = await openApp(root);
    const tree = await screen.findByRole("tree");
    await app.user.click(within(tree).getByRole("treeitem", { name: "Projects" }));
    await app.user.click(tree.closest(".private-tree")!);
    expect(within(tree).getByRole("treeitem", { name: "Projects" }).hasAttribute("data-target")).toBe(false);
    await app.user.click(screen.getByRole("button", { name: "New page" }));
    await screen.findByRole("textbox", { name: "Rename Untitled 2" });
    await app.user.keyboard("{Escape}");
    expect(await app.read("Untitled.md")).toBe("# Untitled\n");
    expect(await app.read("Untitled 2.md")).toMatch(/# Untitled 2\n$/);
    expect(await app.read("Alpha.md")).toBe(ALPHA);
  });

  it("sidebar tree items are keyboard operable", async () => {
    await seed(root, { "Dir/Inner.md": "# Inner\n" });
    const app = await openApp(root);
    const tree = await screen.findByRole("tree");
    const folder = within(tree).getByRole("treeitem", { name: "Dir" });
    folder.focus();
    await app.user.keyboard("{Enter}");
    const inner = await within(tree).findByRole("treeitem", { name: "Inner" });
    inner.focus();
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Inner" })).toBeTruthy());
    expect(await editorBox()).toBeTruthy();
  });
});

describe("settings", () => {
  it("shows the vault location and rebuilds the index", async () => {
    const app = await openApp(root);
    await screen.findByRole("tree");
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const location = await screen.findByTestId("vault-location");
    expect(location.getAttribute("title")).toBe(root);
    expect(location.textContent).toBe(displayPath(root));
    await app.user.click(screen.getByRole("button", { name: "Rebuild index" }));
    await waitFor(() => expect(screen.getByText(/Index rebuilt \(2 pages read\)/)).toBeTruthy());
    expect(screen.getByRole("heading", { name: "Import & Export" })).toBeTruthy();
  });

  it("lists its sections beside the page; a link moves focus to that section's heading", async () => {
    const app = await openApp(root);
    await screen.findByRole("tree");
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    const links = within(nav).getAllByRole("link").map((a) => a.textContent);
    expect(links[0]).toBe("Private Space");
    expect(links.slice(-6)).toEqual(["Language", "Theme", "Editor", "Search index", "Import & Export", "Help and feedback"]);
    expect(links).toContain("Servers");
    // Every link goes to a heading on the page.
    for (const a of within(nav).getAllByRole("link")) expect(document.querySelector(a.getAttribute("href")!)?.tagName).toBe("H2");
    await app.user.click(within(nav).getByRole("link", { name: "Theme" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Theme" }));
    expect(within(nav).getByRole("link", { name: "Theme" }).getAttribute("aria-current")).toBe("true");
  });
});

describe("Import from Notion or Obsidian", () => {
  const wizardStarted = async () => {
    const title = await screen.findByRole("heading", { name: "Choose a source" });
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
  };

  it("the sidebar button opens Settings at Import & Export with the wizard started, again after it was closed", async () => {
    const app = await openApp(root);
    await screen.findByRole("tree");
    const button = screen.getByRole("button", { name: "Import from Notion or Obsidian" });
    expect(button.closest(".side-actions")).toBeTruthy();
    await app.user.click(button);
    await wizardStarted();
    await app.user.click(within(screen.getByRole("region", { name: "Import" })).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Choose a source" })).toBeNull());
    await app.user.click(button);
    await wizardStarted();
  });

  it("is a palette command", async () => {
    const app = await openApp(root);
    await screen.findByRole("tree");
    await app.user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    await app.user.keyboard("> import");
    await app.user.click(within(search).getByRole("option", { name: /^Import from Notion or Obsidian…/ }));
    await wizardStarted();
  });

  it("is offered in an empty Private Space's tree", async () => {
    root = await dirs.dir();
    // Had its Welcome pages once (ADR-0032), and they were deleted: the tree is empty.
    await seed(root, { [WELCOME_RECORD]: '{ "version": 1 }\n' });
    const app = await openApp(root);
    await app.user.click(await screen.findByRole("button", { name: /start writing/i }));
    const empty = (await screen.findByText("No pages yet.")).closest(".tree-empty")!;
    await app.user.click(within(empty as HTMLElement).getByRole("button", { name: "Import from Notion or Obsidian" }));
    await wizardStarted();
  });
});

describe("tree and paths", () => {
  it("groups pages by folder with folders first", () => {
    const page = (path: string) => ({ id: path, path, title: path.split("/").pop()!.replace(/\.md$/, ""), contentHash: "", size: 0, mtimeMs: 0, aliases: [], tags: [] });
    const tree = buildTree([page("b.md"), page("A/x.md"), page("A/B/y.md"), page("a.md")]);
    expect(tree.map((n) => `${n.kind}:${n.path}`)).toEqual(["folder:A", "page:a.md", "page:b.md"]);
    const folder = tree[0]!;
    expect(folder.kind === "folder" && folder.children.map((n) => `${n.kind}:${n.path}`)).toEqual(["folder:A/B", "page:A/x.md"]);
  });

});

describe("platform selection", () => {
  it("prefers an injected platform, then Tauri, otherwise an explanatory stub", async () => {
    const injected = createNodePlatform();
    expect(await selectPlatform({ __THOTH_PLATFORM__: injected } as unknown as Window)).toBe(injected);
    expect(await selectPlatform({ __THOTH_PLATFORM__: () => injected } as unknown as Window)).toBe(injected);
    expect(await selectPlatform({ __TAURI_INTERNALS__: {} } as unknown as Window)).toBe(tauriPlatform);
    // An injected bridge wins even inside Tauri.
    expect(await selectPlatform({ __THOTH_PLATFORM__: injected, __TAURI_INTERNALS__: {} } as unknown as Window)).toBe(injected);
    const none = await selectPlatform({} as Window);
    expect(none.kind).toBe("bridge");
    await expect(none.pickVaultFolder()).rejects.toThrow(/__THOTH_PLATFORM__/);
    expect(await createUnavailablePlatform().recentVaults()).toEqual([]);
  });
});
