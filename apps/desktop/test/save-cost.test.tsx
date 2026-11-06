// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlDriver, VaultFs } from "@thoth/local-store";
import { caretAtEnd, cleanup, editorBox, openApp, paragraph, screen, waitFor, within } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { ALPHA, seed } from "./support/fixtures.ts";

/**
 * What one save costs the whole app in port calls, with the page open and the sidebar shown: the save, the watcher's
 * event for it, and every view that asks again afterwards. On desktop each call is a round trip to the host, so this
 * must not grow with the Private Space.
 */

const PAGES = 120;
const dirs = tempDirs();
let root: string;
let calls: string[] = [];

function counted<T extends object>(target: T, prefix: string): T {
  return new Proxy(target, {
    get(t, key, receiver) {
      const value = Reflect.get(t, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(`${prefix}.${String(key)} ${typeof args[0] === "string" ? args[0].slice(0, 60) : ""}`);
        return value.apply(t, args);
      };
    },
  });
}

/** Resolves once no port call has been made for `quietMs`. */
async function settled(quietMs = 150): Promise<void> {
  for (;;) {
    const before = calls.length;
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    if (calls.length === before) return;
  }
}

beforeEach(async () => {
  root = await dirs.dir();
  const files: Record<string, string> = { "Alpha.md": ALPHA };
  for (let i = 0; i < PAGES; i++) files[`folder-${i % 12}/sub-${i % 3}/Page ${i}.md`] = `# Page ${i}\n\nText [[Page ${(i + 7) % PAGES}]] and [[Alpha]].\n`;
  await seed(root, files);
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

describe("the cost of one save in the app", () => {
  it("does not walk the Private Space or redraw twice", async () => {
    const platform = createNodePlatform({ vault: root });
    const open = platform.openVault.bind(platform);
    platform.openVault = async (r) => {
      const connection = await open(r);
      return { ...connection, fs: counted<VaultFs>(connection.fs, "fs"), sql: counted<SqlDriver>(connection.sql, "sql") };
    };
    const app = await openApp(root, {}, platform);
    const tree = await screen.findByRole("tree");
    await app.user.click(within(tree).getByRole("treeitem", { name: "Alpha" }));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("First paragraph stays exactly."));
    await settled();

    calls = [];
    const before = await app.read("Alpha.md");
    box.focus();
    caretAtEnd(paragraph(box, "First paragraph stays exactly."));
    await app.user.keyboard("!!");
    await app.user.keyboard("{Meta>}s{/Meta}");
    await waitFor(async () => expect(await app.read("Alpha.md")).not.toBe(before));
    // The watcher's event for that save, as the host sends it.
    platform.emit({ paths: ["Alpha.md"] });
    await settled();

    const by = (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;
    const summary = { total: calls.length, walks: by("fs.list") + by("fs.scan"), stat: by("fs.stat"), read: by("fs.read"), sql: by("sql.") };
    console.log(`one save in the app, ${PAGES} pages:`, JSON.stringify(summary));
    // The save and the watcher's event walk nothing; the views that list folders after it ask once each (the sidebar
    // and the link lookup), in one call each. Before 0.8.0 this was 125 lists and 134 stats for these 120 pages.
    expect(by("fs.list")).toBe(0);
    expect(by("fs.scan")).toBeLessThanOrEqual(2);
    // Not one stat per page: what is left is the page itself and the views' queries.
    expect(summary.stat).toBeLessThan(20);
    expect(summary.total).toBeLessThan(150);
  });
});
