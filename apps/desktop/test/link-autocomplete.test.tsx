// @vitest-environment jsdom
/**
 * `[[` autocomplete in both editor modes, end to end through the app: the menu
 * lists vault pages, keyboard picking inserts a link that resolves, Escape
 * dismisses, and the saved Markdown is exactly `[[Target]]` with every other
 * byte unchanged.
 *
 * jsdom cannot generate text input for contenteditable, so typing goes through
 * the editors' own input paths: ProseMirror's `handleTextInput` props (what a
 * keypress triggers) and CodeMirror user-input transactions.
 */
import { EditorView as CodeMirrorView } from "@codemirror/view";
import type { EditorView as ProseMirrorView } from "@tiptap/pm/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caretAtEnd, cleanup, editorBox, openApp, paragraph, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";
import { guardWrites } from "./support/write-guard.ts";
import { setDefaultEditorMode } from "@thoth/app-ui/editor/mode.ts";
import { axeViolations } from "../../../tests/helpers/axe.ts";
import { FakeServers } from "../../../tests/helpers/fake-servers.ts";
import { createNodePlatform } from "./support/node-platform.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, {
    "Alpha.md": ALPHA,
    "Beta.md": BETA,
    "Projects/Roadmap.md": "# Roadmap\n",
    // Titles come from frontmatter `title`, else the file name (the index's rule).
    "Work/Notes.md": "---\ntitle: Work notes\n---\n",
    "Home/Notes.md": "---\ntitle: Home notes\n---\n",
    "Sync.md": "---\ntitle: Weekly sync\naliases: [standup]\n---\n",
  });
});
afterEach(async () => {
  vi.restoreAllMocks(); // guardWrites spies on Vault.prototype; stacked spies would leak between tests
  setDefaultEditorMode("blocks");
  localStorage.clear();
  cleanup();
  await dirs.cleanup();
});

const menu = () => screen.queryByRole("listbox", { name: "Link to page" });
const options = () => within(menu()!).getAllByRole("option").map((o) => o.querySelector(".link-option-title")!.textContent);

async function openAlpha() {
  const app = await openApp(root);
  await app.user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: "Alpha" }));
  const box = await editorBox();
  await waitFor(() => expect(box.textContent).toContain("First paragraph stays exactly."));
  return { app, box };
}

/** Types into ProseMirror the way a keypress does: handleTextInput props first, plain insertion otherwise. */
function typeBlocks(box: HTMLElement, text: string): void {
  // Tiptap keeps its editor on the ProseMirror root element.
  const view = (box as unknown as { editor?: { view: ProseMirrorView } }).editor?.view;
  if (!view) throw new Error("No ProseMirror view");
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

describe("[[ autocomplete in Blocks mode", () => {
  it("lists pages, picks with the keyboard, and saves a resolving [[link]] with nothing else changed", async () => {
    const guard = guardWrites();
    const { app, box } = await openAlpha();
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    typeBlocks(box, " [[");
    await waitFor(() => expect(menu()).not.toBeNull());
    typeBlocks(box, "note");
    await waitFor(() => expect(options()).toEqual(["Home notes", "Work notes"]));
    await app.user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(menu()?.hidden ?? true).toBe(true));
    expect(box.querySelector('.wikilink[data-target="Work/Notes.md"]')?.textContent).toBe("Work/Notes");

    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(async () => expect(await app.read("Alpha.md")).toBe(ALPHA.replace("First paragraph stays exactly.", "First paragraph stays exactly. [[Work/Notes]]")));
    expect(guard.stale()).toEqual([]);
  });

  it("finds pages by alias and Escape dismisses the menu without changing the text", async () => {
    const { app, box } = await openAlpha();
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    typeBlocks(box, " [[stand");
    await waitFor(() => expect(options()).toEqual(["Weekly sync"]));
    expect(within(menu()!).getByText(/alias “standup”/)).toBeTruthy();
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(menu()?.hidden ?? true).toBe(true));
    expect(box.textContent).toContain("First paragraph stays exactly. [[stand");
    typeBlocks(box, "u");
    expect(menu()?.hidden ?? true).toBe(true); // stays dismissed for this [[
  });

  it("a link typed by hand with ]] becomes a real link, saved unescaped", async () => {
    const { app, box } = await openAlpha();
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    typeBlocks(box, " [[Beta]]");
    await waitFor(() => expect(box.querySelector('.wikilink[data-target="Beta.md"]')).not.toBeNull());
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(async () => expect(await app.read("Alpha.md")).toBe(ALPHA.replace("First paragraph stays exactly.", "First paragraph stays exactly. [[Beta]]")));
  });
});

