// @vitest-environment jsdom
// The command palette (Cmd/Ctrl+K, then `>`) and the shortcuts list (Cmd/Ctrl+/), ADR-0016 rule 7, Phase 3b AC 6.
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, editorBox, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";
import { setDefaultEditorMode } from "@thoth/app-ui/editor/mode.ts";
import { setLangPreference } from "../src/strings/index.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA, "Docs/Notes.md": "# Notes\n\nNotes body.\n", "Gamma.md": "# Gamma\n\nThe third page.\n" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  setDefaultEditorMode("blocks");
  setLangPreference("system");
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  cleanup();
  await dirs.cleanup();
});

const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);
const current = () => screen.queryAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const tree = async () => screen.findByRole("tree", { name: "Pages in this Private Space" });
const row = async (name: string) => within(await tree()).getByRole("treeitem", { name });
const rows = async () => within(await tree()).getAllByRole("treeitem").map((r) => r.textContent);

/** Opens the app on Alpha (the first page opens by itself). */
async function start(): Promise<Harness> {
  const app = await openApp(root);
  await waitFor(() => expect(current()).toBe("Alpha"));
  await editorBox();
  return app;
}

/** Cmd/Ctrl+K, then `> <what>`; returns the palette. */
async function palette(app: Harness, what = "") {
  await app.user.keyboard("{Control>}k{/Control}");
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  if (what) await app.user.keyboard(`> ${what}`);
  return dialog;
}
const options = (dialog: HTMLElement) => within(dialog).queryAllByRole("option").map((o) => o.textContent);

/** Types the command and runs the first match. */
async function run(app: Harness, what: string) {
  await palette(app, what);
  await app.user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
}

