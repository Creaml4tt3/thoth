// @vitest-environment jsdom
// Rename in place (F2, the row menu) and New folder in the Private Space tree (ADR-0016 rules 3 and 4, Phase 3b follow-up).
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, Vault } from "@thoth/local-store";
import { fireEvent } from "@testing-library/react";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";
import { th } from "../src/strings/index.ts";
import { th as sharedTh } from "@thoth/app-ui/strings/index.ts";

const dirs = tempDirs();
let root: string;

// Alpha: a title that is only a heading equal to the file name; links out and a Markdown link into Docs.
const ALPHA = "# Alpha\n\nSee [the beta](Beta.md), [[Gamma]] and [notes](Docs/Notes.md).\n";
// Beta: frontmatter `title:` equal to the file name, another key, a heading, and a link back.
const BETA = "---\ntitle: Beta\nowner: ada\n---\n# Beta\n\nLinks back to [[Alpha]].\n";
// Gamma: a title and a heading that are not the file name: the text must never change.
const GAMMA = "---\ntitle: A custom title\n---\n# Gamma heading\n\nSee [[Beta]].\n";
// Delta: no title at all; the file name is the title.
const DELTA = "Just text, no heading.\n";
const NOTES = "# Notes\n\nBack to [alpha](../Alpha.md).\n";
const ORDER = { version: 1, folders: { "": ["Docs", "Gamma.md", "Alpha.md", "Beta.md", "Delta.md"], Docs: ["Deep", "Notes.md"] } };

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, {
    "Alpha.md": ALPHA,
    "Beta.md": BETA,
    "Gamma.md": GAMMA,
    "Delta.md": DELTA,
    "Docs/Notes.md": NOTES,
    "Docs/Deep/Inner.md": "# Inner\n",
    ".thoth/order.json": JSON.stringify(ORDER),
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  localStorage.removeItem("thoth.desktop.lang");
  cleanup();
  await dirs.cleanup();
});

const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);
const current = () => screen.queryAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const treeEl = (name = "Pages in this Private Space") => screen.findByRole("tree", { name });
const rows = async () => within(await treeEl()).getAllByRole("treeitem").map((r) => r.textContent);
const rowEl = async (name: string) => within(await treeEl()).findByRole("treeitem", { name });
/** The inline rename field, if one is open (the page editor is a textbox too). */
const fieldNow = () => document.querySelector<HTMLInputElement>("input.tree-rename");
const exists = (path: string) => stat(join(root, path)).then(() => true, () => false);
const read = (path: string) => readFile(join(root, path), "utf8");
const order = async () => JSON.parse(await read(".thoth/order.json")) as { folders: Record<string, string[]> };

async function start(options: { rowsReady?: string } = {}): Promise<Harness> {
  const app = await openApp(root);
  await waitFor(() => expect(current()).toBe("Alpha"));
  await within(await treeEl()).findByRole("treeitem", { name: options.rowsReady ?? "Docs" });
  return app;
}

/** F2 on the row, then the field. */
async function rename(app: Harness, row: string, label = row) {
  (await rowEl(row)).focus();
  await app.user.keyboard("{F2}");
  return (await screen.findByRole("textbox", { name: `Rename ${label}` })) as HTMLInputElement;
}

