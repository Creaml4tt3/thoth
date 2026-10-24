// @vitest-environment jsdom
// The command palette and the shortcuts list in the web client (ADR-0016 rule 7, Phase 3b AC 6): the same commands as the
// desktop app, with other keys where the browser keeps the desktop's.
import { afterEach, describe, expect, it } from "vitest";
import { FakeWebServer } from "./support/fake-web-server.ts";
import { cleanup, editorBox, fakeBrowser, screen, signInThroughUi, waitFor, within, type FakeBrowser } from "./support/render.tsx";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);
const current = () => screen.queryAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const row = (name: string) => screen.findByRole("treeitem", { name });
const treeRows = () => screen.getAllByRole("treeitem").map((r) => r.textContent?.replace(/Workspace$/, ""));

async function signedIn(options: { titles?: string[]; server?: FakeWebServer } = {}) {
  const server = options.server ?? new FakeWebServer();
  const ws = server.workspace("Notes");
  for (const title of options.titles ?? ["Alpha", "Beta", "Gamma"]) server.servers.writeAsOther(ws, { title, markdown: `# ${title}\n\nBody of ${title}.\n` });
  const browser = fakeBrowser(server);
  await signInThroughUi(browser);
  return Object.assign(browser, { ws });
}

async function palette(browser: FakeBrowser, what = "") {
  await browser.user.keyboard("{Control>}k{/Control}");
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  if (what) await browser.user.keyboard(`> ${what}`);
  return dialog;
}
const options = (dialog: HTMLElement) => within(dialog).queryAllByRole("option").map((o) => o.textContent);
async function run(browser: FakeBrowser, what: string) {
  await palette(browser, what);
  await browser.user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
}