describe("the palette", () => {
  it("says how to reach commands, and lists them for a bare >", async () => {
    const app = await start();
    const dialog = await palette(app);
    expect(within(dialog).getByText(/Type > to run a command/)).toBeTruthy();
    await app.user.keyboard(">");
    const names = options(dialog);
    expect(names.length).toBeGreaterThan(10);
    for (const name of ["New page", "Rename page", "Move to…", "Move page up", "Move page down", "Change theme: Light", "Change theme: Dark", "Change theme: System", "Open Settings", "New tab", "Close tab", "Show keyboard shortcuts"]) {
      expect(names.some((n) => n?.startsWith(name)), name).toBe(true);
    }
    expect(within(dialog).getByRole("option", { name: /^New page/ }).textContent).toContain("Ctrl+N");
  });

  it("searches pages as before when the text does not start with >", async () => {
    const app = await start();
    const dialog = await palette(app);
    await app.user.keyboard("third page");
    expect(await within(dialog).findByRole("option", { name: /Gamma/ })).toBeTruthy();
    expect(within(dialog).queryByRole("option", { name: /Open Settings/ })).toBeNull();
  });

  it("filters while typing, moves with the arrow keys, runs with Enter and closes", async () => {
    const app = await start();
    const dialog = await palette(app, "theme");
    expect(options(dialog)).toEqual(["Change theme: Light", "Change theme: Dark", "Change theme: System"]);
    const input = within(dialog).getByRole("combobox");
    expect(input.getAttribute("aria-activedescendant")).toBe(within(dialog).getAllByRole("option")[0]!.id);
    await app.user.keyboard("{ArrowDown}");
    expect(within(dialog).getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    await app.user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}");
    expect(within(dialog).getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    expect(document.documentElement.getAttribute("data-theme")).toBe("night");
  });

  it("runs a command with a click too, and Escape closes without running anything", async () => {
    const app = await start();
    const first = await palette(app, "theme light");
    await app.user.click(within(first).getByRole("option", { name: /Change theme: Light/ }));
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
    await palette(app, "theme dark");
    await app.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("says when no command matches, and Enter then does nothing", async () => {
    const app = await start();
    const dialog = await palette(app, "zzzz");
    expect(within(dialog).getByText("No command matches.")).toBeTruthy();
    await app.user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeNull();
  });

  it("toggles with Cmd/Ctrl+K", async () => {
    const app = await start();
    await palette(app);
    await app.user.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("commands", () => {
  it("New page creates Untitled, opens it and starts the rename in the tree", async () => {
    const app = await start();
    await run(app, "new page");
    await screen.findByRole("textbox", { name: "Rename Untitled" });
    await app.user.keyboard("Made by command{Enter}");
    await waitFor(async () => expect(await app.read("Made by command.md")).toMatch(/^---\nthoth_id: .+\n---\n# Made by command\n$/));
    await waitFor(() => expect(current()).toBe("Made by command"));
  });

  it("Change theme sets Dark, Light and System, and remembers it with the other preferences", async () => {
    const app = await start();
    await run(app, "theme dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("night");
    expect(localStorage.getItem("thoth.desktop.theme")).toBe("dark");
    await run(app, "theme light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await run(app, "theme system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("system");
    expect(localStorage.getItem("thoth.desktop.theme")).toBe("system");
  });

  it("Cmd/Ctrl+Shift+L cycles the theme", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}{Shift>}l{/Shift}{/Control}");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await app.user.keyboard("{Control>}{Shift>}l{/Shift}{/Control}");
    expect(document.documentElement.getAttribute("data-theme")).toBe("night");
  });

  it("Open Settings opens a Settings tab, and Cmd/Ctrl+, does the same", async () => {
    const app = await start();
    await run(app, "settings");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Settings"]));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(within(screen.getByRole("tabpanel")).getByRole("combobox", { name: "Theme" })).toBeTruthy();
    await app.user.keyboard("{Control>}1{/Control}");
    await waitFor(() => expect(current()).toBe("Alpha"));
    await app.user.keyboard("{Control>}[Comma]{/Control}");
    await waitFor(() => expect(current()).toBe("Settings"));
    expect(tabNames()).toEqual(["Alpha", "Settings"]);
  });

  it("New tab, Close tab, Next and Previous tab, and Go to tab: <name>", async () => {
    const app = await start();
    await run(app, "new tab");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "New tab"]));
    await run(app, "previous tab");
    await waitFor(() => expect(current()).toBe("Alpha"));
    await run(app, "next tab");
    await waitFor(() => expect(current()).toBe("New tab"));
    await run(app, "go to tab alpha");
    await waitFor(() => expect(current()).toBe("Alpha"));
    // The tab that is open is not offered as a place to go.
    const dialog = await palette(app, "go to tab");
    expect(options(dialog)).toEqual(["Go to tab: New tab"]);
    await app.user.keyboard("{Escape}");
    await run(app, "close tab");
    await waitFor(() => expect(tabNames()).toEqual(["New tab"]));
  });

  it("Rename page renames the file, keeps its links working, and the tab and tree show the new name", async () => {
    const app = await start();
    await app.user.click(await row("Beta"));
    await waitFor(() => expect(current()).toBe("Beta"));
    await run(app, "rename");
    const dialog = await screen.findByRole("dialog", { name: "Rename “Beta”" });
    const field = within(dialog).getByRole("textbox", { name: "New name" }) as HTMLInputElement;
    expect(field.value).toBe("Beta");
    await app.user.clear(field);
    await app.user.type(field, "Delta{Enter}");
    // The heading was the old name, so it follows the new one (as F2 does).
    await waitFor(async () => expect(await app.read("Delta.md")).toBe(BETA.replace("# Beta", "# Delta")));
    await expect(app.read("Beta.md")).rejects.toThrow();
    // The link in Alpha follows the file.
    await waitFor(async () => expect(await app.read("Alpha.md")).toContain("[[Delta]]"));
    await waitFor(() => expect(tabNames()).toEqual(["Delta"]));
    await waitFor(async () => expect(await rows()).toContain("Delta"));
    expect(await rows()).not.toContain("Beta");
    // No order file just because of a rename.
    await expect(app.read(".thoth/order.json")).rejects.toThrow();
  });

  it("Rename page refuses a name that is taken or has a slash, and leaves everything as it was", async () => {
    const app = await start();
    await run(app, "rename");
    const dialog = await screen.findByRole("dialog", { name: "Rename “Alpha”" });
    const field = within(dialog).getByRole("textbox", { name: "New name" });
    await app.user.clear(field);
    await app.user.type(field, "Beta{Enter}");
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/already there/);
    await app.user.clear(field);
    await app.user.type(field, "a/b{Enter}");
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toMatch(/cannot contain/));
    expect(await app.read("Alpha.md")).toBe(ALPHA);
    await app.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tabNames()).toEqual(["Alpha"]);
  });

  it("Move to… opens the destination dialog for the open page, and the file moves", async () => {
    const app = await start();
    await app.user.click(await row("Gamma"));
    await waitFor(() => expect(current()).toBe("Gamma"));
    await run(app, "move to");
    const dialog = await screen.findByRole("dialog", { name: "Move “Gamma” to…" });
    const list = within(dialog).getByRole("listbox");
    await app.user.selectOptions(list, within(list).getByRole("option", { name: /Docs/ }));
    await app.user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(async () => expect(await app.read("Docs/Gamma.md")).toBe("# Gamma\n\nThe third page.\n"));
    await expect(app.read("Gamma.md")).rejects.toThrow();
    await waitFor(() => expect(current()).toBe("Gamma"));
  });

  it("Move page up and down reorder the open page among its siblings, like Alt+Shift+Arrow", async () => {
    const app = await start();
    await app.user.click(await row("Beta"));
    await waitFor(() => expect(current()).toBe("Beta"));
    expect(await rows()).toEqual(["Docs", "Alpha", "Beta", "Gamma"]);
    await run(app, "move page up");
    await waitFor(async () => expect(await rows()).toEqual(["Docs", "Beta", "Alpha", "Gamma"]));
    expect(JSON.parse(await app.read(".thoth/order.json"))).toMatchObject({ folders: { "": ["Docs", "Beta.md", "Alpha.md", "Gamma.md"] } });
    await run(app, "move page down");
    await waitFor(async () => expect(await rows()).toEqual(["Docs", "Alpha", "Beta", "Gamma"]));
  });

  it("Switch between Blocks and Plain mode flips the mode of the open page", async () => {
    const app = await start();
    const mode = (name: string) => screen.getByRole("button", { name });
    expect(mode("Blocks").getAttribute("aria-pressed")).toBe("true");
    await run(app, "plain");
    await waitFor(() => expect(mode("Plain").getAttribute("aria-pressed")).toBe("true"));
    await run(app, "blocks");
    await waitFor(() => expect(mode("Blocks").getAttribute("aria-pressed")).toBe("true"));
  });

  it("offers no page commands, mode or formatting when no page is open", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}t{/Control}");
    await waitFor(() => expect(current()).toBe("New tab"));
    const dialog = await palette(app);
    await app.user.keyboard(">");
    const names = options(dialog);
    const has = (name: string) => names.some((n) => n?.startsWith(name));
    for (const gone of ["Rename page", "Move to…", "Move page up", "Switch between Blocks and Plain mode", "Format: Bold"]) expect(has(gone), gone).toBe(false);
    expect(has("New page")).toBe(true);
    expect(has("Go to tab: Alpha")).toBe(true);
  });
});

describe("format commands", () => {
  type Box = HTMLElement & { editor?: Editor };
  function select(editor: Editor, text: string): void {
    let from = -1;
    editor.state.doc.descendants((node, pos) => {
      if (from >= 0 || !node.isTextblock) return;
      const i = node.textContent.indexOf(text);
      if (i >= 0) from = pos + 1 + i;
    });
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, from + text.length)));
  }

  it("are offered only with text selected, and style the selection, saved as Markdown", async () => {
    const app = await start();
    const box = (await editorBox()) as Box;
    await waitFor(() => expect(box.textContent).toContain("First paragraph stays exactly."));
    const editor = box.editor!;
    // A caret: no style commands.
    const dialog = await palette(app);
    await app.user.keyboard(">");
    expect(options(dialog).some((n) => n?.startsWith("Format:"))).toBe(false);
    await app.user.keyboard("{Escape}");

    select(editor, "stays exactly");
    await run(app, "format bold");
    await app.user.keyboard("{Control>}s{/Control}");
    await waitFor(async () => expect(await app.read("Alpha.md")).toContain("First paragraph **stays exactly**."));

    select(editor, "paragraph");
    await run(app, "format highlight");
    select(editor, "Second");
    await run(app, "colour red");
    await app.user.keyboard("{Control>}s{/Control}");
    const saved = await waitFor(async () => {
      const text = await app.read("Alpha.md");
      expect(text).toContain("First ==paragraph== **stays exactly**.");
      return text;
    });
    expect(saved).toContain('<span data-color="red">Second</span> paragraph with');
    // Blocks that were not styled keep their exact bytes.
    for (const untouched of ["* odd bullet one\n* odd bullet two\n", "> [!tip] Remember\n> Callouts round-trip.\n", "```js\nconst  spaced   =  1;\n```\n"]) expect(saved).toContain(untouched);
  });

  it("Link opens the link field", async () => {
    const app = await start();
    const box = (await editorBox()) as Box;
    await waitFor(() => expect(box.textContent).toContain("First paragraph stays exactly."));
    select(box.editor!, "stays exactly");
    await run(app, "format link");
    expect(await screen.findByRole("textbox", { name: "Link address" })).toBeTruthy();
  });
});