describe("rename a page with F2", () => {
  it("edits the file name, moves the file, rewrites links, follows the title text, keeps the tab and the order entry", async () => {
    const app = await start();
    const field = await rename(app, "Alpha");
    expect(field.value).toBe("Alpha"); // the file name without .md
    expect(document.activeElement).toBe(field);
    await app.user.clear(field);
    await app.user.type(field, "Omega{Enter}");

    await waitFor(async () => expect(await exists("Omega.md")).toBe(true));
    expect(await exists("Alpha.md")).toBe(false);
    // The heading that said the old name says the new one; nothing else in the page changed.
    await waitFor(async () => expect(await read("Omega.md")).toBe("# Omega\n\nSee [the beta](Beta.md), [[Gamma]] and [notes](Docs/Notes.md).\n"));
    // Links to it follow (a wikilink and a relative Markdown link) in other pages, including a page inside a folder.
    await waitFor(async () => expect(await read("Beta.md")).toContain("[[Omega]]"));
    expect(await read("Docs/Notes.md")).toBe("# Notes\n\nBack to [alpha](../Omega.md).\n");
    // The tab follows, and so does the tree, with the entry in the same place in the order record.
    await waitFor(() => expect(tabNames()).toEqual(["Omega"]));
    await waitFor(async () => expect((await order()).folders[""]).toEqual(["Docs", "Gamma.md", "Omega.md", "Beta.md", "Delta.md"]));
    await waitFor(async () => expect(await rows()).toEqual(["Docs", "A custom title", "Omega", "Beta", "Delta"]));
    const renamed = await rowEl("Omega");
    expect(renamed.getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(document.activeElement).toBe(renamed));
    expect(fieldNow()).toBeNull();
    expect((await treeEl()).parentElement!.querySelector("[data-tree-said]")!.textContent).toBe("Renamed to Omega");
  });

  it("updates a frontmatter title equal to the old name too, keeping the other keys", async () => {
    const app = await start();
    const field = await rename(app, "Beta");
    await app.user.clear(field);
    await app.user.type(field, "Zeta{Enter}");
    await waitFor(async () => expect(await exists("Zeta.md")).toBe(true));
    await waitFor(async () => expect(await read("Zeta.md")).toBe("---\ntitle: Zeta\nowner: ada\n---\n# Zeta\n\nLinks back to [[Alpha]].\n"));
    expect(await read("Alpha.md")).toContain("[the beta](Zeta.md)");
    await waitFor(async () => expect((await order()).folders[""]).toEqual(["Docs", "Gamma.md", "Alpha.md", "Zeta.md", "Delta.md"]));
  });

  it("leaves a page whose title is not the old name byte for byte as it was, and a page with no title text", async () => {
    const app = await start();
    const gamma = await rename(app, "A custom title", "Gamma");
    expect(gamma.value).toBe("Gamma");
    await app.user.clear(gamma);
    await app.user.type(gamma, "Sigma{Enter}");
    await waitFor(async () => expect(await exists("Sigma.md")).toBe(true));
    expect(await read("Sigma.md")).toBe(GAMMA);
    await waitFor(() => expect(within(screen.getByRole("tree", { name: "Pages in this Private Space" })).queryByRole("textbox")).toBeNull());

    const delta = await rename(app, "Delta");
    await app.user.clear(delta);
    await app.user.type(delta, "Epsilon{Enter}");
    await waitFor(async () => expect(await exists("Epsilon.md")).toBe(true));
    expect(await read("Epsilon.md")).toBe(DELTA);
    // Its title is its file name, so the tree shows the new name.
    await waitFor(async () => expect(await rows()).toContain("Epsilon"));
    expect((await order()).folders[""]).toEqual(["Docs", "Sigma.md", "Alpha.md", "Beta.md", "Epsilon.md"]);
  });

  it("the row menu has Rename, which starts the same field", async () => {
    const app = await start();
    fireEvent.contextMenu(await rowEl("Beta"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Add to Favorites", "RenameF2", "Move up⌥⇧↑", "Move down⌥⇧↓", "Move to…"]);
    await app.user.click(within(menu).getByRole("menuitem", { name: /^Rename/ }));
    const field = (await screen.findByRole("textbox", { name: "Rename Beta" })) as HTMLInputElement;
    expect(field.value).toBe("Beta");
    await app.user.clear(field);
    await app.user.type(field, "Theta{Enter}");
    await waitFor(async () => expect(await exists("Theta.md")).toBe(true));
  });

  it("Escape cancels: nothing changes and focus returns to the row", async () => {
    const app = await start();
    const field = await rename(app, "Beta");
    await app.user.clear(field);
    await app.user.type(field, "Nope");
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(fieldNow()).toBeNull());
    expect(await read("Beta.md")).toBe(BETA);
    expect(await exists("Nope.md")).toBe(false);
    await waitFor(async () => expect(document.activeElement).toBe(await rowEl("Beta")));
  });

  it("keeps the field open with a message for a name that is not allowed, and changes nothing", async () => {
    const app = await start();
    const field = await rename(app, "Beta");
    const refuse = async (text: string, message: RegExp) => {
      await app.user.clear(field);
      if (text) await app.user.type(field, text.replaceAll("\\", "\\\\"));
      await app.user.keyboard("{Enter}");
      await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(message));
      expect(field.isConnected).toBe(true);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      await waitFor(() => expect(document.activeElement).toBe(field));
    };
    await refuse("", /Give it a name/);
    await refuse("a/b", /cannot contain \//);
    await refuse("a\\b", /cannot contain \//);
    await refuse(".thoth", /reserved/);
    await refuse("a:b", /cannot contain :/);
    await refuse("what?", /cannot contain :/);
    await refuse("CON", /cannot contain :/);
    await refuse("name.", /cannot contain :/);
    await refuse("Gamma", /already there/);
    await refuse("gamma", /already there/); // letter case does not make a different name
    await refuse("DELTA", /already there/);
    await refuse("ก".repeat(100), /too long/); // 300 bytes: no volume takes it, though it is under the field's 200 characters
    // Editing the text clears the message; the page is as it was.
    await app.user.type(field, "!");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await read("Beta.md")).toBe(BETA);
    expect((await readdir(root)).sort()).toEqual([".thoth", "Alpha.md", "Beta.md", "Delta.md", "Docs", "Gamma.md"]);
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(fieldNow()).toBeNull());
    expect(tabNames()).toEqual(["Alpha"]);
  });

  it("can change only the letter case of a name", async () => {
    const app = await start();
    const field = await rename(app, "Delta");
    await app.user.clear(field);
    await app.user.type(field, "DELTA{Enter}");
    await waitFor(async () => expect((await readdir(root)).includes("DELTA.md")).toBe(true));
    expect((await readdir(root)).includes("Delta.md")).toBe(false);
  });

  it("leaves the title alone and says so when the page changed since it was moved", async () => {
    const app = await start();
    const field = await rename(app, "Beta");
    await app.user.clear(field);
    await app.user.type(field, "Zeta");
    // The title is written with a compare-and-swap on the bytes just read; another program got there first.
    const write = vi.spyOn(Vault.prototype, "writePage").mockRejectedValueOnce(new ConflictError("Zeta.md", "old", "new"));
    await app.user.keyboard("{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("Renamed to Zeta. The title inside the page was not updated because the page changed.");
    expect(write).toHaveBeenCalledTimes(1);
    expect(await read("Zeta.md")).toBe(BETA); // renamed, and the text was not written over
    expect(await exists("Beta.md")).toBe(false);
    expect(fieldNow()).toBeNull();
  });
});

describe("rename a folder with F2", () => {
  it("moves the directory, rewrites links to what is in it, and keeps the tabs on its pages and its order", async () => {
    const app = await start();
    // A page in the folder in the current tab, and Beta in a second tab.
    await app.user.click(await rowEl("Docs"));
    await app.user.click(await rowEl("Notes"));
    await waitFor(() => expect(current()).toBe("Notes"));
    await app.user.keyboard("{Control>}");
    await app.user.click(await rowEl("Beta"));
    await app.user.keyboard("{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Notes", "Beta"]));

    const field = await rename(app, "Docs");
    expect(field.value).toBe("Docs");
    await app.user.clear(field);
    await app.user.type(field, "Papers{Enter}");

    await waitFor(async () => expect(await exists("Papers/Notes.md")).toBe(true));
    expect(await exists("Docs")).toBe(false);
    expect(await exists("Papers/Deep/Inner.md")).toBe(true);
    await waitFor(async () => expect(await read("Alpha.md")).toBe("# Alpha\n\nSee [the beta](Beta.md), [[Gamma]] and [notes](Papers/Notes.md).\n"));
    // Pages inside keep their relative links; the order of the folder's children moves with it, and its own place stays.
    expect(await read("Papers/Notes.md")).toBe(NOTES);
    await waitFor(async () => expect(await order()).toMatchObject({ folders: { "": ["Papers", "Gamma.md", "Alpha.md", "Beta.md", "Delta.md"], Papers: ["Deep", "Notes.md"] } }));
    expect((await order()).folders["Docs"]).toBeUndefined();
    // The tabs followed the rename (the one in the background was not closed for being "gone").
    await waitFor(() => expect(tabNames()).toEqual(["Notes", "Beta"]));
    expect(current()).toBe("Beta");
    const notes = await rowEl("Notes");
    await waitFor(() => expect(notes.getAttribute("title")).toBe("Papers/Notes.md"));
    await app.user.click(screen.getAllByRole("tab")[0]!);
    await waitFor(() => expect(current()).toBe("Notes"));
    await waitFor(async () => expect((await rowEl("Notes")).getAttribute("aria-current")).toBe("page"));
    // The folder stays open under its new name.
    expect((await rowEl("Papers")).getAttribute("aria-expanded")).toBe("true");
  });

  it("refuses a folder name that is taken, and the names the vault does not scan", async () => {
    await mkdir(join(root, "Archive"));
    const app = await start();
    const field = await rename(app, "Docs");
    for (const [text, message] of [
      [".git", /reserved/],
      [".thoth", /reserved/],
      ["node_modules", /reserved/],
      ["archive", /already there/], // another folder, in a different letter case
    ] as const) {
      await app.user.clear(field);
      await app.user.type(field, text);
      await app.user.keyboard("{Enter}");
      await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(message));
    }
    // Only the letter case of its own name is free to change.
    await app.user.clear(field);
    await app.user.type(field, "docs{Enter}");
    await waitFor(async () => expect((await readdir(root)).includes("docs")).toBe(true));
    expect(await exists("docs/Notes.md")).toBe(true);
  });
});

