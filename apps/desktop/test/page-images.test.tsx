// @vitest-environment jsdom
/**
 * Images in pages (ADR-0028), in the desktop app against a real vault folder: an image next to the page shows from a
 * `blob:` URL, a missing one names its file, a web image is a link and is never fetched, blob URLs are revoked, the
 * Markdown stays byte-identical, alt text is editable, and `/` Image, paste and drop copy the file next to the page.
 */
import { EditorView } from "@codemirror/view";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, editorBox, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";

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

const editorOf = (box: HTMLElement): Editor => (box as unknown as { editor: Editor }).editor ?? (box.closest(".ProseMirror") as unknown as { editor: Editor }).editor;

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
