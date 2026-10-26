// @vitest-environment jsdom
/**
 * Images in pages (ADR-0028), in the desktop app against a real vault folder: an image next to the page shows from a
 * `blob:` URL, a missing one names its file, a web image is a link and is never fetched, blob URLs are revoked, the
 * Markdown stays byte-identical, alt text is editable, and `/` Image, paste and drop copy the file next to the page.
 */
import { EditorView } from "@codemirror/view";
import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, editorBox, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";
import { newStableId } from "@thoth/domain";
import { FakeServers } from "../../../tests/helpers/fake-servers.ts";

const dirs = tempDirs();
let root: string;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
// An SVG that would run a script and load a web image if it were ever put into the page's DOM.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="20"><script>window.__svgRan = true</script><image href="https://tracker.example/pixel.png" width="1" height="1"/><rect width="40" height="20" fill="teal"/></svg>`;
const PAGE = "# Birds\n\n![Uric acid crystals](bird-uric-acid.svg)\n\n![](my%20photo.png)\n\n![Lost](gone.png)\n\n![A web picture](https://images.example/kite.png)\n\nLast line.\n";

let created: string[];
let revoked: string[];
let blobs: Map<string, Blob>;

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Zoo/Birds.md": PAGE, "Zoo/bird-uric-acid.svg": SVG, "Zoo/my photo.png": PNG, "Notes.md": "# Notes\n\nIntro.\n" });
  created = [];
  revoked = [];
  blobs = new Map();
  // jsdom has no object URLs: record what the editor makes and gives back.
  let n = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:thoth-test/${++n}`;
    created.push(url);
    blobs.set(url, blob);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
});
afterEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  cleanup();
  await dirs.cleanup();
});

async function openBirds(platform = createNodePlatform({ vault: null })): Promise<Harness> {
  platform.pickedVault = root;
  const app = await openApp(root, {}, platform);
  const tree = within(await screen.findByRole("tree"));
  await app.user.click(tree.getByRole("treeitem", { name: "Zoo" }));
  await app.user.click(await tree.findByRole("treeitem", { name: "Birds" }));
  await screen.findByRole("heading", { name: "Birds" });
  return app;
}

const editorOf = (box: HTMLElement): Editor => (box as unknown as { editor: Editor }).editor;

/** Document position at the end of the text block whose text is `text`. */
function endOf(editor: Editor, text: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1 + node.content.size;
  });
  if (found < 0) throw new Error(`No text block "${text}"`);
  return found;
}

function caretAt(editor: Editor, pos: number): void {
  editor.view.focus();
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
}

/** Types the way a keypress does: handleTextInput props first, plain insertion otherwise. */
function type(editor: Editor, text: string): void {
  const { view } = editor;
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

/** What the browser hands the page for files dropped or pasted (jsdom has no DataTransfer). */
function files(...list: File[]) {
  return { files: list, items: list.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })), types: ["Files"], getData: () => "", setData: () => undefined, dropEffect: "none", effectAllowed: "all" };
}

function drop(target: Element, data: ReturnType<typeof files>): Event {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer: data, clientX: 10, clientY: 10 });
  target.dispatchEvent(event);
  return event;
}

function paste(target: Element, data: ReturnType<typeof files>): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.assign(event, { clipboardData: data });
  target.dispatchEvent(event);
  return event;
}

const slashMenu = () => screen.queryByRole("listbox", { name: "Insert block" });
const save = (app: Harness) => app.user.keyboard("{Meta>}s{/Meta}");

describe("images in a Private Space page", () => {
  it("shows an image next to the page from a blob URL with its type, and names the file of a missing one", async () => {
    await openBirds();
    const box = await editorBox();
    const svg = await within(box).findByRole("img", { name: "Uric acid crystals" });
    expect(svg.tagName).toBe("IMG");
    expect(svg.getAttribute("src")).toMatch(/^blob:/);
    const blob = blobs.get(svg.getAttribute("src")!)!;
    expect(blob.type).toBe("image/svg+xml");
    expect(new TextDecoder().decode(await blob.arrayBuffer())).toBe(SVG);

    // `%20` is decoded; an image without alt text still has a name.
    const photo = await within(box).findByRole("img", { name: "Image: my photo.png" });
    expect(photo.getAttribute("src")).toMatch(/^blob:/);
    expect(blobs.get(photo.getAttribute("src")!)!.type).toBe("image/png");

    // Missing: a small placeholder that names the file, never a broken <img>.
    const lost = await within(box).findByText("Image not found: gone.png");
    expect(lost.closest("[data-image-state]")?.getAttribute("data-image-state")).toBe("missing");
    expect(box.querySelectorAll("img")).toHaveLength(2);
    expect([...box.querySelectorAll("img")].every((img) => img.getAttribute("src")!.startsWith("blob:"))).toBe(true);
  });

  it("never puts SVG markup into the page: its script does not run and its web image is not requested", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await openBirds();
    const box = await editorBox();
    await within(box).findByRole("img", { name: "Uric acid crystals" });
    expect(document.querySelector("svg script, svg image")).toBeNull();
    expect(document.body.innerHTML).not.toContain("tracker.example");
    expect((window as { __svgRan?: boolean }).__svgRan).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows a web image as its alt text and address, as a link that opens in the browser, and fetches nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const opened: string[] = [];
    const platform = createNodePlatform({
      vault: null,
      links: { preview: () => Promise.reject(new Error("no previews here")), clearPreviews: async () => {}, open: async (url) => void opened.push(url) },
    });
    const app = await openBirds(platform);
    const box = await editorBox();
    const link = await within(box).findByRole("link", { name: /A web picture.*https:\/\/images\.example\/kite\.png/ });
    expect(link.getAttribute("href")).toBe("https://images.example/kite.png");
    expect(box.querySelector('img[src*="images.example"]')).toBeNull();
    await app.user.click(link);
    expect(opened).toEqual(["https://images.example/kite.png"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("revokes each blob URL when its page closes", async () => {
    const app = await openBirds();
    const box = await editorBox();
    await within(box).findByRole("img", { name: "Uric acid crystals" });
    await within(box).findByRole("img", { name: "Image: my photo.png" });
    expect(created).toHaveLength(2);
    expect(revoked).toEqual([]);
    await app.user.click(within(screen.getByRole("tree")).getByRole("treeitem", { name: "Notes" }));
    await screen.findByRole("heading", { name: "Notes" });
    await waitFor(() => expect(revoked.sort()).toEqual([...created].sort()));
  });

  it("keeps the Markdown byte-identical: Plain mode shows the file as it is, and nothing is written", async () => {
    const app = await openBirds();
    const box = await editorBox();
    await within(box).findByRole("img", { name: "Uric acid crystals" });
    await app.user.click(within(screen.getByRole("group", { name: "Editor mode" })).getByRole("button", { name: "Plain" }));
    const cm = EditorView.findFromDOM((await editorBox()).closest(".cm-editor") as HTMLElement)!;
    expect(cm.state.doc.toString()).toBe(PAGE);
    expect(await app.read("Zoo/Birds.md")).toBe(PAGE);
  });
});

describe("adding an image", () => {
  const ADDED = PAGE.replace("Last line.\n", "Last line.\n\n![Kite](Kite.png)\n");

  it("/ Image picks a file through the host, copies it next to the page and puts the image at the cursor; undo removes it", async () => {
    const platform = createNodePlatform({ vault: null });
    platform.pickedImage = { name: "Kite.png", bytes: PNG };
    const app = await openBirds(platform);
    const box = await editorBox();
    const editor = editorOf(box);
    caretAt(editor, endOf(editor, "Last line."));
    await app.user.keyboard("{Enter}");
    type(editor, "/image");
    await waitFor(() => expect(slashMenu()).not.toBeNull());
    const first = within(slashMenu()!).getAllByRole("option")[0]!;
    expect(first.querySelector(".slash-option-title")!.textContent).toBe("Image");
    await app.user.keyboard("{Enter}");

    expect(await within(box).findByRole("img", { name: "Kite" })).toBeTruthy();
    expect(platform.imagePicks).toBe(1);
    expect(new Uint8Array(await readFile(join(root, "Zoo", "Kite.png")))).toEqual(PNG);
    expect(editor.state.doc.textContent).not.toContain("/image");
    await screen.findByText("Image added: Kite.png");
    await save(app);
    await waitFor(async () => expect(await app.read("Zoo/Birds.md")).toBe(ADDED));

    // Undo takes the image out of the page; the copied file stays (ADR-0028).
    editor.view.focus();
    await app.user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => expect(within(box).queryByRole("img", { name: "Kite" })).toBeNull());
    await save(app);
    await waitFor(async () => expect(await app.read("Zoo/Birds.md")).not.toContain("Kite"));
    expect((await readdir(join(root, "Zoo"))).sort()).toEqual(["Birds.md", "Kite.png", "bird-uric-acid.svg", "my photo.png"]);
  });

  it("does nothing when the picker is cancelled", async () => {
    const platform = createNodePlatform({ vault: null });
    const app = await openBirds(platform);
    const editor = editorOf(await editorBox());
    caretAt(editor, endOf(editor, "Last line."));
    await app.user.keyboard("{Enter}");
    type(editor, "/image");
    await waitFor(() => expect(slashMenu()).not.toBeNull());
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(platform.imagePicks).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(editor.state.doc.textContent).not.toContain("/image");
    expect((await readdir(join(root, "Zoo"))).sort()).toEqual(["Birds.md", "bird-uric-acid.svg", "my photo.png"]);
  });

  it("a dropped image is copied next to the page under a free name and goes in after the block it was dropped on", async () => {
    await seed(root, { "Zoo/Kite.png": new Uint8Array([1, 2, 3]) });
    const app = await openBirds();
    const box = await editorBox();
    const editor = editorOf(box);
    caretAt(editor, endOf(editor, "Last line."));
    const dropped = drop(box.querySelector("p")!, files(new File([PNG], "Kite.png", { type: "image/png" })));
    expect(dropped.defaultPrevented).toBe(true);
    expect(await within(box).findByRole("img", { name: "Kite" })).toBeTruthy();
    // The file already there is never replaced.
    expect(new Uint8Array(await readFile(join(root, "Zoo", "Kite.png")))).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await readFile(join(root, "Zoo", "Kite-2.png")))).toEqual(PNG);
    await save(app);
    await waitFor(async () => expect(await app.read("Zoo/Birds.md")).toBe(PAGE.replace("Last line.\n", "Last line.\n\n![Kite](Kite-2.png)\n")));
  });

  it("a pasted image file goes in at the cursor; other files are left to the browser", async () => {
    const app = await openBirds();
    const box = await editorBox();
    const editor = editorOf(box);
    caretAt(editor, endOf(editor, "Last line."));
    const other = paste(box, files(new File(["<p>hi</p>"], "page.html", { type: "text/html" })));
    expect(other.defaultPrevented).toBe(false);
    // ProseMirror reads that paste back on a timer; let it run while the editor is still there.
    await new Promise((r) => setTimeout(r, 30));
    const pasted = paste(box, files(new File([PNG], "", { type: "image/png" })));
    expect(pasted.defaultPrevented).toBe(true);
    expect(await within(box).findByRole("img", { name: "image" })).toBeTruthy();
    expect(new Uint8Array(await readFile(join(root, "Zoo", "image.png")))).toEqual(PNG);
    await save(app);
    await waitFor(async () => expect(await app.read("Zoo/Birds.md")).toBe(PAGE.replace("Last line.\n", "Last line.\n\n![image](image.png)\n")));
    expect((await readdir(join(root, "Zoo"))).sort()).toEqual(["Birds.md", "bird-uric-acid.svg", "image.png", "my photo.png"]);
  });

  it("says why an image could not be added", async () => {
    const app = await openBirds();
    const box = await editorBox();
    const editor = editorOf(box);
    caretAt(editor, endOf(editor, "Last line."));
    const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" });
    paste(box, files(big));
    await screen.findByText("Could not add the image: The image is larger than 20 MB.");
    expect((await readdir(join(root, "Zoo"))).sort()).toEqual(["Birds.md", "bird-uric-acid.svg", "my photo.png"]);
    expect(app).toBeTruthy();
  });
});

describe("alt text", () => {
  it("is edited from the block menu, saved into the Markdown, and Escape cancels", async () => {
    const app = await openBirds();
    const box = await editorBox();
    const editor = editorOf(box);
    await within(box).findByRole("img", { name: "Uric acid crystals" });
    let pos = -1;
    editor.state.doc.descendants((node, at) => {
      if (pos < 0 && node.type.name === "image") pos = at;
    });
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
    await app.user.keyboard("{Control>}{Alt>}m{/Alt}{/Control}");
    const menu = await screen.findByRole("menu", { name: "Block menu" });
    await app.user.click(within(menu).getByRole("menuitem", { name: "Edit alt text" }));
    const field = await within(box).findByRole("textbox", { name: "Alt text" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect((field as HTMLInputElement).value).toBe("Uric acid crystals");
    await app.user.clear(field);
    await app.user.type(field, "Chalky white crystals{Enter}");
    await waitFor(() => expect(within(box).queryByRole("textbox", { name: "Alt text" })).toBeNull());
    expect(await within(box).findByRole("img", { name: "Chalky white crystals" })).toBeTruthy();
    await save(app);
    await waitFor(async () => expect(await app.read("Zoo/Birds.md")).toBe(PAGE.replace("![Uric acid crystals]", "![Chalky white crystals]")));

    // Enter on a selected image opens the field too; Escape leaves the alt text as it was.
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
    await app.user.keyboard("{Enter}");
    const again = await within(box).findByRole("textbox", { name: "Alt text" });
    await waitFor(() => expect(document.activeElement).toBe(again));
    await app.user.type(again, " extra{Escape}");
    await waitFor(() => expect(within(box).queryByRole("textbox", { name: "Alt text" })).toBeNull());
    expect(editor.state.doc.nodeAt(pos)!.attrs["alt"]).toBe("Chalky white crystals");
  });
});

describe("images in a workspace page", () => {
  async function openPlan(markdown: string, role: "editor" | "viewer" = "editor") {
    const servers = new FakeServers();
    const server = servers.connect({ url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" } });
    const ws = servers.addWorkspace(server, { name: "Design", role });
    const photo = newStableId();
    ws.attachments.set(photo, { id: photo, bytes: PNG, mimeType: "image/png", hash: "x" });
    const page = servers.writeAsOther(ws, { title: "Plan", markdown: markdown.replaceAll("PHOTO", photo) });
    const app = await openApp(root, {}, createNodePlatform({ vault: root, servers }));
    const list = await screen.findByRole("tree", { name: /^Workspaces on / });
    await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
    const pages = await within(list).findByRole("group", { name: "Pages in Design" });
    await app.user.click(await within(pages).findByRole("treeitem", { name: "Plan" }));
    await screen.findByRole("heading", { name: "Plan" });
    return { app, servers, ws, page, photo };
  }

  it("shows an attachment through the authorised download; a path has no folder to resolve against", async () => {
    const { servers, photo } = await openPlan("# Plan\n\n![Team photo](thoth:attachment/PHOTO)\n\n![Local](photo.png)\n\n![Gone](thoth:attachment/01920000-0000-7000-8000-00000000dead)\n");
    const box = await editorBox();
    const img = await within(box).findByRole("img", { name: "Team photo" });
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(blobs.get(img.getAttribute("src")!)!.type).toBe("image/png");
    const download = servers.calls.find((c) => c.path.endsWith(`/attachments/${photo}`))!;
    expect(download).toMatchObject({ method: "GET", responseBytes: true });
    expect(await within(box).findByText("Image not found: photo.png")).toBeTruthy();
    expect(await within(box).findByText("Image not found: thoth:attachment/01920000-0000-7000-8000-00000000dead")).toBeTruthy();
  });

  it("a pasted image is uploaded as an attachment and written as its link", async () => {
    const { app, ws } = await openPlan("# Plan\n\nLast line.\n");
    const box = await editorBox();
    const editor = editorOf(box);
    caretAt(editor, endOf(editor, "Last line."));
    paste(box, files(new File([PNG], "Sketch.png", { type: "image/png" })));
    expect(await within(box).findByRole("img", { name: "Sketch" })).toBeTruthy();
    const uploaded = [...ws.attachments.values()].find((a) => a.fileName === "Sketch.png")!;
    expect(uploaded.bytes).toEqual(PNG);
    expect(uploaded.mimeType).toBe("image/png");
    await save(app);
    await waitFor(() => expect([...ws.pages.values()][0]!.markdown).toBe(`# Plan\n\nLast line.\n\n![Sketch](thoth:attachment/${uploaded.id})\n`));
  });

  it("a viewer cannot add images", async () => {
    await openPlan("# Plan\n\nLast line.\n", "viewer");
    const box = await editorBox();
    const pasted = paste(box, files(new File([PNG], "Sketch.png", { type: "image/png" })));
    expect(pasted.defaultPrevented).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(within(box).queryByRole("img")).toBeNull();
  });
});