describe("New folder", () => {
  /** The textbox the new folder is named in. */
  const naming = async (name: string) => (await screen.findByRole("textbox", { name: `Rename ${name}` })) as HTMLInputElement;

  it("the sidebar button creates 'Untitled folder', 'Untitled folder 2'…, shows it and starts the rename", async () => {
    const app = await start();
    await app.user.click(screen.getByRole("button", { name: "New folder" }));
    const first = await naming("Untitled folder");
    expect(first.value).toBe("Untitled folder");
    expect(document.activeElement).toBe(first);
    expect((await stat(join(root, "Untitled folder"))).isDirectory()).toBe(true);
    // Escape keeps the folder with its default name.
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(fieldNow()).toBeNull());
    expect(await rows()).toContain("Untitled folder");
    expect((await rowEl("Untitled folder")).getAttribute("title")).toBe("Folder · Empty");

    await app.user.click(screen.getByRole("button", { name: "New folder" }));
    const second = await naming("Untitled folder 2");
    expect((await stat(join(root, "Untitled folder 2"))).isDirectory()).toBe(true);
    await app.user.clear(second);
    await app.user.type(second, "Ideas{Enter}");
    await waitFor(async () => expect(await exists("Ideas")).toBe(true));
    expect(await exists("Untitled folder 2")).toBe(false);
    await waitFor(async () => expect(await rows()).toEqual(expect.arrayContaining(["Ideas", "Untitled folder"])));
    // Folders hold no content, so renaming one touches no page and records no order.
    expect((await order()).folders[""]).toEqual(["Docs", "Gamma.md", "Alpha.md", "Beta.md", "Delta.md"]);
  });

  it("'New folder inside' in a folder's menu creates it in that folder, opens the folder and starts the rename", async () => {
    const app = await start();
    fireEvent.contextMenu(await rowEl("Docs"));
    const menu = await screen.findByRole("menu", { name: "Actions for Docs" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["RenameF2", "New folder inside", "Move up⌥⇧↑", "Move down⌥⇧↓", "Move to…"]);
    await app.user.click(within(menu).getByRole("menuitem", { name: "New folder inside" }));
    const field = await naming("Untitled folder");
    expect((await stat(join(root, "Docs/Untitled folder"))).isDirectory()).toBe(true);
    expect((await rowEl("Docs")).getAttribute("aria-expanded")).toBe("true");
    expect((await rowEl("Untitled folder")).getAttribute("aria-level")).toBe("2");
    await app.user.clear(field);
    await app.user.type(field, "Drafts{Enter}");
    await waitFor(async () => expect(await exists("Docs/Drafts")).toBe(true));
    // Nested: a folder inside the new one (once the field has closed and the row is a row again).
    await waitFor(() => expect(fieldNow()).toBeNull());
    fireEvent.contextMenu(await rowEl("Drafts"));
    await app.user.click(await screen.findByRole("menuitem", { name: "New folder inside" }));
    await naming("Untitled folder");
    expect(await exists("Docs/Drafts/Untitled folder")).toBe(true);
  });

  it("the menu of the empty area creates one at the top level", async () => {
    const app = await start();
    const area = (await treeEl()).parentElement!;
    expect(area.className).toContain("private-tree");
    fireEvent.contextMenu(area);
    const menu = await screen.findByRole("menu", { name: "Pages in this Private Space" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["New folder"]);
    await app.user.click(within(menu).getByRole("menuitem", { name: "New folder" }));
    await naming("Untitled folder");
    expect(await exists("Untitled folder")).toBe(true);
  });

  it("Ctrl/Cmd+Shift+N creates it in the folder the tree has focus in (the page's folder for a page), else at the top level", async () => {
    const app = await start();
    const chord = "{Control>}{Shift>}n{/Shift}{/Control}";
    (await rowEl("Docs")).focus();
    await app.user.keyboard(chord);
    await naming("Untitled folder");
    expect(await exists("Docs/Untitled folder")).toBe(true);
    await app.user.keyboard("{Escape}");

    await app.user.click(await rowEl("Notes"));
    (await rowEl("Notes")).focus();
    await app.user.keyboard(chord);
    await naming("Untitled folder 2");
    expect(await exists("Docs/Untitled folder 2")).toBe(true); // next to Notes.md, in Docs
    await app.user.keyboard("{Escape}");

    (document.activeElement as HTMLElement | null)?.blur();
    await app.user.keyboard(chord);
    await naming("Untitled folder");
    expect(await exists("Untitled folder")).toBe(true);
  });

  it("'> New folder' in the command palette creates one and starts the rename", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "Search" });
    await app.user.keyboard("> new folder");
    const options = within(screen.getByRole("dialog", { name: "Search" })).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual([expect.stringContaining("New folder")]);
    expect(options[0]).toContain("Ctrl+Shift+N");
    await app.user.keyboard("{Enter}");
    await naming("Untitled folder");
    expect(await exists("Untitled folder")).toBe(true);
  });

  it("works in an empty Private Space, where the tree has no rows yet", async () => {
    root = await dirs.dir();
    const app = await openApp(root);
    await app.user.click(await screen.findByRole("button", { name: /start writing/i })); // a new, empty folder
    await screen.findByText("No pages yet.");
    await app.user.click(await screen.findByRole("button", { name: "New folder" }));
    await naming("Untitled folder");
    expect(await exists("Untitled folder")).toBe(true);
    expect(screen.queryByText("No pages yet.")).toBeNull();
  });
});

