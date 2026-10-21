// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { caretAtEnd, cleanup, editorBox, openApp, paragraph, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA, "Notes/Deep/Gamma.md": "# Gamma\n\nbody\n" });
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

describe("open and edit", () => {
  it("shows the tree, opens a page, edits one block and saves it with Cmd+S", async () => {
    const app = await openApp(root);
    const tree = await screen.findByRole("tree");
    expect(within(tree).getByRole("treeitem", { name: "Alpha" })).toBeTruthy();
    expect(within(tree).getByRole("treeitem", { name: "Notes" })).toBeTruthy();
    expect(screen.getAllByText("Local").length).toBeGreaterThan(0);

    await app.user.click(within(tree).getByRole("treeitem", { name: "Alpha" }));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("First paragraph stays exactly."));

    const before = await app.read("Alpha.md");
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    await app.user.keyboard("!!");
    await app.user.keyboard("{Meta>}s{/Meta}");

    await waitFor(async () => expect(await app.read("Alpha.md")).not.toBe(before));
    const after = await app.read("Alpha.md");
    expect(after).toBe(before.replace("First paragraph stays exactly.", "First paragraph stays exactly.!!"));
  });
});
