// @vitest-environment jsdom
// Public read-only share links in the web client (ADR-0023): "Share…" in the page menu and the palette, the dialog that
// creates, copies, lists and revokes a page's links, and where it is hidden (no capability, a viewer).
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { axeViolations } from "../../../tests/helpers/axe.ts";
import { FakeWebServer, SERVER } from "./support/fake-web-server.ts";
import { cleanup, fakeBrowser, screen, signInThroughUi, waitFor, within, type FakeBrowser } from "./support/render.tsx";

afterEach(() => cleanup());

const SHARING = ["search", "transfers", "attachments", "page-order", "page-kind", "public-share"];

async function signedIn(options: { capabilities?: string[]; role?: "owner" | "editor" | "viewer"; limits?: Record<string, number> } = {}) {
  const server = new FakeWebServer({ capabilities: options.capabilities ?? SHARING, ...(options.limits ? { limits: options.limits } : {}) });
  const ws = server.workspace("Notes", options.role ?? "editor");
  const page = server.servers.writeAsOther(ws, { title: "Field notes", markdown: "# Field notes\n\nHello.\n" });
  const browser = fakeBrowser(server);
  await signInThroughUi(browser);
  return Object.assign(browser, { ws, page });
}

async function menuFor(name: string) {
  fireEvent.contextMenu(await screen.findByRole("treeitem", { name }));
  return screen.findByRole("menu", { name: `Actions for ${name}` });
}

async function openShare(browser: FakeBrowser) {
  const menu = await menuFor("Field notes");
  await browser.user.click(within(menu).getByRole("menuitem", { name: "Share…" }));
  return screen.findByRole("dialog", { name: "Share “Field notes”" });
}

async function palette(browser: FakeBrowser, what: string) {
  await browser.user.keyboard("{Control>}k{/Control}");
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  await browser.user.keyboard(`> ${what}`);
  return dialog;
}

