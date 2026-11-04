/**
 * ADR-0051 rules 14, 15 and 17 on the real desktop UI (Chromium, real Rust host, the e2e bridge): the Timeline of a
 * Private Space lists its pages by day from the index, filters by tags (all must match) and says the count, Dated puts
 * a page under its frontmatter `date` and a daily note under its name, a row opens its page, and nothing is written.
 * Opened from the sidebar and from the command palette. It passes the accessibility check.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startBridge, type Bridge } from "./bridge.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";
import { pickSpace } from "./pick-space.ts";

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;

const FILES: Record<string, string> = {
  "Plan.md": "---\ntags: [work, plan]\n---\n# Plan\n",
  "Work/Notes.md": "# Notes\n\nAbout #work.\n",
  "Trip.md": "---\ndate: 2024-12-24\ntags: home\n---\n# Trip\n",
  "Daily/2024-06-01.md": "# 2024-06-01\n",
};

test.beforeAll(async () => {
  built = await buildAll();
});

test.beforeEach(async ({ page, context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-timeline-")));
  vault = join(scratch, "Vault");
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(vault, path)), { recursive: true });
    await writeFile(join(vault, path), text);
  }
  // Every page edited two days ago at noon, except Plan (now): Edited shows two days.
  const old = new Date();
  old.setDate(old.getDate() - 2);
  old.setHours(12, 0, 0, 0);
  for (const path of ["Work/Notes.md", "Trip.md", "Daily/2024-06-01.md"]) await utimes(join(vault, path), old, old);
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, dataDir: join(scratch, "data") } });
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(bridge.url);
  await pickSpace(page);
  await expect(page.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

async function axe(page: Page, ...selectors: string[]) {
  await settled(page);
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  for (const s of selectors) builder = builder.include(s);
  const results = await builder.analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const headings = (page: Page) => page.locator(".timeline h2").allTextContents();

test("Timeline lists Private Space pages by day, filters by tags, shows Dated, and opens a page", async ({ page }) => {
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeVisible();
  await expect(page.getByRole("tab", { selected: true })).toHaveText("Timeline");

  // Edited: Plan today; the rest two days ago, under that date.
  await expect.poll(() => headings(page)).toHaveLength(2);
  expect((await headings(page))[0]).toBe("Today");
  await expect(page.getByRole("list", { name: "Today" }).getByRole("button", { name: /Plan/ })).toBeVisible();
  expect(await axe(page, ".timeline")).toEqual([]);

  // Tags: every selected tag must match; the count is said politely.
  const tags = page.getByRole("group", { name: "Filter by tag" });
  await tags.getByRole("button", { name: "#work" }).click();
  await expect(tags.getByRole("button", { name: "#work" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".timeline [role=status]")).toHaveText("2 pages shown");
  await tags.getByRole("button", { name: "#plan" }).click();
  await expect(page.locator(".timeline [role=status]")).toHaveText("1 page shown");
  await tags.getByRole("button", { name: "Clear tags" }).click();

  // Dated: the frontmatter date and the daily note's name, from the index.
  await page.getByRole("group", { name: "Show pages by" }).getByRole("button", { name: "Dated" }).click();
  await expect(page.getByRole("list", { name: "Tuesday, December 24, 2024" }).getByRole("button", { name: /Trip/ })).toBeVisible();
  await expect(page.getByRole("list", { name: "Saturday, June 1, 2024" }).getByRole("button", { name: /2024-06-01/ })).toBeVisible();
  expect(await axe(page, ".timeline")).toEqual([]);

  // A row opens its page in this tab.
  await page.getByRole("list", { name: "Tuesday, December 24, 2024" }).getByRole("button", { name: /Trip/ }).click();
  await expect(page.getByRole("tab", { selected: true })).toHaveText("Trip");

  // From the command palette too, back to the same single tab.
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search" });
  await expect(palette).toBeVisible();
  await page.keyboard.type("> Open Timeline");
  await expect(palette.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page.getByRole("tab", { selected: true })).toHaveText("Timeline");
  await expect(page.getByRole("tab", { name: "Timeline" })).toHaveCount(1);

  // Listing never wrote a file.
  for (const [path, text] of Object.entries(FILES)) expect(await readFile(join(vault, path), "utf8"), path).toBe(text);
});
