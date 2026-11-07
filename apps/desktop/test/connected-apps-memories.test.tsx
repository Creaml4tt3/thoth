// @vitest-environment jsdom
/**
 * Agents' memory (ADR-0052) in the desktop app, against a fake host: the bell's entry when an app saves memories
 * without review ("Claude Code saved 1 memory"), the Memories view (by kind, with the app, the date, the inferred and
 * check-it hints, a filter by app), opening a memory as a page, and Undo of a save and of a change, never over a
 * memory changed since.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryHistoryText } from "@thoth/platform";
import { MEMORY_README_TEXT } from "@thoth/local-store";
import { axeViolations } from "../../../tests/helpers/axe.ts";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs, type NodePlatform } from "./support/node-platform.ts";
import { FakeConnectedApps } from "./support/connected-apps.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const TEA = "---\nkind: preference\ntitle: Tea, not coffee\nsource: Claude Code\nupdated: 2026-11-05T10:00:00+07:00\nupdated_by: Claude Code\ncertainty: inferred\n---\nPrefers tea.\n";
const TEA_BEFORE = TEA.replace("Prefers tea.", "Prefers coffee.");
const PLAN = "---\nkind: work\ntitle: The launch plan\nsource: Cursor\nupdated: 2025-01-02T10:00:00+07:00\ncertainty: stated\n---\nLaunch in March.\n";

const dirs = tempDirs();
let root: string;
let apps: FakeConnectedApps;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  apps = new FakeConnectedApps();
  apps.state = { ...apps.state, enabled: true, listening: true, apps: [{ name: "Claude Code", allowed: true, decidedAt: "2026-11-02T08:00:00Z", propose: null }] };
  await mkdir(join(root, "Memory"));
  await writeFile(join(root, "Memory/README.md"), MEMORY_README_TEXT);
  await writeFile(join(root, "Memory/tea.md"), TEA);
  await writeFile(join(root, "Memory/launch-plan.md"), PLAN);
});

afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

async function open(): Promise<{ app: Harness; platform: NodePlatform; shown: string }> {
  const platform = createNodePlatform({ vault: root, connectedApps: apps });
  const app = await openApp(root, {}, platform);
  await screen.findByRole("tree");
  const shown = platform.connections[0]!.root;
  apps.state.spaces = [shown];
  return { app, platform, shown };
}

let next = 0;
function write(shown: string, change: Pick<MemoryHistoryText, "action" | "path" | "title" | "before" | "after"> & { app?: string }) {
  const { app, ...rest } = change;
  apps.wrote({
    id: `mem_${(next++).toString(16).padStart(32, "0")}`,
    app: app ?? "Claude Code",
    root: shown,
    space: "Notes",
    pageId: "p1",
    beforeHash: rest.before === null ? null : hash(rest.before),
    afterHash: rest.after === null ? null : hash(rest.after),
    createdAt: "2026-11-05T03:00:00Z",
    ...rest,
  });
}

const bell = () => screen.getByRole("button", { name: /^Notifications/ });
const onDisk = (path: string) => readFile(join(root, path), "utf8").catch(() => null);

async function fromBell(app: Harness, title: RegExp) {
  await waitFor(() => expect(bell().getAttribute("aria-label")).toMatch(/unread/));
  await app.user.click(bell());
  await app.user.click(await screen.findByRole("button", { name: title }));
  return within(await screen.findByRole("dialog", { name: "Memories" }));
}

describe("Agents' memory", () => {
  it("is told under the bell, and listed by kind with the app, the date and the hints", async () => {
    const { app, shown } = await open();
    write(shown, { action: "created", path: "Memory/tea.md", title: "Tea, not coffee", before: null, after: TEA });
    // Another Private Space's memory is not this window's to tell.
    write("/elsewhere", { action: "created", path: "Memory/x.md", title: "X", before: null, after: "x" });
    const view = await fromBell(app, /Claude Code saved 1 memory/);

    const preferences = within(await view.findByRole("region", { name: "Preferences" }));
    expect(preferences.getByRole("button", { name: "Tea, not coffee" })).toBeTruthy();
    expect(preferences.getByText("Inferred")).toBeTruthy();
    const work = within(view.getByRole("region", { name: "Work in progress" }));
    expect(work.getByText(/^Cursor · updated/)).toBeTruthy();
    expect(work.getByText(/days ago: check it is still true/)).toBeTruthy();
    expect(view.queryByRole("region", { name: "People" })).toBeNull();

    // Filtered by app.
    await app.user.selectOptions(view.getByRole("combobox", { name: "App" }), "Cursor");
    expect(view.queryByRole("region", { name: "Preferences" })).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);

    // A memory opens as a page.
    await app.user.selectOptions(view.getByRole("combobox", { name: "App" }), "");
    await app.user.click(view.getByRole("button", { name: "Tea, not coffee" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Memories" })).toBeNull());
    expect(await screen.findByRole("tab", { name: /tea/i, selected: true })).toBeTruthy();
  });

  it("undoes a save into the Trash, and a change back to the earlier text, never over an edit since", async () => {
    const { app, platform, shown } = await open();
    await writeFile(join(root, "Memory/new.md"), "---\nkind: note\ntitle: New one\n---\nA new note.\n");
    write(shown, { action: "created", path: "Memory/new.md", title: "New one", before: null, after: "---\nkind: note\ntitle: New one\n---\nA new note.\n" });
    write(shown, { action: "updated", path: "Memory/tea.md", title: "Tea, not coffee", before: TEA_BEFORE, after: TEA });
    const view = await fromBell(app, /Claude Code saved 2 memories/);
    const recent = within(await view.findByRole("region", { name: "Recent changes" }));

    await app.user.click(recent.getByRole("button", { name: "Undo the change to New one" }));
    await waitFor(() => expect(platform.trashed).toEqual(["Memory/new.md"]));
    expect(await view.findByText("Undid the change to New one.")).toBeTruthy();

    const tea = recent.getByRole<HTMLButtonElement>("button", { name: "Undo the change to Tea, not coffee" });
    await waitFor(() => expect(tea.disabled).toBe(false));
    await app.user.click(tea);
    await waitFor(async () => expect(await onDisk("Memory/tea.md")).toBe(TEA_BEFORE));
    // Both put back: nothing left to undo.
    await waitFor(() => expect(recent.queryByRole("button", { name: /^Undo/ })).toBeNull());
    expect(recent.getAllByText("Changed since")).toHaveLength(2);
  });

  it("does not undo a memory edited since the app wrote it", async () => {
    const { app, shown } = await open();
    write(shown, { action: "updated", path: "Memory/tea.md", title: "Tea, not coffee", before: TEA_BEFORE, after: TEA.replace("Prefers tea.", "Prefers green tea.") });
    const view = await fromBell(app, /Claude Code saved 1 memory/);
    expect(within(await view.findByRole("region", { name: "Recent changes" })).getByText("Changed since")).toBeTruthy();
    expect(await onDisk("Memory/tea.md")).toBe(TEA);
  });

  it("opens from Settings → Connected apps", async () => {
    const { app } = await open();
    await app.user.click(screen.getAllByRole("button", { name: "Settings" })[0]!);
    const section = within(await screen.findByTestId("connected-apps-settings"));
    await app.user.click(section.getByRole("button", { name: "Show memories" }));
    const view = within(await screen.findByRole("dialog", { name: "Memories" }));
    expect(view.getByText(/kept as pages in Memory\//)).toBeTruthy();
    expect(await view.findByRole("region", { name: "Preferences" })).toBeTruthy();
    expect(view.queryByRole("region", { name: "Recent changes" })).toBeNull();
  });
});
