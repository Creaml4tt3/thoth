// @vitest-environment jsdom
/**
 * Link preview cards (ADR-0020 rules 2, 5 and 6) in the desktop app, against a fake host: which links get a card,
 * when a preview is fetched (Private Space at once, workspace pages after "Load preview", the setting), "Show as
 * link" remembered per page, the menu from the keyboard, the page's text shown as text, and the Markdown untouched.
 */
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkPreview, Links } from "@thoth/platform";
import { HostCallError } from "@thoth/platform/remote";
import { linkPreviewMode, setLinkPreviewMode } from "@thoth/app-ui/editor/link-previews.ts";
import { cleanup, editorBox, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";
import { FakeServers, type FakeServerConfig } from "../../../tests/helpers/fake-servers.ts";

const dirs = tempDirs();
let root: string;

const PAGE = `# Links

<https://alone.example/>

Text with <https://inline.example/> inside.

[Named page](https://named.example/a)

<mailto:someone@example.com>
`;

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

class FakeLinks implements Links {
  calls: string[] = [];
  opened: string[] = [];
  cleared = 0;
  readonly answers = new Map<string, LinkPreview>([
    ["https://alone.example/", { url: "https://alone.example/", finalUrl: "https://alone.example/", siteName: "Alone", title: "Alone title", description: "About being alone.", image: PNG }],
    ["https://named.example/a", { url: "https://named.example/a", finalUrl: "https://named.example/a", title: "Named title" }],
  ]);
  async preview(url: string): Promise<LinkPreview> {
    this.calls.push(url);
    const answer = this.answers.get(url);
    if (!answer) throw new HostCallError("PREVIEW_UNAVAILABLE", "No preview");
    return answer;
  }
  async clearPreviews(): Promise<void> {
    this.cleared++;
  }
  async open(url: string): Promise<void> {
    this.opened.push(url);
  }
}

let links: FakeLinks;

beforeEach(async () => {
  root = await dirs.dir();
  links = new FakeLinks();
  await seed(root, { "Page.md": PAGE, "Other.md": "# Other\n\n<https://alone.example/>\n" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  setLinkPreviewMode("on");
  cleanup();
  await dirs.cleanup();
});

type Box = HTMLElement & { editor?: Editor };

async function openPage(name = "Page", app?: Harness) {
  app ??= await openApp(root, {}, createNodePlatform({ vault: root, links }));
  await app.user.click(within(await screen.findByRole("tree", { name: "Pages in this Private Space" })).getByRole("treeitem", { name }));
  const box = await editorBox();
  await waitFor(() => expect(box.textContent).toContain(name === "Page" ? "Text with" : name));
  return { app, box, editor: (box as Box).editor! };
}

const cards = () => screen.queryAllByRole("group", { name: /^Link preview: / });
const card = (name: string) => screen.getByRole("group", { name: `Link preview: ${name}` });

describe("which links get a card", () => {
  it("only a link alone in its paragraph, and only http(s); the Markdown is not changed", async () => {
    const { app, editor } = await openPage();
    await waitFor(() => expect(cards().map((c) => c.getAttribute("aria-label"))).toEqual(["Link preview: Alone title", "Link preview: Named title"]));
    expect([...links.calls].sort()).toEqual(["https://alone.example/", "https://named.example/a"]);
    const alone = card("Alone title");
    expect(within(alone).getByText("Alone")).toBeTruthy();
    expect(within(alone).getByText("About being alone.")).toBeTruthy();
    expect(alone.querySelector("img")?.getAttribute("src")).toBe(PNG);
    expect(alone.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(alone.getAttribute("contenteditable")).toBe("false");
    // Display only: the document, and so the file, still holds a plain link.
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isTextblock && node.textContent.startsWith("Text with")) at = pos + node.nodeSize - 1;
    });
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)));
    await app.user.keyboard("!");
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(async () => expect(await app.read("Page.md")).toBe(PAGE.replace("inside.", "inside.!")));
  });

  it("a page that fails or has no title shows a plain link", async () => {
    links.answers.delete("https://named.example/a");
    links.answers.set("https://alone.example/", { url: "https://alone.example/", finalUrl: "https://alone.example/", siteName: "Only a site" });
    await openPage();
    await waitFor(() => expect(links.calls.length).toBe(2));
    await waitFor(() => expect(cards()).toEqual([]));
  });

  it("Off shows plain links and fetches nothing", async () => {
    setLinkPreviewMode("off");
    await openPage();
    await new Promise((r) => setTimeout(r, 50));
    expect(cards()).toEqual([]);
    expect(links.calls).toEqual([]);
  });

  it("a platform without link previews (the web client) shows plain links", async () => {
    const app = await openApp(root, {}, createNodePlatform({ vault: root }));
    await openPage("Page", app);
    await new Promise((r) => setTimeout(r, 50));
    expect(cards()).toEqual([]);
  });
});

