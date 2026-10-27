// @vitest-environment jsdom
// Split view (ADR-0030) in the web client: the same panes as the desktop, one workspace page in both, saved once.
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { FakeWebServer } from "./support/fake-web-server.ts";
import { TABS_KEY } from "../src/tabs-store.ts";
import { caretAtEnd } from "./support/caret.ts";
import { cleanup, fakeBrowser, screen, signInThroughUi, waitFor, within } from "./support/render.tsx";

afterEach(() => cleanup());

const names = (name: string) => within(screen.getByRole("tablist", { name })).queryAllByRole("tab").map((t) => t.textContent);
const row = (name: string) => screen.findByRole("treeitem", { name });
const paragraph = (box: HTMLElement, text: string): HTMLElement => {
  const found = [...box.querySelectorAll("p")].find((p) => p.textContent === text);
  if (!found) throw new Error(`No paragraph "${text}"`);
  return found;
};

describe("split view on the web", () => {
  it("splits from the tab's menu, shows one page in both panes, and saves it once without a conflict", async () => {
    const server = new FakeWebServer();
    const ws = server.workspace("Notes");
    for (const title of ["Alpha", "Beta"]) server.servers.writeAsOther(ws, { title, markdown: `# ${title}\n\nBody of ${title}.\n` });
    const browser = fakeBrowser(server);
    await signInThroughUi(browser);

    await browser.user.click(await row("Alpha"));
    await waitFor(() => expect(names("Open pages")).toEqual(["Alpha"]));
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Alpha" }), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Split right" }));
    await waitFor(() => expect(names("Open pages, right")).toEqual(["Alpha"]));
    expect(names("Open pages, left")).toEqual(["New tab"]);

    // The left pane opens Alpha too.
    await browser.user.click(within(screen.getByRole("tablist", { name: "Open pages, left" })).getByRole("tab", { name: "New tab" }));
    await browser.user.click(await row("Alpha"));
    await waitFor(() => expect(names("Open pages, left")).toEqual(["Alpha"]));
    const boxes = await waitFor(() => {
      const found = screen.getAllByRole("textbox", { name: /page content/i });
      expect(found).toHaveLength(2);
      for (const box of found) expect(box.textContent).toContain("Body of Alpha.");
      return found;
    });
    const [one, two] = boxes as [HTMLElement, HTMLElement];
    one.focus();
    caretAtEnd(paragraph(one, "Body of Alpha."));
    await browser.user.keyboard(" Both panes.");
    await waitFor(() => expect(two.textContent).toContain("Body of Alpha. Both panes."));
    await browser.user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(server.servers.page(ws, "Alpha").markdown).toContain("Body of Alpha. Both panes."));
    expect(screen.queryByRole("dialog")).toBeNull();

    // The layout is kept in this browser, ids only.
    const stored = JSON.parse(browser.local.get(TABS_KEY)!);
    expect(stored.v).toBe(2);
    expect(stored.panes).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toMatch(/Alpha|Body of/);
  });
});
