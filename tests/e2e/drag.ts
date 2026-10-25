import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Real pointer drags for the page trees: `page.mouse` down, move in small steps, up. Chromium turns that into a real
 * HTML5 drag (dragstart, dragenter, dragover, drop, dragend), so the app sees what a person's mouse produces.
 */

/**
 * The box of `target` once it has stopped moving: read `getBoundingClientRect()` in the page on each animation frame until
 * two frames in a row agree (at most 60 frames, then the last read). A row that is still sliding (a folder opening above
 * it) would otherwise be measured, and pressed, where it is no longer. Costs two frames when the row is at rest.
 */
async function stableBox(target: Locator): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const box = await target.evaluate(async (el) => {
    const read = () => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let last = read();
    for (let i = 0; i < 60; i++) {
      await frame();
      const now = read();
      if (now.x === last.x && now.y === last.y && now.width === last.width && now.height === last.height) return now;
      last = now;
    }
    return last;
  });
  return box.width > 0 && box.height > 0 ? box : null;
}

/** The pointer at `fraction` (0 top edge, 1 bottom edge) of the row, in page coordinates. */
async function pointAt(target: Locator, fraction: number): Promise<{ x: number; y: number }> {
  const box = await stableBox(target);
  if (!box) throw new Error("row is not on screen");
  return { x: box.x + Math.min(box.width - 4, Math.max(24, box.width / 2)), y: box.y + Math.max(1, Math.min(box.height - 1, box.height * fraction)) };
}

export interface Drag {
  /** Moves the pointer over `target`, `fraction` down the row, in small steps (as a hand does). */
  over(target: Locator, fraction: number, steps?: number): Promise<void>;
  /** Moves the pointer to a page position. */
  moveTo(x: number, y: number, steps?: number): Promise<void>;
  drop(): Promise<void>;
  /** Releases with Escape, which cancels the drag. */
  cancel(): Promise<void>;
}

/** Presses on `source` and moves a few pixels, so the browser starts the drag. */
export async function startDrag(page: Page, source: Locator): Promise<Drag> {
  const from = await pointAt(source, 0.5);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 3 });
  await page.mouse.move(from.x + 12, from.y + 10, { steps: 3 });
  return {
    async over(target, fraction, steps = 14) {
      const to = await pointAt(target, fraction);
      await page.mouse.move(to.x, to.y, { steps });
      // dragover fires on a timer in Chromium, and React renders after it: give both a moment.
      await page.mouse.move(to.x + 1, to.y, { steps: 2 });
    },
    async moveTo(x, y, steps = 14) {
      await page.mouse.move(x, y, { steps });
      await page.mouse.move(x + 1, y, { steps: 2 });
    },
    async drop() {
      await page.mouse.up();
    },
    async cancel() {
      await page.keyboard.press("Escape");
      await page.mouse.up();
    },
  };
}

export const rowByName = (page: Page, name: string): Locator => page.getByRole("treeitem", { name, exact: true });

/** Which rows show a drop indicator right now, as `name: zone`. */
export async function indicators(page: Page): Promise<string[]> {
  return page.locator("[data-drop]").evaluateAll((els) => els.map((el) => `${(el.querySelector(".tree-label") ?? el).textContent?.trim()}: ${el.getAttribute("data-drop")}`));
}

/** The names of the visible rows of the tree, top to bottom. */
export async function rowNames(tree: Locator): Promise<string[]> {
  return tree.evaluate((root) => [...root.querySelectorAll('[role="treeitem"]')].filter((el) => !el.closest("[inert]")).map((el) => (el.querySelector(".tree-label") ?? el).textContent?.trim() ?? ""));
}

/**
 * Records every change of `data-drop` in the page from now on. A drop indicator that flickers (off, then on again with
 * no row change) shows up as an `off` entry between two entries for the same row.
 */
export async function recordIndicators(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __drops: string[] };
    w.__drops = [];
    const read = (): string => [...document.querySelectorAll("[data-drop]")].map((el) => `${(el.querySelector(".tree-label") ?? el).textContent?.trim()}:${el.getAttribute("data-drop")}`).join("|");
    let last = read();
    const record = () => {
      const now = read();
      if (now !== last) w.__drops.push(now === "" ? "off" : now);
      last = now;
    };
    new MutationObserver(record).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-drop"], childList: true });
  });
}

export const recorded = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __drops: string[] }).__drops.slice());

export async function expectIndicator(page: Page, expected: string[]): Promise<void> {
  await expect.poll(() => indicators(page), { message: "drop indicator" }).toEqual(expected);
}
