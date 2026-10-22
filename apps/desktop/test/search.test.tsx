// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Modal } from "../src/ui/Modal.tsx";
import { cleanup, editorBox, openApp, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA, "Notes/Zebra.md": "# Zebra\n\nStriped animals gallop.\n" });
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

describe("search", () => {
  it("Cmd+K finds a page by body text and opens it", async () => {
    const app = await openApp(root);
    await screen.findByRole("tree");
    await app.user.keyboard("{Meta>}k{/Meta}");
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    await app.user.type(within(dialog).getByRole("combobox"), "gallop");
    const option = await within(dialog).findByRole("option", { name: /Zebra/ });
    expect(option.textContent).toContain("Notes/Zebra.md");
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("Striped animals gallop."));
  });

  it("Ctrl+K also opens search, and Escape closes it", async () => {
    const app = await openApp(root);
    await screen.findByRole("tree");
    await app.user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "Search" });
    await app.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
  });

  it("the Close button and a click on the backdrop also close search", async () => {
    const app = await openApp(root);
    await screen.findByRole("tree");
    await app.user.keyboard("{Meta>}k{/Meta}");
    let dialog = await screen.findByRole("dialog", { name: "Search" });
    await app.user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();

    await app.user.keyboard("{Meta>}k{/Meta}");
    dialog = await screen.findByRole("dialog", { name: "Search" });
    // A click inside the dialog keeps it open; a click on the backdrop closes it.
    await app.user.click(within(dialog).getByRole("combobox"));
    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeNull();
    await app.user.click(dialog.parentElement!);
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
  });

  it("a dialog that must be answered has no Close button", async () => {
    render(<Modal title="Must answer">body</Modal>);
    const dialog = screen.getByRole("dialog", { name: "Must answer" });
    expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull();
  });
});
