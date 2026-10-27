/**
 * First run (ADR-0032), on the real Rust host in Chromium: a new, empty Private Space gets the Welcome pages (three
 * pages, one in a folder) and opens the Welcome page, which renders every block it has (no "Image not found", no
 * Markdown left over as text); then the tour, by keyboard to Done and by Skip tour, and again from Settings. Light and
 * dark screenshots of the Welcome page and of every step go to tests/.tmp/first-run/ (or $THOTH_SHOTS).
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "../ports/harness.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";

const SHOTS = process.env.THOTH_SHOTS ?? join(REPO, "tests", ".tmp", "first-run");
const WELCOME = join(REPO, "apps", "desktop", "src", "features", "onboarding", "welcome");

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;

test.use({ viewport: { width: 1280, height: 860 } });

test.beforeAll(async () => {
  built = await buildAll();
  await mkdir(SHOTS, { recursive: true });
});

test.beforeEach(async ({ page, context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-first-")));
  vault = join(scratch, "Vault");
  await mkdir(vault);
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, dataDir: join(scratch, "data") } });
  await context.route((url) => !url.href.startsWith(bridge.url) && !url.href.startsWith("blob:") && !url.href.startsWith("data:"), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await page.getByRole("button", { name: /start writing/i }).click();
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

const theme = (page: Page, dark: boolean) => page.evaluate((night) => document.documentElement.setAttribute("data-theme", night ? "night" : "light"), dark);
const tour = (page: Page) => page.locator(".tour");
/** The Welcome page is written and opened, and its tour has started (the host may be slow under a full parallel run). */
async function tourShown(page: Page) {
  await expect(page.getByRole("textbox", { name: /page content/i }).locator("h1").first()).toHaveText("Welcome to Thoth", { timeout: 20_000 });
  await expect(tour(page)).toBeVisible({ timeout: 10_000 });
}

async function expectAccessible(page: Page, selector: string) {
  const results = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function shoot(page: Page, name: string) {
  for (const dark of [false, true]) {
    await theme(page, dark);
    await settled(page);
    await page.screenshot({ path: join(SHOTS, `${name}-${dark ? "dark" : "light"}.png`) });
  }
  await theme(page, false);
}

test("a new Private Space shows the three Welcome pages, and the Welcome page renders every block", async ({ page }) => {
  // The tour waits on top; this test is about the page.
  await tourShown(page);
  await page.keyboard.press("Escape");
  await expect(tour(page)).toHaveCount(0);

  const tree = page.getByRole("tree", { name: "Pages in this Private Space" });
  await expect(tree.getByRole("treeitem", { name: "Welcome to Thoth" })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "Linking pages" })).toBeVisible();
  await tree.getByRole("treeitem", { name: "Getting started" }).click();
  await expect(tree.getByRole("treeitem", { name: "Keyboard shortcuts" })).toBeVisible();
  // On disk, byte for byte the repo's files.
  expect(await readFile(join(vault, "Welcome to Thoth.md"), "utf8")).toBe(await readFile(join(WELCOME, "en", "welcome.md"), "utf8"));
  expect(await readFile(join(vault, "Getting started", "Keyboard shortcuts.md"), "utf8")).toBe(await readFile(join(WELCOME, "en", "shortcuts.md"), "utf8"));

  await tree.getByRole("treeitem", { name: "Welcome to Thoth" }).click();
  const box = page.getByRole("textbox", { name: /page content/i });
  await expect(box.locator("h1").first()).toHaveText("Welcome to Thoth");
  for (const selector of ["h1", "h2", "h3", "ul", "ol", '[data-type="taskList"], ul:has(input[type="checkbox"])', "blockquote", "pre", "hr", "table", "strong", "em", "u", "s", "code", "mark", ".text-color", "a:not(.wikilink)"]) {
    await expect(box.locator(selector).first(), selector).toBeAttached();
  }
  for (const kind of ["toggle", "note", "tip", "warning", "danger", "example"]) await expect(box.locator(`[data-callout="${kind}"]`), kind).toHaveCount(1);
  // The image is the file written next to the page, and it loads.
  const image = page.getByRole("img", { name: "The Thoth ibis", exact: true });
  await expect.poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByText(/Image not found/)).toHaveCount(0);
  // Nothing is kept as raw source, and no Markdown is left over as text outside code.
  await expect(box.locator(".preserved, .inline-raw")).toHaveCount(0);
  const prose = await box.evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("code, pre").forEach((c) => c.remove());
    return copy.textContent ?? "";
  });
  for (const left of ["**", "==", "~~", "[[", "]]", "<u>", "<span", "[!", "](", "| ---"]) expect(prose, left).not.toContain(left);
  // Its links resolve.
  await expect(box.locator('.wikilink[data-state="resolved"]')).toHaveCount(2);
  await expectAccessible(page, ".tab-panel");
  await page.locator(".page-scroll").first().evaluate((el) => el.scrollTo(0, 0));
  await shoot(page, "welcome");
  await page.locator(".page-scroll").first().evaluate((el) => el.scrollTo(0, el.scrollHeight / 2));
  await shoot(page, "welcome-middle");

  await tree.getByRole("treeitem", { name: "Linking pages" }).click();
  await expect(box.locator("h1").first()).toHaveText("Linking pages");
  await expect(box.locator('.wikilink[data-state="resolved"]').first()).toBeVisible();
  await expect(box.locator('.wikilink:not([data-state="resolved"])')).toHaveCount(0);
  await shoot(page, "linking");
});

