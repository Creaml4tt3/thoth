// @vitest-environment jsdom
/**
 * Preservation properties for the order a drop writes in the Private Space tree: a reorder
 * inside one folder writes that folder's order and nothing else, and renames nothing. The generator is a small seeded PRNG
 * (no property-testing library is installed), so a failure names its seed.
 *
 * The first test drives the real tree with generated drops. The second one checks `reorderInFolder` on its own over
 * generated order records.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEvent, fireEvent } from "@testing-library/react";
import { readOrder, writeOrder, type OrderRecord } from "@thoth/local-store";
import { placeName, reorderInFolder } from "../src/features/shell/arrange.ts";
import { cleanup, openApp, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";

const dirs = tempDirs();
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

type Random = () => number;
function seeded(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: Random, n: number) => Math.floor(r() * n);
const pick = <T,>(r: Random, list: readonly T[]): T => list[int(r, list.length)]!;

/** A drag from `source` onto `target`, with the pointer `at` (0 = top edge, 1 = bottom edge) of the target row. */
function drag(source: HTMLElement, target: HTMLElement, at: number) {
  const dataTransfer = { setData: () => undefined, getData: () => "", effectAllowed: "", dropEffect: "", setDragImage: () => undefined };
  target.getBoundingClientRect = () => ({ top: 0, height: 100, left: 0, width: 200, bottom: 100, right: 200, x: 0, y: 0, toJSON: () => ({}) });
  const over = (type: "dragOver" | "drop") => {
    const event = createEvent[type](target, { dataTransfer });
    Object.defineProperty(event, "clientY", { value: at * 100 });
    fireEvent(target, event);
  };
  fireEvent.dragStart(source, { dataTransfer });
  over("dragOver");
  over("drop");
  fireEvent.dragEnd(source, { dataTransfer });
}

/** Every file under the vault (not `.thoth/`) with its text: a rename or a move would change this. */
async function files(root: string, folder = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
    const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
    if (entry.name === ".thoth") continue;
    if (entry.isDirectory()) Object.assign(out, await files(root, path));
    else out[path] = await readFile(join(root, path), "utf8");
  }
  return out;
}

const FOLDERS = ["", "Docs", "Misc"] as const;
const PAGES: Record<string, string[]> = {
  "": ["Rfour", "Rone", "Rthree", "Rtwo"],
  Docs: ["Dfour", "Done", "Dthree", "Dtwo"],
  Misc: ["Mfour", "Mone", "Mthree", "Mtwo"],
};
const vaultFiles = () => Object.fromEntries(FOLDERS.flatMap((f) => PAGES[f]!.map((t) => [f === "" ? `${t}.md` : `${f}/${t}.md`, `# ${t}\n\nBody of ${t}.\n`])));

