// @vitest-environment jsdom
/**
 * Opening links in a page (0.2.7, `link-open.ts`): a page link opens on a click, in a new tab with Cmd/Ctrl or the
 * middle button and in a new window with Shift; a web link opens only with Cmd/Ctrl or the middle button (a plain
 * click edits it), in both editor modes. Each says how on hover.
 */
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Links, LinkPreview } from "@thoth/platform";
import { HostCallError } from "@thoth/platform/remote";
import { pageLinkOpens, webLinkOpens } from "@thoth/app-ui/editor/link-open.ts";
import { setDefaultEditorMode } from "@thoth/app-ui/editor/mode.ts";
import { setLinkPreviewMode } from "@thoth/app-ui/editor/link-previews.ts";
import { cleanup, editorBox, openApp, screen, waitFor, within } from "./support/render.tsx";
import { createFakeWindows, createNodePlatform, tempDirs, type FakeWindows } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";

const dirs = tempDirs();
let root: string;
let links: FakeLinks;
let windows: FakeWindows;

class FakeLinks implements Links {
  opened: string[] = [];
  async preview(): Promise<LinkPreview> {
    throw new HostCallError("PREVIEW_UNAVAILABLE", "No preview");
  }
  async clearPreviews(): Promise<void> {}
  async open(url: string): Promise<void> {
    this.opened.push(url);
  }
}

const PAGE = "# Links\n\nSee [[Target]] and [the site](https://example.com/a) here.\n";

beforeEach(async () => {
  root = await dirs.dir();
  links = new FakeLinks();
  windows = createFakeWindows();
  // Off: no preview card takes the place of the link.
  setLinkPreviewMode("off");
  await seed(root, { "Links.md": PAGE, "Target.md": "# Target\n\nI am the target.\n" });
});
afterEach(async () => {
  setDefaultEditorMode("blocks");
  setLinkPreviewMode("on");
  localStorage.clear();
  cleanup();
  await dirs.cleanup();
});

async function open() {
  const app = await openApp(root, {}, createNodePlatform({ vault: root, links, windows }));
  await app.user.click(within(await screen.findByRole("tree", { name: "Pages in this Private Space" })).getByRole("treeitem", { name: "Links" }));
  const box = await editorBox();
  await waitFor(() => expect(box.textContent).toContain("here."));
  return { app, box };
}

const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);
const userClickTab = async (name: string) => {
  fireEvent.mouseDown(screen.getAllByRole("tab", { name })[0]!);
  fireEvent.click(screen.getAllByRole("tab", { name })[0]!);
  await waitFor(() => expect(screen.getByRole("tab", { selected: true }).textContent).toBe(name));
};

describe("the gestures", () => {
  it("page links: click here, Cmd/Ctrl or middle a new tab, Shift a new window; web links only with Cmd/Ctrl or middle", () => {
    const at = (o: Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }>) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, ...o });
    expect(pageLinkOpens(at({}))).toBeUndefined();
    expect(pageLinkOpens(at({ metaKey: true }))).toEqual({ newTab: true });
    expect(pageLinkOpens(at({ ctrlKey: true }))).toEqual({ newTab: true });
    expect(pageLinkOpens(at({ button: 1 }))).toEqual({ newTab: true });
    expect(pageLinkOpens(at({ shiftKey: true }))).toEqual({ newWindow: true });
    expect(webLinkOpens(at({}))).toBe(false);
    expect(webLinkOpens(at({ shiftKey: true }))).toBe(false);
    expect(webLinkOpens(at({ metaKey: true }))).toBe(true);
    expect(webLinkOpens(at({ ctrlKey: true }))).toBe(true);
    expect(webLinkOpens(at({ button: 1 }))).toBe(true);
  });
});

describe("Blocks mode", () => {
  it("a page link says how to open it; Cmd/Ctrl+click opens a new tab next to the page, a middle-click too", async () => {
    const { box } = await open();
    const chip = box.querySelector<HTMLElement>("a.wikilink")!;
    expect(chip.getAttribute("data-tip")).toBe("Target.md");
    expect(chip.getAttribute("data-tip-detail")).toMatch(/new tab · Shift\+click: new window$/);
    expect(chip.hasAttribute("title")).toBe(false);
    fireEvent.click(chip, { ctrlKey: true });
    await waitFor(() => expect(tabNames()).toEqual(["Links", "Target"]));
    await userClickTab("Links");
    const again = (await editorBox()).querySelector<HTMLElement>("a.wikilink")!;
    fireEvent(again, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    await waitFor(() => expect(tabNames()).toEqual(["Links", "Target", "Target"]));
  });

  it("Shift+click opens the page in a new window of this Private Space", async () => {
    const { box } = await open();
    fireEvent.click(box.querySelector<HTMLElement>("a.wikilink")!, { shiftKey: true });
    await waitFor(() => expect(windows.opened).toHaveLength(1));
    expect(windows.opened[0]!.root).toBe(root);
    expect(JSON.parse(windows.opened[0]!.tabs)).toMatchObject({ tabs: [{ k: "page", path: "Target.md" }] });
    expect(tabNames()).toEqual(["Links"]);
  });

  it("a web link: a plain click does not open it; Cmd/Ctrl+click and a middle-click do; the tooltip says so", async () => {
    const { box } = await open();
    const a = [...box.querySelectorAll<HTMLAnchorElement>("a:not(.wikilink)")].find((x) => x.textContent === "the site")!;
    fireEvent.mouseOver(a);
    expect(a.getAttribute("data-tip")).toBe("https://example.com/a");
    expect(a.getAttribute("data-tip-detail")).toMatch(/^(Cmd|Ctrl)\+click to open$/);
    const plain = fireEvent.click(a);
    expect(plain).toBe(false); // the click's default (following the link) was stopped
    expect(links.opened).toEqual([]);
    fireEvent.click(a, { metaKey: true });
    expect(links.opened).toEqual(["https://example.com/a"]);
    fireEvent(a, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(links.opened).toEqual(["https://example.com/a", "https://example.com/a"]);
  });
});

describe("Plain mode", () => {
  it("a web link's text carries its address and opens with Cmd/Ctrl+click; a page link opens a new tab with Cmd/Ctrl", async () => {
    setDefaultEditorMode("plain");
    const { box } = await open();
    await waitFor(() => expect(box.querySelector("[data-href]")).not.toBeNull());
    const web = box.querySelector<HTMLElement>("[data-href]")!;
    expect(web.textContent).toBe("the site");
    expect(web.getAttribute("data-tip")).toBe("https://example.com/a");
    fireEvent.click(web);
    expect(links.opened).toEqual([]);
    fireEvent.click(web, { ctrlKey: true });
    expect(links.opened).toEqual(["https://example.com/a"]);

    const chip = box.querySelector<HTMLElement>("a.wikilink")!;
    expect(chip.getAttribute("data-tip-detail")).toMatch(/new window$/);
    fireEvent.mouseDown(chip, { metaKey: true });
    await waitFor(() => expect(tabNames()).toEqual(["Links", "Target"]));
  });
});