test("the tour, by keyboard from the first step to Done, light and dark; then it stays away", async ({ page }) => {
  await tourShown(page);
  const progress = (await tour(page).locator(".tour-progress").textContent())!;
  const total = Number(/of (\d+)/.exec(progress)![1]);
  expect(total).toBeGreaterThanOrEqual(6);
  const titles: string[] = [];
  for (let step = 1; step <= total; step++) {
    await expect(tour(page).locator(".tour-progress")).toHaveText(`${step} of ${total}`);
    const title = (await tour(page).locator("h2").textContent())!;
    titles.push(title);
    // Focus is in the popover; the control is ringed, described by the step, and the popover is inside the window.
    await expect(tour(page).getByRole("button", { name: step === total ? "Done" : "Next" })).toBeFocused();
    const anchor = page.locator("[data-tour-anchor]");
    await expect(anchor).toHaveCount(1);
    expect((await anchor.getAttribute("aria-describedby"))!.split(" ")).toContain(await tour(page).locator(".tour-body").getAttribute("id"));
    const box = (await tour(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
    expect(box.y + box.height).toBeLessThanOrEqual(860);
    if (step === 1) await expectAccessible(page, ".tour");
    await shoot(page, `tour-${step}`);
    await page.keyboard.press("Enter");
  }
  expect(titles.slice(0, 6)).toEqual(["Your pages", "New page, new folder, import", "Search and commands", "Write in blocks", "Tabs", "Private Spaces"]);
  await expect(tour(page)).toHaveCount(0);
  await expect(page.locator("[data-tour-anchor]")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("thoth.desktop.tour"))).toBe("finished");
  // Every key went to the tour, none to the page: the Welcome page is unchanged on disk.
  await page.keyboard.press("ControlOrMeta+s");
  expect(await readFile(join(vault, "Welcome to Thoth.md"), "utf8")).toBe(await readFile(join(WELCOME, "en", "welcome.md"), "utf8"));
  // Reloaded, the tour does not come back.
  await page.reload();
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect(page.getByRole("textbox", { name: /page content/i })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await expect(tour(page)).toHaveCount(0);
});

test("Skip tour ends it at once; Settings shows it again", async ({ page }) => {
  await tourShown(page);
  await page.keyboard.press("Enter");
  await expect(tour(page).locator(".tour-progress")).toHaveText(/^2 of/);
  await tour(page).getByRole("button", { name: "Skip tour" }).click();
  await expect(tour(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("thoth.desktop.tour"))).toBe("skipped");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Show the tour again" }).click();
  await expect(tour(page)).toBeVisible();
  await expect(tour(page).locator("h2")).toHaveText("Your pages");
  await expect(tour(page).getByRole("button", { name: "Next" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(tour(page)).toHaveCount(0);
});