describe("reorder in a folder: what a drop writes", () => {
  /**
   * For generated drops of a page before or after another in the same folder (any of three folders, the top level and two
   * open folders), the folder's recorded order is the displayed order with the page at the dropped place; every other
   * folder's record is exactly as it was (missing stays missing); no file is renamed, moved or changed; and a drop that
   * leaves the page where it is writes nothing.
   *
   * **Validates: Requirements 3.2**
   */
  it("a reorder in one folder writes only that folder's order and renames nothing", async () => {
    let writes = 0;
    for (const seedNumber of [1, 2, 3, 4]) {
      const r = seeded(seedNumber);
      const root = await dirs.dir();
      await seed(root, vaultFiles());
      const app = await openApp(root);
      const tree = await screen.findByRole("tree", { name: "Pages in this Private Space" });
      // Open both folders (the tree is built from the vault a moment after it appears, so wait for each to show its pages).
      for (const [folder, first] of [["Docs", "Dfour"], ["Misc", "Mfour"]] as const) {
        const row = await within(tree).findByRole("treeitem", { name: folder });
        await waitFor(() => {
          if (row.getAttribute("aria-expanded") !== "true") fireEvent.click(row);
          expect(within(tree).queryByRole("treeitem", { name: first })).not.toBeNull();
        });
      }
      const untouched = await files(root);

      // What the tree should show, and what the record should say, per folder (names with the extension, folders by name).
      const display: Record<string, string[]> = { "": ["Docs", "Misc", ...PAGES[""]!.map((t) => `${t}.md`)], Docs: PAGES.Docs!.map((t) => `${t}.md`), Misc: PAGES.Misc!.map((t) => `${t}.md`) };
      const record: OrderRecord["folders"] = {};
      const title = (name: string) => name.replace(/\.md$/, "");
      const shownRows = () => [...display[""]!].flatMap((n) => [title(n), ...((n === "Docs" || n === "Misc") ? display[n]!.map(title) : [])]);
      const rows = () => within(tree).getAllByRole("treeitem").map((i) => i.textContent);
      const item = (name: string) => within(tree).getByRole("treeitem", { name });
      const orderOnDisk = async (): Promise<OrderRecord["folders"]> => {
        try {
          return (JSON.parse(await readFile(join(root, ".thoth/order.json"), "utf8")) as OrderRecord).folders;
        } catch {
          return {};
        }
      };

      for (let i = 0; i < 6; i++) {
        const folder = pick(r, FOLDERS);
        const names = display[folder]!.filter((n) => n.endsWith(".md"));
        const source = pick(r, names);
        const target = pick(r, names.filter((n) => n !== source));
        const after = r() < 0.5;
        const where = `seed ${seedNumber}, drop ${i + 1}: ${source} ${after ? "after" : "before"} ${target} in "${folder}"`;

        const rest = display[folder]!.filter((n) => n !== source);
        const index = rest.indexOf(target) + (after ? 1 : 0);
        const noop = display[folder]!.indexOf(source) === index;
        const next = placeName(display[folder]!, source, index);

        drag(item(title(source)), item(title(target)), after ? 0.9 : 0.1);
        if (!noop) {
          writes++;
          display[folder] = next;
          record[folder] = next;
          await waitFor(async () => expect((await orderOnDisk())[folder], where).toEqual(next), { timeout: 5000 });
        }
        await waitFor(() => expect(rows(), where).toEqual(shownRows()));

        // Only the folders that have been reordered have a record, each exactly as it was left; nothing else moved.
        await waitFor(async () => expect(await orderOnDisk(), where).toEqual(record));
        expect(await files(root), where).toEqual(untouched);
      }
      cleanup();
    }
    expect(writes).toBeGreaterThan(10);
  }, 120_000);

  /**
   * `reorderInFolder` over generated order records: the folder's list becomes the siblings with the name at the clamped
   * index, every other folder's list is untouched (same names, same order), and no folder appears or disappears but this one.
   *
   * **Validates: Requirements 3.2**
   */
  it("reorderInFolder changes only the named folder's list", async () => {
    for (let seedNumber = 1; seedNumber <= 200; seedNumber++) {
      const r = seeded(seedNumber);
      const folderNames = ["", "Docs", "Docs/Deep", "Misc", "Other"];
      const has = folderNames.filter(() => r() < 0.6);
      const folders: OrderRecord["folders"] = {};
      for (const f of has) folders[f] = Array.from({ length: int(r, 6) }, (_, i) => `${f.replace(/\W/g, "") || "root"}${i}.md`);
      const stored = new Map<string, unknown>();
      const vault = {
        readRecord: async (path: string) => (stored.has(path) ? structuredClone(stored.get(path)) : undefined),
        writeRecord: async (path: string, value: unknown) => void stored.set(path, structuredClone(value)),
      };
      await writeOrder(vault, { version: 1, folders });
      const before = structuredClone((await readOrder(vault)).folders);

      const folder = pick(r, folderNames);
      const siblings = Array.from({ length: int(r, 6) }, (_, i) => `s${i}.md`);
      const name = r() < 0.5 && siblings.length > 0 ? pick(r, siblings) : "moved.md";
      const index = int(r, 10) - 2; // below 0 and past the end are clamped

      const written = await reorderInFolder(vault, folder, name, siblings, index);
      const after = (await readOrder(vault)).folders;
      expect(written.folders, `seed ${seedNumber}`).toEqual(after);
      expect(after[folder], `seed ${seedNumber}`).toEqual(placeName(siblings, name, index));
      expect(after[folder]).toHaveLength(new Set([...siblings, name]).size);
      for (const other of Object.keys({ ...before, ...after }).filter((f) => f !== folder)) expect(after[other], `seed ${seedNumber}: "${other}"`).toEqual(before[other]);
      expect(Object.keys(after).sort(), `seed ${seedNumber}`).toEqual([...new Set([...Object.keys(before), folder])].sort());
    }
  });
});
