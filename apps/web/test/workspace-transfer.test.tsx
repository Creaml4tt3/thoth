// @vitest-environment jsdom
// Copy and move between two workspaces in the web client (ADR-0006, amendment of 2026-10-27): the same dialog as the
// desktop, from a page's menu, its header and the palette, and by dragging a page onto the other workspace's tree.
// There is no Private Space here, so only this kind of transfer is offered.
import { afterEach, describe, expect, it } from "vitest";
import { createEvent, fireEvent } from "@testing-library/react";
import { axeViolations } from "../../../tests/helpers/axe.ts";
import type { FakeWorkspace } from "../../../tests/helpers/fake-servers.ts";
import { FakeWebServer } from "./support/fake-web-server.ts";
import { cleanup, fakeBrowser, screen, signInThroughUi, waitFor, within, type FakeBrowser } from "./support/render.tsx";

afterEach(() => cleanup());

const CAPS = ["search", "transfers", "attachments", "page-order", "page-kind", "members", "workspace-management"];

async function signedIn(options: { exportRestricted?: boolean } = {}) {
  const server = new FakeWebServer({ capabilities: CAPS });
  const notes = server.workspace("Notes", "owner");
  if (options.exportRestricted) notes.exportRestricted = true;
  const archive = server.workspace("Archive", "owner");
  const page = server.servers.writeAsOther(notes, { title: "Field notes", markdown: "# Field notes\n\nHello.\n" });
  const browser = fakeBrowser(server);
  await signInThroughUi(browser);
  await screen.findByRole("treeitem", { name: /^Notes/ });
  return Object.assign(browser, { notes, archive, page });
}

const live = (ws: FakeWorkspace) => [...ws.pages.values()].filter((p) => !p.deleted);
const tree = () => screen.getByRole("tree");

async function openNotes(browser: FakeBrowser) {
  const row = within(tree()).getByRole("treeitem", { name: /^Notes/ });
  if (row.getAttribute("aria-expanded") !== "true") await browser.user.click(row);
  return within(tree()).findByRole("treeitem", { name: "Field notes" });
}

describe("between two workspaces in the web client", () => {
  it("copies a page from its menu; the dialog has no Private Space and passes axe", async () => {
    const browser = await signedIn();
    fireEvent.contextMenu(await openNotes(browser));
    const menu = await screen.findByRole("menu", { name: "Actions for Field notes" });
    expect(within(menu).queryByRole("menuitem", { name: /Private Space/ })).toBeNull();
    await browser.user.click(within(menu).getByRole("menuitem", { name: "Copy to another workspace…" }));
    const dialog = await screen.findByRole("dialog", { name: "Copy “Field notes” to another workspace" });
    const preview = await within(dialog).findByRole("region", { name: "Who can see it" });
    await waitFor(() => expect(preview.textContent).toContain("Nothing has been written to Archive yet."));
    expect(await axeViolations(dialog)).toEqual([]);
    const copy = within(dialog).getByRole("button", { name: "Copy" }) as HTMLButtonElement;
    await waitFor(() => expect(copy.disabled).toBe(false));
    await browser.user.click(copy);
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("1 page was copied to Archive."), { timeout: 10_000 });
    expect(live(browser.archive).map((p) => p.title)).toEqual(["Field notes"]);
    expect(live(browser.notes)).toHaveLength(1);
  });

  it("moves a page dragged onto the other workspace, through the dialog", async () => {
    const browser = await signedIn();
    const source = await openNotes(browser);
    const target = within(tree()).getByRole("treeitem", { name: /^Archive/ });
    const store = new Map<string, string>();
    const data = { setData: (k: string, v: string) => void store.set(k, v), getData: (k: string) => store.get(k) ?? "", effectAllowed: "", dropEffect: "", types: [] as string[] };
    const fire = (type: "dragEnter" | "dragOver" | "drop") => {
      const event = createEvent[type](target, { dataTransfer: data });
      fireEvent(target, event);
      return event;
    };
    fireEvent.dragStart(source, { dataTransfer: data });
    fire("dragEnter");
    expect(fire("dragOver").defaultPrevented).toBe(true);
    fire("drop");
    fireEvent.dragEnd(source, { dataTransfer: data });
    const dialog = await screen.findByRole("dialog", { name: "Move “Field notes” to another workspace" });
    const move = within(dialog).getByRole("button", { name: "Move" }) as HTMLButtonElement;
    await waitFor(() => expect(move.disabled).toBe(false));
    await browser.user.click(move);
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("1 page was moved to Archive."), { timeout: 10_000 });
    expect(live(browser.notes)).toEqual([]);
    expect(live(browser.archive).map((p) => p.title)).toEqual(["Field notes"]);
  });

  it("an export-restricted workspace refuses: the dialog says why and cannot start", async () => {
    const browser = await signedIn({ exportRestricted: true });
    await browser.user.click(await openNotes(browser));
    await browser.user.click(await screen.findByRole("button", { name: "Copy or move to another workspace…" }));
    const dialog = await screen.findByRole("dialog", { name: "Copy “Field notes” to another workspace" });
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("does not allow copying or moving its pages out"));
    expect((within(dialog).getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the palette offers both commands for the open page", async () => {
    const browser = await signedIn();
    await browser.user.click(await openNotes(browser));
    await screen.findByRole("button", { name: "Copy or move to another workspace…" });
    await browser.user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Search" });
    await browser.user.keyboard("> another workspace");
    await waitFor(() => expect(within(palette).queryAllByRole("option").map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Copy page to another workspace…"), expect.stringContaining("Move page to another workspace…")])));
  });
});
