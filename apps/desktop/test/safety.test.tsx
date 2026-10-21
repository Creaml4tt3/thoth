// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caretAtEnd, cleanup, editorBox, openApp, paragraph, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, BETA, seed } from "./support/fixtures.ts";
import { guardWrites } from "./support/write-guard.ts";

const dirs = tempDirs();
let root: string;
const NOW = new Date(2026, 9, 21, 14, 5);
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": BETA });
});
afterEach(async () => {
  vi.restoreAllMocks();
  cleanup();
  await dirs.cleanup();
});

async function openAlpha(guard = guardWrites()) {
  const app = await openApp(root, { now: () => NOW });
  await app.user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: "Alpha" }));
  const box = await editorBox();
  await waitFor(() => expect(box.textContent).toContain("First paragraph stays exactly."));
  return { app, box, guard };
}

async function typeInFirstParagraph(app: Harness, box: HTMLElement, text: string) {
  box.focus();
  caretAtEnd(paragraph(box, "First paragraph stays exactly."));
  await app.user.keyboard(text);
}

/** Lets the debounced watcher run and the shell re-query. */
async function watcherFires(app: Harness) {
  app.platform.emit({ paths: ["Alpha.md"] });
}

describe("saving", () => {
  it("does not write when nothing changed (no-op save keeps mtime and hash)", async () => {
    const { app, guard } = await openAlpha();
    const mtime = await app.mtime("Alpha.md");
    const hash = sha(await readFile(join(root, "Alpha.md")));
    await app.user.keyboard("{Meta>}s{/Meta}");
    await app.user.keyboard("{Control>}s{/Control}");
    await new Promise((r) => setTimeout(r, 60));
    expect(guard.calls).toHaveLength(0);
    expect(await app.mtime("Alpha.md")).toBe(mtime);
    expect(sha(await readFile(join(root, "Alpha.md")))).toBe(hash);
  });

  it("does not write after an edit that is undone back to the original", async () => {
    const { app, box, guard } = await openAlpha();
    await typeInFirstParagraph(app, box, "x");
    await app.user.keyboard("{Backspace}");
    await app.user.keyboard("{Meta>}s{/Meta}");
    await new Promise((r) => setTimeout(r, 60));
    expect(guard.calls).toHaveLength(0);
  });

  it("autosaves after the idle delay", async () => {
    const app = await openApp(root, { autosaveMs: 60 });
    await app.user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: "Alpha" }));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("First paragraph"));
    await typeInFirstParagraph(app, box, "?");
    await waitFor(async () => expect(await app.read("Alpha.md")).toContain("First paragraph stays exactly.?"), { timeout: 3000 });
  });
});