describe("commands", () => {
  it("lists them for >, with the web client's own keys", async () => {
    const browser = await signedIn();
    await browser.user.click(await row("Alpha"));
    const dialog = await palette(browser);
    await browser.user.keyboard(">");
    const text = (name: RegExp) => within(dialog).getByRole("option", { name }).textContent;
    expect(text(/^New page/)).toContain("Alt+N");
    expect(text(/^New tab/)).toContain("Alt+T");
    expect(text(/^Close tab/)).toContain("Alt+W");
    expect(text(/^Open Settings/)).toContain("Alt+,");
    expect(text(/^Move page up/)).toContain("Alt+Shift+↑");
    expect(text(/^Show keyboard shortcuts/)).toContain("Ctrl+/");
    // None of the browser's keys is offered.
    for (const o of options(dialog)) expect(o).not.toMatch(/Ctrl\+(T|W|N|Tab|[1-9])\b/);
  });

  it("opens even when the server cannot search, and then lists commands only", async () => {
    const server = new FakeWebServer({ capabilities: ["page-order"] });
    const browser = await signedIn({ server });
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
    const dialog = await palette(browser);
    expect(within(dialog).getByText(/Type > to run a command/)).toBeTruthy();
    await browser.user.keyboard("theme dark");
    expect(within(dialog).queryAllByRole("option")).toHaveLength(0);
    await browser.user.clear(within(dialog).getByRole("combobox"));
    await browser.user.keyboard("> theme dark{Enter}");
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("night"));
  });

  it("changes the theme, remembered under the one theme key", async () => {
    const browser = await signedIn();
    await run(browser, "theme dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("night");
    expect(browser.local.get("thoth.theme")).toBe("dark");
    await run(browser, "theme light");
    expect(browser.local.get("thoth.theme")).toBe("light");
    await browser.user.keyboard("{Control>}{Shift>}l{/Shift}{/Control}");
    expect(document.documentElement.getAttribute("data-theme")).toBe("night");
  });

  it("opens Settings as a tab", async () => {
    const browser = await signedIn();
    await browser.user.click(await row("Alpha"));
    await run(browser, "settings");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Settings"]));
    const panel = screen.getByRole("tabpanel");
    await browser.user.click(within(panel).getByRole("button", { name: "Show keyboard shortcuts" }));
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });

  it("New page creates a page in the workspace and opens it; Alt+N does the same", async () => {
    const browser = await signedIn({ titles: ["Alpha"] });
    await browser.user.click(await row("Alpha"));
    await run(browser, "new page");
    await waitFor(() => expect(current()).toBe("Untitled"));
    expect([...browser.ws.pages.values()].map((p) => p.title).sort()).toEqual(["Alpha", "Untitled"]);
    await editorBox();
    await browser.user.keyboard("{Alt>}n{/Alt}");
    await waitFor(() => expect([...browser.ws.pages.values()]).toHaveLength(3));
  });

  it("New folder creates a folder page and asks for its name at once", async () => {
    const browser = await signedIn({ titles: ["Alpha"] });
    await run(browser, "new folder");
    const dialog = await screen.findByRole("dialog", { name: "Rename “New folder”" });
    const field = within(dialog).getByRole("textbox", { name: "New name" });
    await browser.user.clear(field);
    await browser.user.type(field, "Projects{Enter}");
    await waitFor(() => expect([...browser.ws.pages.values()].map((p) => p.title).sort()).toEqual(["Alpha", "Projects"]));
    expect(await screen.findByRole("treeitem", { name: /^Projects/ })).toBeTruthy();
  });

  it("Rename page renames the open page on the server, and the tab follows", async () => {
    const browser = await signedIn();
    await browser.user.click(await row("Beta"));
    await waitFor(() => expect(current()).toBe("Beta"));
    await run(browser, "rename");
    const dialog = await screen.findByRole("dialog", { name: "Rename “Beta”" });
    const field = within(dialog).getByRole("textbox", { name: "New name" });
    await browser.user.clear(field);
    await browser.user.type(field, "Delta{Enter}");
    await waitFor(() => expect(current()).toBe("Delta"));
    expect(browser.server.servers.page(browser.ws, "Delta").markdown).toContain("# Delta");
  });

  it("Move to… and Move page up/down act on the open page", async () => {
    const browser = await signedIn();
    await browser.user.click(await row("Gamma"));
    await waitFor(() => expect(current()).toBe("Gamma"));
    await run(browser, "move page up");
    await waitFor(() => expect(treeRows().filter((r) => ["Alpha", "Beta", "Gamma"].includes(r ?? ""))).toEqual(["Alpha", "Gamma", "Beta"]));
    await run(browser, "move page down");
    await waitFor(() => expect(treeRows().filter((r) => ["Alpha", "Beta", "Gamma"].includes(r ?? ""))).toEqual(["Alpha", "Beta", "Gamma"]));
    await run(browser, "move to");
    const dialog = await screen.findByRole("dialog", { name: "Move “Gamma” to…" });
    const list = within(dialog).getByRole("listbox");
    await browser.user.selectOptions(list, within(list).getByRole("option", { name: /Alpha/ }));
    await browser.user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(browser.server.servers.page(browser.ws, "Gamma").parentId).toBe(browser.server.servers.page(browser.ws, "Alpha").id));
  });

  it("tab commands work, and Go to tab lists the other tabs by name", async () => {
    const browser = await signedIn();
    await browser.user.click(await row("Alpha"));
    await browser.user.keyboard("{Control>}");
    await browser.user.click(await row("Beta"));
    await browser.user.keyboard("{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));
    const dialog = await palette(browser, "go to tab");
    expect(options(dialog)).toEqual(["Go to tab: Alpha"]);
    await browser.user.keyboard("{Enter}");
    await waitFor(() => expect(current()).toBe("Alpha"));
    await run(browser, "close tab");
    await waitFor(() => expect(tabNames()).toEqual(["Beta"]));
  });
});

