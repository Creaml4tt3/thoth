/**
 * Getting around on the real desktop UI (Chromium, real Rust host, the e2e bridge): the logo back to the Private Space
 * picker and in again with the same tabs (ADR-0029, amendment of 2026-10-28), a new tab, the whole sidebar hidden and shown, and Show in Finder for a page or folder through the host's own path checks. Each view
 * passes the accessibility check in light and dark, and is pictured.
 *
 * SHOTS=<dir> changes where the pictures go (default tests/.tmp/batch2, which git ignores).
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO } from "../ports/harness.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;
const revealed: unknown[] = [];
const SHOTS = process.env["SHOTS"] ?? join(REPO, "tests", ".tmp", "batch2");

test.beforeAll(async () => {
  built = await buildAll();
});

const put = async (path: string, text = `# ${path.replace(/^.*\//, "").replace(/\.md$/, "")}\n`) => {
  await mkdir(dirname(join(vault, path)), { recursive: true });
  await writeFile(join(vault, path), text);
};

test.beforeEach(async ({ page, context }) => {
  revealed.length = 0;
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-around-")));
  vault = join(scratch, "Vault");
  await mkdir(vault);
  for (const path of ["Alpha.md", "Beta.md", "Projects/Plan.md", "Projects/Roadmap.md"]) await put(path);
  bridge = await startBridge({
    dist: built.dist,
    bridgeDir: built.bridgeDir,
    host: { binary: built.binary, pickVault: vault, dataDir: join(scratch, "data"), onHostEvent: (event, payload) => event === "vault.revealed" && revealed.push(payload) },
  });
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

const row = (page: Page, name: string) => page.getByRole("tree", { name: "Pages in this Private Space" }).getByRole("treeitem", { name, exact: true });
const current = (page: Page) => page.getByRole("tab", { selected: true });
const axe = async (page: Page, ...include: string[]) => {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]);
  for (const selector of include) builder = builder.include(selector);
  const bad = (await builder.analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  return bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};

test("the whole sidebar hides with Cmd/Ctrl+\\ and its button: the page takes the width, nothing in it is reachable, and it comes back", async ({ page }) => {
  await row(page, "Alpha").click();
  await expect(current(page)).toHaveText("Alpha");
  const sidebar = page.locator("aside.sidebar");
  await sidebar.getByRole("button", { name: "Hide sidebar" }).click();
  const show = page.getByRole("button", { name: "Show sidebar" });
  await expect(show).toBeFocused();
  await settled(page);
  await expect(sidebar).toHaveAttribute("inert", "");
  expect(await page.locator(".main").evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(1200);
  await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveCount(0);
  // Tab from the Show button never lands in the hidden sidebar.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("aside.sidebar")))).toBe(false);
  }
  await page.locator(".page-scroll, [role=textbox]").first().click();
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  await settled(page);
  await expect(sidebar).not.toHaveAttribute("inert", "");
  expect(await sidebar.evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(260);
  // Remembered for this Private Space.
  await show.or(sidebar.getByRole("button", { name: "Hide sidebar" })).first().click();
  await page.reload();
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
});

test("Show in Finder on a page and a folder asks the host for that entry, under the Private Space's folder", async ({ page }) => {
  const mac = await page.evaluate(() => /Mac OS X|Macintosh/.test(navigator.userAgent));
  const name = mac ? "Show in Finder" : /^Show in /;
  await row(page, "Projects").click({ button: "right" });
  await page.getByRole("menuitem", { name }).click();
  await expect.poll(() => revealed).toEqual([{ root: vault, entry: join(vault, "Projects") }]);
  await row(page, "Projects").click();
  await row(page, "Plan").click({ button: "right" });
  await page.getByRole("menuitem", { name }).click();
  await expect.poll(() => revealed.length).toBe(2);
  expect(revealed[1]).toEqual({ root: vault, entry: join(vault, "Projects", "Plan.md") });
});

for (const scheme of ["light", "dark"] as const) {
  test(`the logo goes back to the picker and the Private Space comes back as it was; the picker, a new tab, the hidden sidebar and the tree's menu pass the accessibility check and are shown in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await mkdir(SHOTS, { recursive: true });
    // Nothing was open: the first page. Beta in a second tab, with an edit not yet written.
    await expect(current(page)).toHaveText("Alpha");
    await row(page, "Beta").click({ modifiers: ["ControlOrMeta"] });
    await expect(current(page)).toHaveText("Beta");
    const editor = page.getByRole("textbox", { name: /page content/i });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Written before leaving.");

    // The logo: the edit is written, and the picker lists this Private Space first.
    await page.locator("aside.sidebar").getByRole("button", { name: "Thoth, back to Private Spaces" }).click();
    const choose = page.getByRole("button", { name: /choose or create a private space/i });
    await expect(choose).toBeFocused();
    await expect(page.getByRole("tablist")).toHaveCount(0);
    expect(await readFile(join(vault, "Beta.md"), "utf8")).toContain("Written before leaving.");
    const recent = page.getByRole("region", { name: "Recent" }).getByRole("button");
    await expect(recent.first()).toContainText("Vault");
    await settled(page);
    expect(await axe(page)).toEqual([]);
    await page.screenshot({ path: join(SHOTS, `picker-after-leaving-${scheme}.png`) });

    // In again: the same tabs, Beta current, with the edit.
    await recent.first().click();
    await expect.poll(() => page.getByRole("tab").allTextContents()).toEqual(["Alpha", "Beta"]);
    await expect(current(page)).toHaveText("Beta");
    await expect(editor).toContainText("Written before leaving.");

    // A new tab is empty and says how to open a page.
    await page.keyboard.press("ControlOrMeta+t");
    await expect(page.getByRole("heading", { level: 1, name: "New tab" })).toBeVisible();
    await page.mouse.move(1100, 700);
    await settled(page);
    expect(await axe(page, ".tab-panel", ".tabstrip", ".ws")).toEqual([]);
    await page.screenshot({ path: join(SHOTS, `new-tab-${scheme}.png`) });
    await page.locator("aside.sidebar .ws-home").focus();
    await page.screenshot({ path: join(SHOTS, `logo-focus-${scheme}.png`), clip: { x: 0, y: 0, width: 600, height: 60 } });

    // The sidebar hidden: the Show button and the house (back to Private Spaces) at the start of the tab bar.
    await page.keyboard.press("ControlOrMeta+Backslash");
    await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
    await page.mouse.move(600, 600);
    await settled(page);
    expect(await axe(page, ".tabstrip")).toEqual([]);
    await page.screenshot({ path: join(SHOTS, `sidebar-hidden-${scheme}.png`) });
    await page.getByRole("button", { name: "Show sidebar" }).focus();
    await page.screenshot({ path: join(SHOTS, `tabbar-start-${scheme}.png`), clip: { x: 0, y: 0, width: 600, height: 60 } });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();

    // The tree's menu with Show in Finder.
    await row(page, "Projects").click();
    await row(page, "Plan").click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await settled(page);
    await page.screenshot({ path: join(SHOTS, `reveal-menu-${scheme}.png`), clip: { x: 0, y: 0, width: 600, height: 520 } });
    await page.keyboard.press("Escape");
  });
}