describe("conflicts", () => {
  const EXTERNAL = ALPHA.replace("First paragraph stays exactly.", "First paragraph rewritten elsewhere.");

  async function conflictedAlpha() {
    const ctx = await openAlpha();
    await typeInFirstParagraph(ctx.app, ctx.box, "!!");
    await ctx.app.external("Alpha.md", EXTERNAL);
    await watcherFires(ctx.app);
    const dialog = await screen.findByRole("dialog", { name: /changed on disk/i });
    return { ...ctx, dialog };
  }

  it("shows a line diff and never writes while the dialog is open", async () => {
    const { app, dialog, guard } = await conflictedAlpha();
    expect(within(dialog).getByText("First paragraph rewritten elsewhere.")).toBeTruthy();
    expect(within(dialog).getByText("First paragraph stays exactly.!!")).toBeTruthy();
    expect(dialog.querySelectorAll('[data-kind="add"]').length).toBeGreaterThan(0);
    expect(dialog.querySelectorAll('[data-kind="del"]').length).toBeGreaterThan(0);
    await app.user.keyboard("{Meta>}s{/Meta}");
    await new Promise((r) => setTimeout(r, 60));
    expect(guard.calls).toHaveLength(0);
    expect(await app.read("Alpha.md")).toBe(EXTERNAL);
  });

  it("Escape does not dismiss the dialog", async () => {
    const { app } = await conflictedAlpha();
    await app.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /changed on disk/i })).not.toBeNull();
  });

  it("Keep mine writes the editor version against the current disk hash", async () => {
    const { app, guard } = await conflictedAlpha();
    await app.user.click(screen.getByRole("button", { name: /keep mine/i }));
    await waitFor(async () => expect(await app.read("Alpha.md")).toBe(ALPHA.replace("First paragraph stays exactly.", "First paragraph stays exactly.!!")));
    expect(guard.calls).toHaveLength(1);
    expect(guard.calls[0]!.expectedHash).toBe(sha(EXTERNAL));
    expect(guard.stale()).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /changed on disk/i })).toBeNull());
  });

  it("Keep theirs reloads from disk and drops my edits", async () => {
    const { app, box, guard } = await conflictedAlpha();
    await app.user.click(screen.getByRole("button", { name: /keep theirs/i }));
    await waitFor(() => expect(box.textContent).toContain("First paragraph rewritten elsewhere."));
    expect(box.textContent).not.toContain("!!");
    expect(await app.read("Alpha.md")).toBe(EXTERNAL);
    expect(guard.calls).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: /changed on disk/i })).toBeNull();
  });

  it("Keep both writes a dated conflict copy and reloads theirs", async () => {
    const { app, box, guard } = await conflictedAlpha();
    await app.user.click(screen.getByRole("button", { name: /keep both/i }));
    const copy = "Alpha (conflict 2026-10-21 1405).md";
    await waitFor(async () => expect(await readdir(root)).toContain(copy));
    expect(await app.read(copy)).toBe(ALPHA.replace("First paragraph stays exactly.", "First paragraph stays exactly.!!"));
    expect(await app.read("Alpha.md")).toBe(EXTERNAL);
    await waitFor(() => expect(box.textContent).toContain("First paragraph rewritten elsewhere."));
    expect(guard.calls.map((c) => [c.path, c.expectedHash])).toEqual([[copy, null]]);
    expect(guard.stale()).toEqual([]);
  });

  it("a ConflictError from a lost race opens the dialog and writes nothing", async () => {
    const { app, box, guard } = await openAlpha();
    await typeInFirstParagraph(app, box, "!!");
    // The file changes after the pre-write check but before the write: only the vault's own CAS can catch it.
    const { Vault } = await import("@thoth/local-store");
    type VaultInstance = import("@thoth/local-store").Vault;
    const original = Vault.prototype.readPage;
    let raced = false;
    vi.spyOn(Vault.prototype, "readPage").mockImplementation(async function (this: VaultInstance, path) {
      const result = await original.call(this, path);
      if (!raced) {
        raced = true;
        await app.external("Alpha.md", EXTERNAL);
      }
      return result;
    });
    await app.user.keyboard("{Meta>}s{/Meta}");
    await screen.findByRole("dialog", { name: /changed on disk/i });
    expect(await app.read("Alpha.md")).toBe(EXTERNAL);
    // The race really happened: exactly one write was attempted with a hash that went stale in flight,
    // and the vault's own compare-and-swap refused it (the file still holds the external version).
    expect(guard.calls).toHaveLength(1);
    expect(guard.stale()).toHaveLength(1);
  });

  it("saving before the watcher noticed an external change opens the dialog without offering writePage a stale hash", async () => {
    const { app, box, guard } = await openAlpha();
    await typeInFirstParagraph(app, box, "!!");
    await app.external("Alpha.md", EXTERNAL); // no watcher event
    await app.user.keyboard("{Meta>}s{/Meta}");
    await screen.findByRole("dialog", { name: /changed on disk/i });
    expect(guard.calls).toHaveLength(0);
    expect(await app.read("Alpha.md")).toBe(EXTERNAL);
  });

  it("never calls writePage with a stale hash across the whole conflict flow", async () => {
    const { app, guard } = await conflictedAlpha();
    await app.user.click(screen.getByRole("button", { name: /keep mine/i }));
    await waitFor(() => expect(guard.calls).toHaveLength(1));
    expect(guard.stale()).toEqual([]);
  });
});

describe("external changes", () => {
  it("reloads silently when there are no local edits", async () => {
    const { app, box, guard } = await openAlpha();
    await app.external("Alpha.md", ALPHA.replace("First paragraph stays exactly.", "Changed by another app."));
    await watcherFires(app);
    await waitFor(() => expect(box.textContent).toContain("Changed by another app."));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(guard.calls).toHaveLength(0);
  });

  it("picks up new files from the watcher", async () => {
    const app = await openApp(root);
    const tree = await screen.findByRole("tree");
    await app.external("Fresh.md", "# Fresh\n");
    app.platform.emit({ paths: ["Fresh.md"] });
    await waitFor(() => expect(within(tree).getByRole("treeitem", { name: "Fresh" })).toBeTruthy());
  });

  it("coalesces a burst of events into one reconcile and does a full one on rescan", async () => {
    const { Vault } = await import("@thoth/local-store");
    const spy = vi.spyOn(Vault.prototype, "reconcile");
    const app = await openApp(root);
    await screen.findByRole("tree");
    spy.mockClear();
    for (let i = 0; i < 8; i++) app.platform.emit({ paths: [`x${i}.md`] });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 80));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0] ?? {}).toEqual({});
    spy.mockClear();
    app.platform.emit({ rescan: true });
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ full: true }));
  });
});

describe("read-only pages", () => {
  it("shows non-UTF-8 files read-only, explains why, and never writes", async () => {
    await seed(root, { "Binary.md": Buffer.from([0x41, 0xff, 0xfe, 0x42, 0x0a]) });
    const guard = guardWrites();
    const app = await openApp(root);
    await app.user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: "Binary" }));
    const box = await editorBox();
    await waitFor(() => expect(screen.getByText(/not valid UTF-8/i)).toBeTruthy());
    expect(box.getAttribute("contenteditable")).toBe("false");
    box.focus();
    await app.user.keyboard("typing");
    await app.user.keyboard("{Meta>}s{/Meta}");
    await new Promise((r) => setTimeout(r, 60));
    expect(guard.calls).toHaveLength(0);
    expect(await readFile(join(root, "Binary.md"))).toEqual(Buffer.from([0x41, 0xff, 0xfe, 0x42, 0x0a]));
  });
});