describe("text styles on the web", () => {
  /** The part of the Tiptap editor these tests use (the web package does not depend on Tiptap itself). */
  interface Editor {
    state: { doc: { descendants(visit: (node: { isTextblock: boolean; textContent: string }, pos: number) => void): void } };
    view: { focus(): void };
    commands: { setTextSelection(range: { from: number; to: number }): boolean };
    getHTML(): string;
  }
  type Box = HTMLElement & { editor?: Editor };
  /** Selects `text` inside one text block, with focus in the editor (what a drag or Shift+Arrow leaves behind). */
  function select(editor: Editor, text: string): void {
    let from = -1;
    editor.state.doc.descendants((node, pos) => {
      if (from >= 0 || !node.isTextblock) return;
      const i = node.textContent.indexOf(text);
      if (i >= 0) from = pos + 1 + i;
    });
    editor.view.focus();
    editor.commands.setTextSelection({ from, to: from + text.length });
  }
  const markdown = (browser: Awaited<ReturnType<typeof signedIn>>) => browser.server.servers.page(browser.ws, "Alpha").markdown;

  it("binds strikethrough and the link field to Ctrl+Alt+S and Ctrl+Alt+L, not to Firefox's Ctrl+Shift+S and Ctrl+Shift+K", async () => {
    const browser = await signedIn({ titles: ["Alpha"] });
    await browser.user.click(await row("Alpha"));
    const box = (await editorBox()) as Box;
    await waitFor(() => expect(box.textContent).toContain("Body of Alpha."));
    const editor = box.editor!;

    select(editor, "Body");
    await browser.user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");
    await browser.user.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
    expect(editor.getHTML()).not.toContain("<s>");
    expect(screen.queryByRole("textbox", { name: "Link address" })).toBeNull();

    await browser.user.keyboard("{Control>}{Alt>}s{/Alt}{/Control}");
    expect(editor.getHTML()).toContain("<s>Body</s>");
    await browser.user.keyboard("{Control>}{Alt>}l{/Alt}{/Control}");
    expect(await screen.findByRole("textbox", { name: "Link address" })).toBeTruthy();
    await browser.user.keyboard("{Escape}");

    // The shared keys are the same as on the desktop.
    select(editor, "of Alpha");
    await browser.user.keyboard("{Control>}{Shift>}h{/Shift}{/Control}");
    await browser.user.keyboard("{Control>}b{/Control}");
    await browser.user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(markdown(browser)).toContain("~~Body~~ ==**of Alpha**=="));
  });

  it("shows the web keys in the toolbar's tooltips", async () => {
    const browser = await signedIn({ titles: ["Alpha"] });
    await browser.user.click(await row("Alpha"));
    const box = (await editorBox()) as Box;
    await waitFor(() => expect(box.textContent).toContain("Body of Alpha."));
    select(box.editor!, "Body");
    const toolbar = await screen.findByRole("toolbar", { name: "Text formatting" });
    expect(within(toolbar).getByRole("button", { name: "Strikethrough" }).getAttribute("title")).toBe("Strikethrough (Ctrl/Cmd+Alt+S)");
    expect(within(toolbar).getByRole("button", { name: "Link" }).getAttribute("title")).toBe("Link (Ctrl/Cmd+Alt+L)");
    expect(within(toolbar).getByRole("button", { name: "Bold" }).getAttribute("title")).toBe("Bold (Ctrl/Cmd+B)");
  });

  it("offers the style commands in the palette when text is selected", async () => {
    const browser = await signedIn({ titles: ["Alpha"] });
    await browser.user.click(await row("Alpha"));
    const box = (await editorBox()) as Box;
    await waitFor(() => expect(box.textContent).toContain("Body of Alpha."));
    select(box.editor!, "Body");
    await run(browser, "format italic");
    await browser.user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(markdown(browser)).toContain("*Body* of Alpha."));
  });
});

describe("the shortcuts list on the web", () => {
  it("shows the web keys, marks the ones that differ and says what the desktop uses; Ctrl+/ opens and closes it", async () => {
    const browser = await signedIn();
    await browser.user.keyboard("{Control>}/{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const rowOf = (id: string) => dialog.querySelector<HTMLElement>(`[data-shortcut="${id}"]`)!;
    expect(rowOf("tab.close").textContent).toContain("Alt+W");
    expect(rowOf("tab.close").textContent).toContain("Desktop app: Ctrl+W");
    expect(rowOf("tab.close").hasAttribute("data-differs")).toBe(true);
    expect(rowOf("tab.jump").textContent).toContain("Alt+1–9");
    expect(rowOf("style.strike").textContent).toContain("Ctrl+Alt+S");
    expect(rowOf("style.strike").textContent).toContain("Desktop app: Ctrl+Shift+S");
    expect(rowOf("style.link").textContent).toContain("Ctrl+Alt+L");
    expect(rowOf("page.new").textContent).toContain("Alt+N");
    expect(rowOf("tree.rename").hasAttribute("data-differs")).toBe(false);
    expect(rowOf("style.bold").hasAttribute("data-differs")).toBe(false);
    expect(within(dialog).getByText(/Browsers keep some keys/)).toBeTruthy();
    await browser.user.keyboard("{Control>}/{/Control}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