describe("the shortcuts list", () => {
  it("opens with Cmd/Ctrl+/ and from the palette, lists the table's shortcuts, and closes with Escape or Cmd/Ctrl+/", async () => {
    const app = await start();
    await app.user.keyboard("{Control>}/{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const rowOf = (id: string) => dialog.querySelector<HTMLElement>(`[data-shortcut="${id}"]`)!;
    expect(rowOf("tab.close").textContent).toContain("Ctrl+W");
    expect(rowOf("tab.next").textContent).toContain("Ctrl+Tab");
    expect(rowOf("tab.jump").textContent).toContain("Ctrl+1–9");
    expect(rowOf("tree.rename").textContent).toContain("F2");
    expect(rowOf("tree.reorder").textContent).toContain("Alt+Shift+↑ / ↓");
    expect(rowOf("style.highlight").textContent).toContain("Ctrl+Shift+H");
    expect(rowOf("style.strike").textContent).toContain("Ctrl+Shift+S");
    expect(rowOf("editor.mode").textContent).toContain("Ctrl+Shift+E");
    expect(within(dialog).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Everywhere", "Thoth assistant", "Tabs", "Page tree", "Editor"]);
    // Where the web has other keys, the desktop list says so.
    expect(rowOf("tab.close").textContent).toContain("Web: Alt+W");
    expect(rowOf("style.strike").textContent).toContain("Web: Ctrl+Alt+S");
    expect(rowOf("tree.rename").textContent).not.toContain("Web:");
    await app.user.keyboard("{Control>}/{/Control}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await run(app, "shortcuts");
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await app.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is generated from the table: every shortcut in the table is in the list", async () => {
    const { SHORTCUTS } = await import("@thoth/app-ui/keyboard/shortcuts.ts");
    const app = await start();
    await app.user.keyboard("{Control>}/{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const ids = [...dialog.querySelectorAll<HTMLElement>("[data-shortcut]")].map((r) => r.dataset["shortcut"]);
    expect(ids.sort()).toEqual(SHORTCUTS.map((s) => s.id).sort());
  });
});

describe("in Thai", () => {
  it("has the palette, the commands and the list in Thai", async () => {
    setLangPreference("th");
    const app = await openApp(root);
    await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(1));
    await app.user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "ค้นหา" });
    await app.user.keyboard("> ธีม");
    expect(options(dialog)).toEqual(["เปลี่ยนธีม: สว่าง", "เปลี่ยนธีม: มืด", "เปลี่ยนธีม: ตามระบบ"]);
    await app.user.keyboard("{Escape}");
    await app.user.keyboard("{Control>}/{/Control}");
    expect(await screen.findByRole("dialog", { name: "ปุ่มลัด" })).toBeTruthy();
  });
});