describe("what the page sends is text", () => {
  it("a title with markup is shown as the text it is, and only a checked data: image is used", async () => {
    links.answers.set("https://alone.example/", {
      url: "https://alone.example/",
      finalUrl: "https://alone.example/",
      siteName: "<b>site</b>",
      title: `<img src=x onerror="globalThis.__pwned=1">`,
      description: "<script>globalThis.__pwned=2</script>",
      image: "javascript:alert(1)",
    });
    links.answers.set("https://named.example/a", { url: "https://named.example/a", finalUrl: "https://named.example/a", title: "SVG", image: "data:image/svg+xml;base64,PHN2Zy8+" });
    await openPage();
    const evil = await screen.findByRole("group", { name: `Link preview: <img src=x onerror="globalThis.__pwned=1">` });
    expect(evil.querySelector(".link-card-title")!.textContent).toBe(`<img src=x onerror="globalThis.__pwned=1">`);
    expect(evil.querySelector(".link-card-description")!.textContent).toBe("<script>globalThis.__pwned=2</script>");
    expect(evil.querySelector(".link-card-site")!.textContent).toBe("<b>site</b>");
    expect(evil.querySelectorAll("img, script, b")).toHaveLength(0);
    expect(card("SVG").querySelector("img")).toBeNull();
    expect((globalThis as { __pwned?: unknown }).__pwned).toBeUndefined();
  });
});

describe("Show as link", () => {
  it("hides that link's card on that page, and is remembered", async () => {
    const { app } = await openPage();
    const alone = await screen.findByRole("group", { name: "Link preview: Alone title" });
    await app.user.click(within(alone).getByRole("button", { name: "Link preview options" }));
    await app.user.click(within(alone).getByRole("menuitem", { name: "Show as link" }));
    await waitFor(() => expect(cards().map((c) => c.getAttribute("aria-label"))).toEqual(["Link preview: Named title"]));
    expect((await editorBox()).textContent).toContain("https://alone.example/");
    // Another page with the same link still has its card.
    await openPage("Other", app);
    expect(await screen.findByRole("group", { name: "Link preview: Alone title" })).toBeTruthy();
    // After a restart, the page still shows that link as a link.
    cleanup();
    await openPage();
    await screen.findByRole("group", { name: "Link preview: Named title" });
    expect(screen.queryByRole("group", { name: "Link preview: Alone title" })).toBeNull();
  });
});

describe("the menu", () => {
  it("is reachable from the keyboard: arrows move, Escape closes and returns to its button", async () => {
    const { app } = await openPage();
    const alone = await screen.findByRole("group", { name: "Link preview: Alone title" });
    const more = within(alone).getByRole("button", { name: "Link preview options" });
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    more.focus();
    await app.user.keyboard("{ArrowDown}");
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const items = within(alone).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Show as link", "Open", "Copy link"]);
    expect(document.activeElement).toBe(items[0]);
    await app.user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1]);
    await app.user.keyboard("{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(items[2]);
    await app.user.keyboard("{Escape}");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);
    // Not a trap: Tab from an open menu leaves it.
    await app.user.keyboard("{Enter}");
    expect(within(alone).getByRole("menu").hidden).toBe(false);
    await app.user.tab();
    expect(within(alone).getByRole("menu", { hidden: true }).hidden).toBe(true);
  });

  it("Open asks the host to open the link; Copy link copies it", async () => {
    const { app } = await openPage();
    // After user-event's setup, which puts its own clipboard on `navigator`.
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const named = await screen.findByRole("group", { name: "Link preview: Named title" });
    await app.user.click(within(named).getByRole("button", { name: "Link preview options" }));
    await app.user.click(within(named).getByRole("menuitem", { name: "Open" }));
    await waitFor(() => expect(links.opened).toEqual(["https://named.example/a"]));
    await app.user.click(within(named).getByRole("button", { name: "Link preview options" }));
    await app.user.click(within(named).getByRole("menuitem", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://named.example/a"));
  });
});

