// @vitest-environment jsdom
/** The network drive notice (ADR-0046): said for a Private Space on a network drive, until it is dismissed there. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, openApp, screen } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { ALPHA, seed } from "./support/fixtures.ts";
import { axeViolations } from "../../../tests/helpers/axe.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA });
});
afterEach(async () => {
  localStorage.clear();
  cleanup();
  await dirs.cleanup();
});

const NOTICE = /network or synced drive/i;

describe("network drive notice", () => {
  it("is said on a network drive and stays dismissed for that Private Space", async () => {
    const platform = createNodePlatform({ vault: root });
    platform.onNetwork.push(root);
    const app = await openApp(root, {}, platform);
    const notice = await screen.findByText(NOTICE);
    expect(notice.textContent).toMatch(/Thoth keeps its own data on this computer/);
    expect(notice.textContent).not.toMatch(/vault/i);
    // A polite live region with a named button, so a screen reader hears it and can dismiss it.
    expect(notice.closest("[role=status]")).not.toBeNull();
    expect(await axeViolations(notice.closest("[role=status]") as HTMLElement)).toEqual([]);
    await app.user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(NOTICE)).toBeNull();
    cleanup();

    const again = createNodePlatform({ vault: root });
    again.onNetwork.push(root);
    await openApp(root, {}, again);
    await screen.findByRole("tree");
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it("is not said on a local folder", async () => {
    await openApp(root);
    await screen.findByRole("tree");
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