describe("sharing a page", () => {
  it("the page menu has no Private Space items on the web", async () => {
    await signedIn();
    const menu = await menuFor("Field notes");
    expect(within(menu).queryByRole("menuitem", { name: /Private Space/ })).toBeNull();
  });

  it("has a Share… button in the open page's header that opens the dialog, hidden for a viewer", async () => {
    const browser = await signedIn();
    await browser.user.click(await screen.findByRole("treeitem", { name: "Field notes" }));
    await browser.user.click(await screen.findByRole("button", { name: "Share…" }));
    expect(await screen.findByRole("dialog", { name: "Share “Field notes”" })).toBeTruthy();
    cleanup();
    const viewer = await signedIn({ role: "viewer" });
    await viewer.user.click(await screen.findByRole("treeitem", { name: "Field notes" }));
    await screen.findByRole("button", { name: "Favorite" });
    expect(screen.queryByRole("button", { name: "Share…" })).toBeNull();
  });

  it("creates a 30-day link by default, shows its address once, copies it, and lists it", async () => {
    const browser = await signedIn();
    const dialog = await openShare(browser);
    expect(within(dialog).getByText(/Anyone with a link can read this page and the pages inside it/)).toBeTruthy();
    expect(await within(dialog).findByText("No active links.")).toBeTruthy();
    const thirty = within(dialog).getByRole("radio", { name: "30 days" }) as HTMLInputElement;
    expect(thirty.checked).toBe(true);
    expect(within(dialog).getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? (r.closest("label")?.textContent ?? ""))).toEqual(["7 days", "30 days", "90 days", "Never"]);

    await browser.user.click(within(dialog).getByRole("button", { name: "Create link" }));
    const field = (await within(dialog).findByRole("textbox", { name: "Public link" })) as HTMLInputElement;
    const link = browser.ws.shares[0]!;
    expect(field.value).toBe(`${SERVER}/s/${link.token}`);
    expect(field.readOnly).toBe(true);
    expect(link.expiresAt).toBe(new Date(Date.parse(link.createdAt) + 30 * 86_400_000).toISOString());
    expect(within(dialog).getByText(/shown only this once/)).toBeTruthy();

    await browser.user.click(within(dialog).getByRole("button", { name: "Copy link" }));
    expect(await navigator.clipboard.readText()).toBe(`${SERVER}/s/${link.token}`);
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toBe("Link copied"));

    const list = within(dialog).getByRole("list", { name: "Active links" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByRole("listitem").textContent).toMatch(/Created .*2026.*stops working .*2026/);
  });

  it("sends the expiry chosen: 7 days, 90 days or never", async () => {
    const browser = await signedIn();
    const dialog = await openShare(browser);
    for (const choice of ["7 days", "90 days", "Never"]) {
      await browser.user.click(within(dialog).getByRole("radio", { name: choice }));
      await browser.user.click(within(dialog).getByRole("button", { name: "Create link" }));
      await waitFor(() => expect(browser.ws.shares.length).toBe(["7 days", "90 days", "Never"].indexOf(choice) + 1));
    }
    const days = browser.ws.shares.map((l) => (l.expiresAt === null ? null : Math.round((Date.parse(l.expiresAt) - Date.parse(l.createdAt)) / 86_400_000)));
    expect(days).toEqual([7, 90, null]);
    const list = within(dialog).getByRole("list", { name: "Active links" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    expect(within(list).getAllByRole("listitem")[0]!.textContent).toContain("never stops working");
  });

  it("revokes a link: it leaves the list, and screen readers hear that it no longer works", async () => {
    const browser = await signedIn();
    const dialog = await openShare(browser);
    await browser.user.click(within(dialog).getByRole("button", { name: "Create link" }));
    const revoke = await within(dialog).findByRole("button", { name: /^Revoke the link created / });
    await browser.user.click(revoke);
    await waitFor(() => expect(browser.ws.shares[0]!.revoked).toBe(true));
    expect(await within(dialog).findByText("No active links.")).toBeTruthy();
    expect(within(dialog).getByRole("status").textContent).toBe("Link revoked. It no longer works.");
    // The address shown for copying belonged to that link: it goes too.
    expect(within(dialog).queryByRole("textbox", { name: "Public link" })).toBeNull();
  });

  it("shows a refusal (the trial's limit) as an alert and keeps the dialog open", async () => {
    const browser = await signedIn({ limits: { maxShareLinksPerWorkspace: 1 } });
    const dialog = await openShare(browser);
    await browser.user.click(within(dialog).getByRole("button", { name: "Create link" }));
    await within(dialog).findByRole("textbox", { name: "Public link" });
    await browser.user.click(within(dialog).getByRole("button", { name: "Create link" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/^Could not create the link: .*1 active share link/);
    expect(browser.ws.shares).toHaveLength(1);
  });

  it("is offered in the palette as “Share page…” on an open page", async () => {
    const browser = await signedIn();
    await browser.user.click(await screen.findByRole("treeitem", { name: "Field notes" }));
    const search = await palette(browser, "share");
    await browser.user.click(within(search).getByRole("option", { name: /^Share page…/ }));
    expect(await screen.findByRole("dialog", { name: "Share “Field notes”" })).toBeTruthy();
  });

  it("passes axe, with the new link shown and the list filled", async () => {
    const browser = await signedIn();
    const dialog = await openShare(browser);
    expect(await axeViolations(dialog)).toEqual([]);
    await browser.user.click(within(dialog).getByRole("button", { name: "Create link" }));
    await within(dialog).findByRole("textbox", { name: "Public link" });
    expect(await axeViolations(dialog)).toEqual([]);
  });
});

describe("where sharing is not offered", () => {
  it("not when the server lacks public-share: neither in the menu nor in the palette", async () => {
    const browser = await signedIn({ capabilities: ["search", "page-order", "page-kind"] });
    const menu = await menuFor("Field notes");
    expect(within(menu).queryByRole("menuitem", { name: "Share…" })).toBeNull();
    await browser.user.keyboard("{Escape}");
    await browser.user.click(await screen.findByRole("treeitem", { name: "Field notes" }));
    const search = await palette(browser, "share");
    expect(within(search).queryByRole("option", { name: /^Share page/ })).toBeNull();
    expect(browser.server.servers.calls.some((c) => c.path.includes("share-links"))).toBe(false);
  });

  it("not for a viewer", async () => {
    const browser = await signedIn({ role: "viewer" });
    await browser.user.click(await screen.findByRole("treeitem", { name: "Field notes" }));
    const search = await palette(browser, "share");
    expect(within(search).queryByRole("option", { name: /^Share page/ })).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
