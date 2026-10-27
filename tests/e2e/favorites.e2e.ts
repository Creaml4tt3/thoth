/**
 * Favorites and pinned tabs (ADR-0027) on the real desktop UI in Chromium against the real Rust host: pages starred from
 * the page's header and the tree's menu, the Favorites section first in the sidebar, opening from it, a rename and a
 * restart; a tab pinned from its menu that moves left and goes compact, that Cmd/Ctrl+W leaves open, that a drag stops at
 * the boundary, that a restart keeps, and that stays pinned in a new window. axe in light and dark.
 *
 * Pictures (light and dark) go to tests/.tmp/favorites/.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "../ports/harness.ts";
import { axe } from "./assistant.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { startDrag } from "./drag.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";

const SHOTS = join(REPO, "tests", ".tmp", "favorites");
let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;

test.beforeAll(async () => {
  built = await buildAll();
  await mkdir(SHOTS, { recursive: true });
});

test.beforeEach(async ({ context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-favorites-")));
  vault = join(scratch, "Vault");
  await mkdir(join(vault, "Projects"), { recursive: true });
  for (const name of ["Alpha", "Beta", "Gamma"]) await writeFile(join(vault, `${name}.md`), `# ${name}\n\nThe ${name.toLowerCase()} page.\n`);
  await writeFile(join(vault, "Projects", "Roadmap.md"), "# Roadmap\n\nWhat comes next.\n");
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, pickSource: join(scratch, "source"), dataDir: join(scratch, "data") } });
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await context.addInitScript(bridge.initScript);
});

test.afterEach(async ({ context }) => {
  for (const p of context.pages()) await p.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

const tabNames = (page: Page) => page.getByRole("tab").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? el.textContent));
const current = (page: Page) => page.getByRole("tab", { selected: true });
const tabBox = (page: Page, name: string): Locator => page.getByRole("tab", { name, exact: true }).locator("xpath=..");
const row = (page: Page, name: string) => page.getByRole("tree", { name: "Pages in this Private Space" }).getByRole("treeitem", { name, exact: true });
const favorites = (page: Page) => page.getByRole("region", { name: "Favorites" });
const favoriteNames = (page: Page) => favorites(page).locator(".fav-item .tree-label").allTextContents();
const sectionNames = (page: Page) => page.locator(".side-section").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
const theme = (page: Page, dark: boolean) => page.evaluate((night) => document.documentElement.setAttribute("data-theme", night ? "night" : "light"), dark);

async function open(page: Page) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  // A Private Space opens on Home (ADR-0029); these tests start on Alpha.
  await expect(current(page)).toHaveText("Home");
  await row(page, "Alpha").click();
  await expect(current(page)).toHaveText("Alpha");
}

async function restart(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
}

test("pages starred from the header and the tree are listed first in the sidebar, open from there, and survive a rename and a restart", async ({ page }) => {
  await open(page);
  await expect(favorites(page)).toHaveCount(0); // hidden while empty
  const star = page.getByRole("button", { name: "Favorite", exact: true });
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => favoriteNames(page)).toEqual(["Alpha"]);
  expect((await sectionNames(page))[0]).toBe("Favorites");

  await page.getByRole("tree", { name: "Pages in this Private Space" }).getByRole("treeitem", { name: "Projects" }).click();
  await row(page, "Roadmap").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Add to Favorites" }).click();
  await expect.poll(() => favoriteNames(page)).toEqual(["Alpha", "Roadmap"]);
  // Stable ids in the vault's record, and in each page's frontmatter (ADR-0003).
  const record = JSON.parse(await readFile(join(vault, ".thoth", "favorites.json"), "utf8")) as { version: number; pages: string[] };
  expect(record.version).toBe(1);
  expect(await readFile(join(vault, "Projects", "Roadmap.md"), "utf8")).toContain(`thoth_id: ${record.pages[1]}`);

  await favorites(page).getByRole("button", { name: /^Roadmap/ }).click();
  await expect(current(page)).toHaveText("Roadmap");
  await expect(favorites(page).getByRole("button", { name: /^Roadmap/ })).toHaveAttribute("aria-current", "page");

  for (const dark of [false, true]) {
    await theme(page, dark);
    await settled(page);
    await axe(page, [".sidebar", ".fav-star"]);
    await page.screenshot({ path: join(SHOTS, `favorites-section-${dark ? "dark" : "light"}.png`), clip: { x: 0, y: 0, width: 1200, height: 360 } });
  }
  await theme(page, false);

  // Renamed in the tree, it keeps its favorite; a restart brings both back in the same order.
  await row(page, "Alpha").focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: /Rename/ });
  await field.fill("Omega");
  await field.press("Enter");
  await expect.poll(() => favoriteNames(page)).toEqual(["Omega", "Roadmap"]);
  await restart(page);
  await expect.poll(() => favoriteNames(page)).toEqual(["Omega", "Roadmap"]);
  expect((await sectionNames(page))[0]).toBe("Favorites");
});

test("a pinned tab moves left and goes compact, Cmd/Ctrl+W leaves it, a drag stops at the boundary, and a restart and a new window keep it", async ({ page, context }) => {
  await open(page);
  for (const name of ["Beta", "Gamma"]) await row(page, name).click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => tabNames(page)).toEqual(["Alpha", "Beta", "Gamma"]);
  await settled(page);

  await page.getByRole("tab", { name: "Gamma" }).click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: /^Pin tab/ }).click();
  await expect.poll(() => tabNames(page)).toEqual(["Gamma, pinned", "Alpha", "Beta"]);
  const pinned = page.getByRole("tab", { name: "Gamma, pinned" });
  await expect(pinned).toHaveText("Ga");
  const box = (await tabBox(page, "Gamma, pinned").boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(28);
  expect(box.width).toBeLessThan(60);
  await expect(tabBox(page, "Gamma, pinned").locator(".tab-close")).toHaveCount(0);

  // Cmd/Ctrl+W on it: nothing closes, and the bar says why.
  await pinned.click();
  await page.keyboard.press("ControlOrMeta+w");
  await expect(page.locator(".tab-note")).toHaveText("Pinned tab: unpin it to close it");
  expect(await tabNames(page)).toEqual(["Gamma, pinned", "Alpha", "Beta"]);

  // Beta dragged to the very start stops after the pinned tab (once the note has gone, for clean pictures).
  await expect(page.locator(".tab-note")).toHaveCount(0, { timeout: 5000 });
  await settled(page);
  const drag = await startDrag(page, tabBox(page, "Beta"));
  await drag.moveTo(box.x + 4, box.y + box.height / 2);
  // It stays over the unpinned tabs: the pinned one is neither moved nor covered.
  expect((await tabBox(page, "Beta").boundingBox())!.x).toBeGreaterThanOrEqual(box.x + box.width - 1);
  await expect(tabBox(page, "Gamma, pinned")).not.toHaveAttribute("style", /translateX\((?!0px)/);
  for (const dark of [false, true]) {
    await theme(page, dark);
    await settled(page);
    await page.screenshot({ path: join(SHOTS, `pinned-tab-drag-${dark ? "dark" : "light"}.png`), clip: { x: 260, y: 0, width: 940, height: 120 } });
  }
  await theme(page, false);
  await drag.drop();
  await expect.poll(() => tabNames(page)).toEqual(["Gamma, pinned", "Beta", "Alpha"]);

  for (const dark of [false, true]) {
    await theme(page, dark);
    await page.mouse.move(0, 400);
    await settled(page);
    await axe(page, ".tabstrip");
    await page.screenshot({ path: join(SHOTS, `pinned-tabs-${dark ? "dark" : "light"}.png`), clip: { x: 260, y: 0, width: 940, height: 120 } });
  }
  await theme(page, false);

  await restart(page);
  await expect.poll(() => tabNames(page)).toEqual(["Gamma, pinned", "Beta", "Alpha"]);

  // To a new window from its menu: pinned there too.
  await page.getByRole("tab", { name: "Gamma, pinned" }).click({ button: "right" });
  const opened = context.waitForEvent("page");
  await page.getByRole("menu").getByRole("menuitem", { name: "Move tab to new window" }).click();
  const second = await opened;
  await expect.poll(() => tabNames(second)).toEqual(["Gamma, pinned"]);
  await expect.poll(() => tabNames(page)).toEqual(["Beta", "Alpha"]);
});
