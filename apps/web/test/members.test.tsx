// @vitest-environment jsdom
// Workspace members and invite links in the web client (ADR-0024): "Members…" from the workspace row and the palette,
// an owner's invite link, a viewer leaving (the workspace leaves the sidebar, its open page says "no access"), and
// where it is hidden.
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { axeViolations } from "../../../tests/helpers/axe.ts";
import { FakeWebServer, SERVER } from "./support/fake-web-server.ts";
import { cleanup, fakeBrowser, screen, signInThroughUi, waitFor, within, type FakeBrowser } from "./support/render.tsx";

afterEach(() => cleanup());

const CAPS = ["search", "transfers", "attachments", "page-order", "page-kind", "public-share", "members", "invite-links"];

async function signedIn(options: { capabilities?: string[]; role?: "owner" | "editor" | "viewer" } = {}) {
  const server = new FakeWebServer({ capabilities: options.capabilities ?? CAPS });
  const role = options.role ?? "owner";
  const ws = server.workspace("Notes", role);
  ws.members = [
    { userId: "usr_ada", displayName: "Ada Lovelace", role },
    { userId: "usr_kim", displayName: "Kim", role: role === "owner" ? "editor" : "owner" },
  ];
  const page = server.servers.writeAsOther(ws, { title: "Field notes", markdown: "# Field notes\n\nHello.\n" });
  const browser = fakeBrowser(server);
  await signInThroughUi(browser);
  return Object.assign(browser, { ws, page });
}

async function palette(browser: FakeBrowser, what: string) {
  await browser.user.keyboard("{Control>}k{/Control}");
  const dialog = await screen.findByRole("dialog", { name: "Search" });
  await browser.user.keyboard(`> ${what}`);
  return dialog;
}

describe("Members… in the web client", () => {
  it("opens from the workspace row's menu; an owner makes an invite link and sees it listed", async () => {
    const browser = await signedIn();
    fireEvent.contextMenu(await screen.findByRole("treeitem", { name: /^Notes/ }));
    const menu = await screen.findByRole("menu", { name: "Actions for Notes" });
    await browser.user.click(within(menu).getByRole("menuitem", { name: "Members…" }));
    const dialog = await screen.findByRole("dialog", { name: "Members of “Notes”" });
    const list = await within(dialog).findByRole("list", { name: "Members" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    // Owners first, then by name.
    await waitFor(() => expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringMatching(/^Ada Lovelace \(you\)/), expect.stringMatching(/^Kim/)]));
    const invite = within(dialog).getByRole("region", { name: "Invite people" });
    await browser.user.click(within(invite).getByRole("button", { name: "Create invite link" }));
    const field = (await within(invite).findByRole("textbox", { name: "Invite link" })) as HTMLInputElement;
    expect(field.value).toBe(`${SERVER}/i/${browser.ws.invites[0]!.token}`);
    expect([browser.ws.invites[0]!.role, browser.ws.invites[0]!.maxUses]).toEqual(["editor", 1]);
    expect(within(invite).getByText(/shown only this once/)).toBeTruthy();
    expect(await axeViolations(dialog)).toEqual([]);
  });

  it("shows a refusal from the server as an alert", async () => {
    const browser = await signedIn();
    await browser.user.click(await screen.findByRole("button", { name: "Members of Notes" }));
    const dialog = await screen.findByRole("dialog", { name: "Members of “Notes”" });
    const kim = (await within(dialog).findByRole("combobox", { name: "Role of Kim" })) as HTMLSelectElement;
    // Demote the only owner (the user): refused, and said why.
    const me = within(dialog).getByRole("combobox", { name: "Role of Ada Lovelace" }) as HTMLSelectElement;
    await browser.user.selectOptions(me, "viewer");
    expect((await within(dialog).findByRole("alert")).textContent).toBe("A workspace needs at least one owner. Make someone else an owner first.");
    expect(browser.ws.members.find((m) => m.userId === "usr_ada")!.role).toBe("owner");
    await waitFor(() => expect(me.value).toBe("owner"));
    expect(kim.value).toBe("editor");
  });

  it("a viewer leaves: the workspace leaves the sidebar and its open page says there is no access", async () => {
    const browser = await signedIn({ role: "viewer" });
    await browser.user.click(await screen.findByRole("treeitem", { name: "Field notes" }));
    const search = await palette(browser, "members");
    await browser.user.click(within(search).getByRole("option", { name: /^Members of Notes…/ }));
    const dialog = await screen.findByRole("dialog", { name: "Members of “Notes”" });
    await within(dialog).findByRole("list", { name: "Members" });
    expect(within(dialog).queryByRole("region", { name: "Invite people" })).toBeNull();
    await browser.user.click(within(dialog).getByRole("button", { name: "Leave workspace" }));
    await browser.user.click(within(within(dialog).getByRole("group", { name: "Leave Notes?" })).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(screen.queryByRole("treeitem", { name: /^Notes/ })).toBeNull());
    expect(await screen.findByText("You no longer have access to this workspace")).toBeTruthy();
  });

  it("is not offered when the server lacks members", async () => {
    const browser = await signedIn({ capabilities: ["search", "page-order", "page-kind"] });
    await browser.user.click(await screen.findByRole("treeitem", { name: "Field notes" }));
    expect(screen.queryByRole("button", { name: "Members of Notes" })).toBeNull();
    const search = await palette(browser, "members");
    expect(within(search).queryByRole("option", { name: /^Members of/ })).toBeNull();
    expect(browser.server.servers.calls.some((c) => c.path.includes("/members"))).toBe(false);
  });
});