describe("in Thai", () => {
  it("names the default folder, numbers it, and shows the menus and messages in Thai", async () => {
    localStorage.setItem("thoth.desktop.lang", "th");
    const app = await openApp(root);
    const tree = await screen.findByRole("tree", { name: th.shell.pagesInSpace });
    await within(tree).findByRole("treeitem", { name: "Docs" });
    await app.user.click(screen.getByRole("button", { name: th.shell.newFolder }));
    await screen.findByRole("textbox", { name: sharedTh.tree.renameLabel(th.shell.untitledFolder) });
    expect(await exists(th.shell.untitledFolder)).toBe(true);
    await app.user.keyboard("{Escape}");
    await app.user.click(screen.getByRole("button", { name: th.shell.newFolder }));
    const second = await screen.findByRole("textbox", { name: sharedTh.tree.renameLabel(`${th.shell.untitledFolder} 2`) });
    expect(await exists(`${th.shell.untitledFolder} 2`)).toBe(true);
    // A refused name is explained in Thai.
    await app.user.clear(second);
    await app.user.type(second, "a:b{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe(sharedTh.tree.nameProblem.invalid);
    await app.user.keyboard("{Escape}");

    fireEvent.contextMenu(within(tree).getByRole("treeitem", { name: "Docs" }));
    const menu = await screen.findByRole("menu", { name: sharedTh.tree.menuLabel("Docs") });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([`${sharedTh.tree.rename}F2`, sharedTh.tree.newFolderInside, `${sharedTh.tree.moveUp}⌥⇧↑`, `${sharedTh.tree.moveDown}⌥⇧↓`, sharedTh.tree.moveTo]);
  });
});
