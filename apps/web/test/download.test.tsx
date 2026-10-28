// @vitest-environment jsdom
// Download as Markdown on the web: the page header's button and the tree's menu download the page's text from the
// server as a .md file through the browser. Not where the workspace keeps its pages in (ADR-0009).
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { FakeWebServer } from "./support/fake-web-server.ts";
import { cleanup, fakeBrowser, screen, signInThroughUi, waitFor, within } from "./support/render.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function signedIn(exportRestricted = false) {
  const server = new FakeWebServer();
  const ws = server.workspace("Notes", "viewer");
  ws.exportRestricted = exportRestricted;
  server.servers.writeAsOther(ws, { title: "Field notes", markdown: "# Field notes\n\nHello.\n" });
  const downloads: { name: string; text: string }[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const blobs: Blob[] = [];
  const RealBlob = Blob;
  vi.stubGlobal(
    "Blob",
    class extends RealBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        blobs.push(this);
      }
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    void blobs.at(-1)!.text().then((text) => downloads.push({ name: this.download, text }));
  });
  const browser = fakeBrowser(server);
  await signInThroughUi(browser);
  return { browser, downloads };
}

describe("Download as Markdown on the web", () => {
  it("downloads the page's text from the menu and the header, for a viewer too", async () => {
    const { browser, downloads } = await signedIn();
    fireEvent.contextMenu(await screen.findByRole("treeitem", { name: "Field notes" }));
    await browser.user.click(within(await screen.findByRole("menu", { name: "Actions for Field notes" })).getByRole("menuitem", { name: "Download as Markdown…" }));
    await waitFor(() => expect(downloads).toEqual([{ name: "Field notes.md", text: "# Field notes\n\nHello.\n" }]));
    await browser.user.click(await screen.findByRole("treeitem", { name: "Field notes" }));
    await browser.user.click(await screen.findByRole("button", { name: "Download as Markdown" }));
    await waitFor(() => expect(downloads).toHaveLength(2));
    vi.unstubAllGlobals();
  });

  it("is not offered where the workspace does not let its pages be copied out", async () => {
    const { browser } = await signedIn(true);
    await browser.user.click(await screen.findByRole("treeitem", { name: "Field notes" }));
    await screen.findByRole("button", { name: "Favorite" });
    expect(screen.queryByRole("button", { name: "Download as Markdown" })).toBeNull();
    vi.unstubAllGlobals();
  });
});