describe("[[ autocomplete in Plain mode", () => {
  async function plain() {
    setDefaultEditorMode("plain");
    const { app, box } = await openAlpha();
    const view = CodeMirrorView.findFromDOM(box.closest(".cm-editor") as HTMLElement)!;
    view.focus();
    const end = view.state.doc.toString().indexOf("First paragraph stays exactly.") + "First paragraph stays exactly.".length;
    view.dispatch({ selection: { anchor: end } });
    const type = (text: string) => {
      for (const ch of text) view.dispatch(view.state.replaceSelection(ch), { userEvent: "input.type" });
    };
    return { app, view, type };
  }

  it("completes [[ro to [[Roadmap]] as one undoable edit and saves exactly that", async () => {
    const guard = guardWrites();
    const { app, view, type } = await plain();
    type(" [[ro");
    await waitFor(() => expect(options()).toEqual(["Roadmap"]));
    await app.user.keyboard("{Enter}");
    expect(view.state.doc.toString()).toContain("First paragraph stays exactly. [[Roadmap]]\n");
    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf("[[Roadmap]]") + "[[Roadmap]]".length);
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(async () => expect(await app.read("Alpha.md")).toBe(ALPHA.replace("First paragraph stays exactly.", "First paragraph stays exactly. [[Roadmap]]")));
    expect(guard.stale()).toEqual([]);
  });

  it("arrow keys move through the list; Escape closes it and Enter then makes a new line", async () => {
    const { app, view, type } = await plain();
    type(" [[notes");
    await waitFor(() => expect(options()).toEqual(["Home notes", "Work notes"]));
    await app.user.keyboard("{ArrowDown}");
    expect(within(menu()!).getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(menu()?.hidden ?? true).toBe(true));
    await app.user.keyboard("{Enter}");
    expect(view.state.doc.toString()).toContain("First paragraph stays exactly. [[notes\n");
  });
});

describe("@ in both modes (ADR-0049)", () => {
  const atMenu = () => screen.queryByRole("listbox", { name: "Link to a page or folder" });
  const atOptions = () => within(atMenu()!).getAllByRole("option").map((o) => o.querySelector(".link-option-title")!.textContent);

  it("Blocks: lists pages and folders, inserts a folder chip and saves [[Folder/]]; the listbox pattern holds", async () => {
    const { app, box } = await openAlpha();
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    typeBlocks(box, " @proj");
    await waitFor(() => expect(atOptions()).toEqual(["Projects", "Roadmap"]));
    expect(within(atMenu()!).getAllByRole("option")[0]!.textContent).toContain("Folder");
    // The editor points at the open listbox and its highlighted option.
    expect(box.getAttribute("aria-controls")).toBe(atMenu()!.id);
    expect(box.getAttribute("aria-activedescendant")).toBe(within(atMenu()!).getAllByRole("option")[0]!.id);
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(atMenu()?.hidden ?? true).toBe(true));
    expect(box.querySelector('.wikilink[data-kind="folder"][data-target="Projects/"]')).not.toBeNull();
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(async () => expect(await app.read("Alpha.md")).toBe(ALPHA.replace("First paragraph stays exactly.", "First paragraph stays exactly. [[Projects/]]")));
  });

  it("Blocks: no menu inside an email address; Escape closes; a space with no match closes", async () => {
    const { app, box } = await openAlpha();
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    typeBlocks(box, " mail@beta");
    expect(atMenu()?.hidden ?? true).toBe(true);
    typeBlocks(box, " @be");
    await waitFor(() => expect(atOptions()).toEqual(["Beta"]));
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(atMenu()?.hidden ?? true).toBe(true));
    typeBlocks(box, " @zz");
    await waitFor(() => expect(atMenu()?.hidden).toBe(false));
    typeBlocks(box, " q");
    await waitFor(() => expect(atMenu()?.hidden ?? true).toBe(true));
  });

  it("Plain: picks a page with Tab and writes [[Name]]", async () => {
    setDefaultEditorMode("plain");
    const { app, box } = await openAlpha();
    const view = CodeMirrorView.findFromDOM(box.closest(".cm-editor") as HTMLElement)!;
    view.focus();
    const end = view.state.doc.toString().indexOf("First paragraph stays exactly.") + "First paragraph stays exactly.".length;
    view.dispatch({ selection: { anchor: end } });
    for (const ch of " @roa") view.dispatch(view.state.replaceSelection(ch), { userEvent: "input.type" });
    await waitFor(() => expect(atOptions()).toEqual(["Roadmap"]));
    await app.user.keyboard("{Tab}");
    expect(view.state.doc.toString()).toContain("First paragraph stays exactly. [[Roadmap]]\n");
  });
});