describe("when previews are fetched", () => {
  it("with Only for links I paste: links already there wait for Load preview, a pasted one is fetched at once", async () => {
    setLinkPreviewMode("paste");
    links.answers.set("https://pasted.example/x", { url: "https://pasted.example/x", finalUrl: "https://pasted.example/x", title: "Pasted title" });
    const { app, editor } = await openPage();
    const waiting = await screen.findByRole("group", { name: "Link preview: alone.example" });
    expect(within(waiting).getByRole("button", { name: "Load preview" })).toBeTruthy();
    expect(links.calls).toEqual([]);
    // Paste a link on its own line.
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isTextblock && node.textContent.startsWith("Text with")) at = pos + node.nodeSize - 1;
    });
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)));
    await app.user.keyboard("{Enter}");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? "https://pasted.example/x" : "") } });
    editor.view.dom.dispatchEvent(event);
    expect(await screen.findByRole("group", { name: "Link preview: Pasted title" })).toBeTruthy();
    expect(links.calls).toEqual(["https://pasted.example/x"]);
    // Load preview fetches the one asked for, and keeps focus on the card.
    await app.user.click(within(waiting).getByRole("button", { name: "Load preview" }));
    expect(await screen.findByRole("group", { name: "Link preview: Alone title" })).toBeTruthy();
    expect(links.calls).toEqual(["https://pasted.example/x", "https://alone.example/"]);
    await waitFor(() => expect(document.activeElement?.closest("[data-link-card]")?.getAttribute("aria-label")).toBe("Link preview: Alone title"));
  });

  it("links in a workspace page wait for Load preview", async () => {
    const servers = new FakeServers();
    const config: FakeServerConfig = { url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" } };
    const server = servers.connect(config);
    const ws = servers.addWorkspace(server, { name: "Design", role: "editor" });
    servers.writeAsOther(ws, { title: "Plan", markdown: "# Plan\n\n<https://ws.example/>\n" });
    links.answers.set("https://ws.example/", { url: "https://ws.example/", finalUrl: "https://ws.example/", title: "Workspace link" });
    const app = await openApp(root, {}, createNodePlatform({ vault: root, servers, links }));
    const list = await screen.findByRole("tree", { name: /^Workspaces on / });
    await app.user.click(within(list).getByRole("treeitem", { name: /^Design/ }));
    const pages = await within(list).findByRole("group", { name: "Pages in Design" });
    await app.user.click(await within(pages).findByRole("treeitem", { name: "Plan" }));
    const waiting = await screen.findByRole("group", { name: "Link preview: ws.example" });
    await new Promise((r) => setTimeout(r, 50));
    expect(links.calls).not.toContain("https://ws.example/");
    await app.user.click(within(waiting).getByRole("button", { name: "Load preview" }));
    expect(await screen.findByRole("group", { name: "Link preview: Workspace link" })).toBeTruthy();
    expect(links.calls.filter((c) => c === "https://ws.example/")).toHaveLength(1);
  });
});

describe("Settings → Editor → Link previews", () => {
  it("chooses On, Only for links I paste or Off, and clears the cache", async () => {
    const app = await openApp(root, {}, createNodePlatform({ vault: root, links }));
    await app.user.click(await screen.findByRole("button", { name: "Settings" }));
    const group = await screen.findByRole("radiogroup", { name: "Link previews" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["On", "Only for links I paste", "Off"]);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    await app.user.click(radios[1]!);
    expect(linkPreviewMode()).toBe("paste");
    await app.user.click(radios[2]!);
    expect(linkPreviewMode()).toBe("off");
    expect(localStorage.getItem("thoth.editor.linkPreviews")).toBe("off");
    await app.user.click(screen.getByRole("button", { name: "Clear link previews" }));
    await waitFor(() => expect(links.cleared).toBe(1));
    expect(await screen.findByText("Link previews cleared.")).toBeTruthy();
  });
});
