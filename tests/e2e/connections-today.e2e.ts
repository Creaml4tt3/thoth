/**
 * ADR-0050 on the real desktop UI (Chromium, real Rust host, the e2e bridge): Home's Today card makes today's page
 * from `Templates/Daily.md` and opens it, a second click opens the same page, and on another page Connections lists
 * a page that mentions it without a link; one click on Link writes the link into that page's file, and nothing else.
 * Both pass the accessibility check.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startBridge, type Bridge } from "./bridge.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;

test.beforeAll(async () => {
  built = await buildAll();
});

const put = async (path: string, text: string) => {
  await mkdir(dirname(join(vault, path)), { recursive: true });
  await writeFile(join(vault, path), text);
};
const read = (path: string) => readFile(join(vault, path), "utf8");

test.beforeEach(async ({ page, context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-today-")));
  vault = join(scratch, "Vault");
  await put("Templates/Daily.md", "# Daily\n\n## Plan\n\n- [ ] Look at [[Atlas]]\n");
  await put("Atlas.md", "# Atlas\n\nThe project.\n");
  await put("Notes.md", "# Notes\n\nWe talked about atlas over lunch.\n");
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, dataDir: join(scratch, "data") } });
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
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

const current = (page: Page) => page.getByRole("tab", { selected: true });

test("Today makes today's page from the template, and Connections links an unlinked mention", async ({ page }) => {
  // Today, from Home (a new tab).
  await page.keyboard.press("ControlOrMeta+t");
  await expect(page.getByRole("heading", { level: 2, name: "Today" })).toBeVisible();
  const card = page.getByRole("button", { name: /Start today's page/ });
  await expect(card).toBeVisible();
  expect(await axe(page, ".home")).toEqual([]);
  await card.click();

  // The page is Daily/<the browser's local date>.md, titled by the date, with the template's text.
  const date = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  await expect(current(page)).toHaveText(date);
  const text = await read(`Daily/${date}.md`);
  expect(text).toMatch(new RegExp(`^---\\nthoth_id: \\S+\\n---\\n# ${date}\\n\\n## Plan\\n\\n- \\[ \\] Look at \\[\\[Atlas\\]\\]\\n$`));

  // A second visit opens the same page; nothing is made again or changed.
  await page.keyboard.press("ControlOrMeta+t");
  await page.getByRole("button", { name: /Open today's page/ }).click();
  await expect(current(page)).toHaveText(date);
  expect(await readdir(join(vault, "Daily"))).toEqual([`${date}.md`]);
  expect(await read(`Daily/${date}.md`)).toBe(text);

  // Atlas: today's page and the template link to it (backlinks); Notes mentions it without a link.
  await page.getByRole("tree", { name: "Pages in this Private Space" }).getByRole("treeitem", { name: "Atlas", exact: true }).click();
  await expect(current(page)).toHaveText("Atlas");
  const panel = page.getByRole("region", { name: "Connections" });
  await expect(panel.getByRole("heading", { name: "Backlinks (2)" })).toBeVisible();
  await expect(panel.getByRole("button", { name: new RegExp(`^${date}`) })).toBeVisible();

  const toggle = panel.getByRole("button", { name: /Unlinked mentions/ });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const link = panel.getByRole("button", { name: "Link the mention in Notes" });
  await expect(link).toBeVisible();
  expect(await axe(page, ".connections")).toEqual([]);
  await link.click();

  await expect(panel.getByRole("status")).toHaveText("Linked in Notes.");
  await expect(link).toBeHidden();
  await expect.poll(() => read("Notes.md")).toBe("# Notes\n\nWe talked about [[Atlas|atlas]] over lunch.\n");
  // Notes is now a backlink, from the index.
  await expect(panel.getByRole("heading", { name: "Backlinks (3)" })).toBeVisible();
  expect(await read("Atlas.md")).toBe("# Atlas\n\nThe project.\n");
});
