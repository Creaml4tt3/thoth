// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareExpiry, ShareLink } from "@thoth/workspace-protocol";
import { ShareDialog } from "../src/workspace/ShareDialog.tsx";
import { REMEMBERED_KEY } from "../src/workspace/share-remembered.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => localStorage.clear());

const PAGE = "01900000-0000-7000-8000-000000000000";
const link = (expiresAt: string | null, id = "shl_1"): ShareLink => ({
  id,
  workspaceId: "ws_1",
  pageId: PAGE,
  createdAt: new Date(2026, 9, 28, 9, 30).toISOString(),
  createdBy: "usr_1",
  expiresAt,
});

/** A fake server: links it made are listed until revoked. */
function server(initial: ShareLink[] = []) {
  const links = [...initial];
  let n = 0;
  return {
    links,
    client: {
      listShareLinks: async () => [...links],
      createShareLink: async (_ws: string, _page: string, expiry: ShareExpiry) => {
        const id = `shl_new${++n}`;
        const made = link(expiry === null ? null : new Date(Date.now() + expiry * 86_400_000).toISOString(), id);
        links.push(made);
        return { ...made, token: `secret${n}`, url: `https://api.example/s/secret${n}` };
      },
      revokeShareLink: async (_ws: string, id: string) => {
        links.splice(links.findIndex((l) => l.id === id), 1);
      },
    },
  };
}

const open = (client: ReturnType<typeof server>["client"]) =>
  render(<ShareDialog client={client} workspace="ws_1" page={PAGE} title="Plan" onClose={() => {}} />);

describe("ShareDialog", () => {
  it("shows when an active link stops working with its time, in the person's time zone (the server stops it at that moment)", async () => {
    // 2:05 PM local time, whatever the machine's zone: the dialog must show that time, not only the day.
    open(server([link(new Date(2026, 10, 27, 14, 5).toISOString())]).client);
    const item = await screen.findByRole("listitem");
    expect(item.textContent).toMatch(/stops working Nov 27, 2026,? (at )?2:05\s?PM/);
  });

  it("says the exact date and time the chosen expiry ends, before the link is made", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 28, 2, 43));
    open(server().client);
    const user = userEvent.setup();
    const when = await screen.findByTestId("share-ends");
    expect(when.textContent).toMatch(/Stops working Nov 27, 2026,? (at )?2:43\s?AM/); // 30 days, the default
    await user.click(screen.getByRole("radio", { name: "7 days" }));
    expect(when.textContent).toMatch(/Stops working Nov 4, 2026,? (at )?2:43\s?AM/);
    await user.click(screen.getByRole("radio", { name: "Never" }));
    expect(when.textContent).toBe("Never stops working");
  });

  it("lists a link made on this device with its address and a Copy button, after the dialog is opened again", async () => {
    const fake = server();
    const user = userEvent.setup();
    open(fake.client);
    await user.click(screen.getByRole("button", { name: "Create link" }));
    await screen.findAllByDisplayValue("https://api.example/s/secret1");
    cleanup();

    open(fake.client);
    const item = await screen.findByRole("listitem");
    expect(within(item).getByRole("textbox", { name: /Link created/ })).toHaveProperty("value", "https://api.example/s/secret1");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await user.click(within(item).getByRole("button", { name: /^Copy the link created/ }));
    expect(writeText).toHaveBeenCalledWith("https://api.example/s/secret1");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Link copied"));
  });

  it("a link made elsewhere (or before this version) has no address to show, and revoking forgets a remembered one", async () => {
    const fake = server([link(null, "shl_old")]);
    const user = userEvent.setup();
    open(fake.client);
    await user.click(screen.getByRole("button", { name: "Create link" }));
    await screen.findAllByDisplayValue("https://api.example/s/secret1");
    const items = await screen.findAllByRole("listitem");
    expect(within(items[0]!).queryByRole("textbox")).toBeNull();
    expect(JSON.parse(localStorage.getItem(REMEMBERED_KEY)!)).toHaveProperty("shl_new1");
    await user.click(within(items[1]!).getByRole("button", { name: /^Revoke/ }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem(REMEMBERED_KEY)!)).not.toHaveProperty("shl_new1");
  });
});