describe("@ in a workspace page (ADR-0049)", () => {
  const GONE = "01890000-0000-7000-8000-000000000099";

  async function openPlan() {
    const servers = new FakeServers();
    const server = servers.connect({ url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" }, capabilities: ["page-order", "page-kind", "members"] });
    const ws = servers.addWorkspace(server, {
      name: "Design",
      role: "editor",
      members: [
        { userId: "usr_me", displayName: "Ada", role: "editor" },
        { userId: "usr_rosa", displayName: "Rosa Diaz", role: "manager" },
      ],
    });
    // A page the reader cannot see is absent from the tree the server sends, like one that is gone (ADR-0042).
    servers.writeAsOther(ws, { title: "Plan", markdown: `# Plan\n\nFirst line here.\n\nSee [[thoth:page/${GONE}]].\n` });
    servers.writeAsOther(ws, { title: "Roadmap", markdown: "# Roadmap\n" });
    const app = await openApp(root, { autosaveMs: 0 }, createNodePlatform({ vault: root, servers }));
    const list = await screen.findByRole("tree", { name: "Workspaces on Team server" });
    await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
    const pages = await within(list).findByRole("group", { name: "Pages in Design" });
    await app.user.click(await within(pages).findByRole("treeitem", { name: "Plan" }));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("First line here."));
    return { app, box, plan: () => servers.page(ws, "Plan") };
  }

  it("offers pages and members by display name, saves a mention, and shows an unseen page as unavailable", async () => {
    const { app, box, plan } = await openPlan();
    const chip = box.querySelector<HTMLElement>(".wikilink")!;
    await waitFor(() => expect(chip.dataset["state"]).toBe("unresolved"));
    expect(chip.textContent).toBe("Page not available");
    expect(box.textContent).not.toContain(GONE);

    box.focus();
    caretAtEnd(paragraph(box, "First line here."));
    typeBlocks(box, " @ro");
    const people = () => screen.queryByRole("listbox", { name: "Link to a page, folder or person" });
    await waitFor(() => expect(within(people()!).getAllByRole("option").map((o) => o.querySelector(".link-option-title")!.textContent)).toEqual(["Roadmap", "Rosa Diaz"]));
    const rosa = within(people()!).getAllByRole("option")[1]!;
    expect(rosa.textContent).toContain("Person");
    expect(rosa.textContent).not.toMatch(/usr_|manager/i); // the name only: no ID and no role
    await app.user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(box.querySelector(".mention")?.textContent).toBe("@Rosa Diaz"));
    expect(await axeViolations(box)).toEqual([]);
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(() => expect(plan().markdown).toContain("First line here. [@Rosa Diaz](thoth:user/usr_rosa)\n"), { timeout: 3000 });
  });
});

