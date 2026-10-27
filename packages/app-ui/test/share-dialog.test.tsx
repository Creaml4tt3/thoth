// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ShareLink } from "@thoth/workspace-protocol";
import { ShareDialog } from "../src/workspace/ShareDialog.tsx";

afterEach(cleanup);

const link = (expiresAt: string | null): ShareLink => ({
  id: "shl_1",
  workspaceId: "ws_1",
  pageId: "01900000-0000-7000-8000-000000000000",
  createdAt: new Date(2026, 9, 28, 9, 30).toISOString(),
  createdBy: "usr_1",
  expiresAt,
});

const open = (links: ShareLink[]) =>
  render(
    <ShareDialog
      client={{ listShareLinks: async () => links, createShareLink: async () => Promise.reject(new Error("unused")), revokeShareLink: async () => undefined }}
      workspace="ws_1"
      page="01900000-0000-7000-8000-000000000000"
      title="Plan"
      onClose={() => {}}
    />,
  );

describe("ShareDialog", () => {
  it("shows when an active link stops working with its time, in the person's time zone (the server stops it at that moment)", async () => {
    // 2:05 PM local time, whatever the machine's zone: the dialog must show that time, not only the day.
    open([link(new Date(2026, 10, 27, 14, 5).toISOString())]);
    const item = await screen.findByRole("listitem");
    expect(item.textContent).toMatch(/stops working Nov 27, 2026,? (at )?2:05\s?PM/);
  });
});