describe("@ links to a page limited to teams carry no title (ADR-0049, ADR-0042)", () => {
  /** Plan, Roadmap (seen by all) and Payroll in the folder Finance, which is limited to the team Finance. */
  async function openPlan(role: "owner" | "editor") {
    const servers = new FakeServers();
    const server = servers.connect({ url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" }, capabilities: ["page-order", "page-kind", "members", "teams"] });
    const ws = servers.addWorkspace(server, { name: "Design", role, members: [{ userId: "usr_me", displayName: "Ada", role }] });
    servers.writeAsOther(ws, { title: "Plan", markdown: "# Plan\n\nFirst line here.\n" });
    const roadmap = servers.writeAsOther(ws, { title: "Roadmap", markdown: "# Roadmap\n" });
    const finance = servers.writeAsOther(ws, { title: "Finance", markdown: "---\nthoth_kind: folder\n---\n" });
    const payroll = servers.writeAsOther(ws, { title: "Payroll", markdown: "# Payroll\n", parentId: finance.id });
    // The editor is in the team (so may see Payroll); the owner is in none and sees it anyway.
    ws.teams.push({ id: "team_1", name: "Finance", memberIds: role === "editor" ? ["usr_me"] : [] });
    ws.visibility.set(finance.id, ["team_1"]);
    const app = await openApp(root, { autosaveMs: 0 }, createNodePlatform({ vault: root, servers }));
    const list = await screen.findByRole("tree", { name: "Workspaces on Team server" });
    await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
    const pages = await within(list).findByRole("group", { name: "Pages in Design" });
    await app.user.click(await within(pages).findByRole("treeitem", { name: "Plan" }));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("First line here."));
    // The client has asked who may see what; give the editor a moment to take the answer.
    const asked = role === "owner" ? "/teams/team_1/pages" : "/teams";
    await waitFor(() => expect(servers.calls.some((c) => c.path.endsWith(asked))).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    return { app, box, ids: { roadmap: roadmap.id, finance: finance.id, payroll: payroll.id }, plan: () => servers.page(ws, "Plan") };
  }

  const people = () => screen.queryByRole("listbox", { name: "Link to a page, folder or person" });
  const offered = () => within(people()!).getAllByRole("option").map((o) => o.querySelector(".link-option-title")!.textContent);

  async function pick(app: Awaited<ReturnType<typeof openPlan>>["app"], box: HTMLElement, query: string, title: string) {
    typeBlocks(box, ` @${query}`);
    await waitFor(() => expect(offered()[0]).toBe(title));
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(people()?.hidden ?? true).toBe(true));
  }

  it("an owner: links to Payroll and its limited folder are written without a title; Roadmap keeps its title; chips show the live title", async () => {
    const { app, box, ids, plan } = await openPlan("owner");
    box.focus();
    caretAtEnd(paragraph(box, "First line here."));
    await pick(app, box, "payr", "Payroll");
    await pick(app, box, "fina", "Finance");
    await pick(app, box, "roadm", "Roadmap");
    const chips = [...box.querySelectorAll<HTMLElement>(".wikilink")].map((c) => c.textContent);
    expect(chips).toEqual(["Payroll", "Finance", "Roadmap"]);
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(() => expect(plan().markdown).toContain(`First line here. [[thoth:page/${ids.payroll}]] [[thoth:page/${ids.finance}]] [[thoth:page/${ids.roadmap}|Roadmap]]\n`), { timeout: 3000 });
    expect(plan().markdown).not.toMatch(/Payroll|Finance/);
  });

  it("an editor in a team: every link is written without a title, even to Roadmap", async () => {
    const { app, box, ids, plan } = await openPlan("editor");
    box.focus();
    caretAtEnd(paragraph(box, "First line here."));
    await pick(app, box, "payr", "Payroll");
    await pick(app, box, "roadm", "Roadmap");
    expect([...box.querySelectorAll<HTMLElement>(".wikilink")].map((c) => c.textContent)).toEqual(["Payroll", "Roadmap"]);
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(() => expect(plan().markdown).toContain(`First line here. [[thoth:page/${ids.payroll}]] [[thoth:page/${ids.roadmap}]]\n`), { timeout: 3000 });
  });
});
