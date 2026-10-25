/**
 * The Thoth mascot in the real desktop UI (Chromium, the real Rust host through the dev bridge, the FAKE Claude Code
 * CLI): drag it and let it snap, move it with the keyboard, shrink and expand it, change its settings, then run a task
 * from its bubble, review and apply. axe checks the bubble and Settings → Thoth assistant.
 *
 * It also saves pictures of every state in both versions, light and dark (with reduced motion, so each is the still
 * pose of its state), and a recording of the motion, under tests/.tmp/mascot/ (git-ignored).
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_CLAUDE_DIR } from "../helpers/agent.ts";
import { REPO } from "../ports/harness.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";
import { axe, bubble, layer, mascot, openAssistantSettings, openBubble, openReview, pickOnly, writeAndStart } from "./assistant.ts";

const SHOTS = join(REPO, "tests", ".tmp", "mascot");
const PLAN = "# Plan\n\nWe have a cat.\n";
let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let data: string;
let bridge: Bridge;

test.use({ viewport: { width: 1200, height: 800 } });

test.beforeAll(async () => {
  built = await buildAll();
  await mkdir(SHOTS, { recursive: true });
});

async function launch(page: Page, context: BrowserContext) {
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await expect(page.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();
  await expect(mascot(page)).toBeVisible();
}

test.beforeEach(async ({ page, context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-mascot-")));
  vault = join(scratch, "Vault");
  data = join(scratch, "data");
  await mkdir(join(vault, "Notes"), { recursive: true });
  await writeFile(join(vault, "Notes/Plan.md"), PLAN);
  await writeFile(join(vault, "Diary.md"), "# Diary\n\nA quiet Sunday. The ibis came back to the river.\n");
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, dataDir: data, agentSearchDirs: [FAKE_CLAUDE_DIR] } });
  await launch(page, context);
});

test.afterEach(async ({ context }) => {
  for (const open of context.pages()) await open.close().catch(() => undefined);
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

const box = async (page: Page) => (await mascot(page).boundingBox())!;
const art = (page: Page) => layer(page).locator("svg.mascot-art");

test("drag the mascot, move it with keys, shrink and expand it, change its settings, then run, review and apply", async ({ page }) => {
  // Bottom-right by default, 88px at 100%, below nothing and above the page.
  let b = await box(page);
  expect([Math.round(b.x), Math.round(b.y), Math.round(b.width)]).toEqual([1200 - 24 - 88, 800 - 24 - 88, 88]);
  await expect(art(page)).toHaveAttribute("data-facing", "left");

  // Drag it to the left half, mid-height: it snaps to the left edge and turns to face the middle.
  await page.mouse.move(b.x + 44, b.y + 44);
  await page.mouse.down();
  await page.mouse.move(600, 500, { steps: 6 });
  await page.mouse.move(300, 420, { steps: 6 });
  await expect(layer(page)).toHaveAttribute("data-dragging", "");
  await page.mouse.up();
  await expect(bubble(page)).toBeHidden();
  await expect(art(page)).toHaveAttribute("data-facing", "right");
  await expect.poll(async () => Math.round((await box(page)).x)).toBe(16);
  b = await box(page);
  expect(Math.round(b.y)).toBe(420 - 44);

  // The keyboard moves it too (focus ring visible), without animation.
  await mascot(page).focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(async () => Math.round((await box(page)).y)).toBe(420 - 44 - 16 - 64);
  const ring = await mascot(page).evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(ring).toBe("solid");

  // Shrink with its button, expand with the shortcut; the state stays.
  await mascot(page).hover();
  await layer(page).getByRole("button", { name: "Shrink the assistant" }).click();
  await expect(art(page)).toHaveAttribute("data-version", "compact");
  await expect(art(page)).toHaveAttribute("data-state", "idle");
  await expect.poll(async () => Math.round((await box(page)).width)).toBe(52);
  await page.keyboard.press("ControlOrMeta+Shift+J");
  await expect(art(page)).toHaveAttribute("data-version", "full");

  // Settings: calm motion, 120%, snapping off; the mascot follows at once.
  const settings = await openAssistantSettings(page);
  const section = settings.getByRole("region", { name: "Mascot" });
  await section.getByRole("radio", { name: "Calm" }).check();
  await section.getByRole("slider", { name: "Scale" }).fill("120");
  await section.getByRole("switch", { name: "Snap to the edges" }).uncheck();
  await expect(art(page)).toHaveAttribute("data-motion", "calm");
  await expect.poll(async () => Math.round((await box(page)).width)).toBe(Math.round(88 * 1.2));
  await axe(page, '[data-testid="assistant-settings"]');
  await section.getByRole("button", { name: "Reset position" }).click();
  await expect.poll(async () => Math.round((await box(page)).x)).toBe(1200 - 24 - Math.round(88 * 1.2));

  // Run a task from the bubble, review it, apply it.
  const tree = page.getByRole("tree", { name: "Pages in this Private Space" });
  await tree.getByText("Notes", { exact: true }).click();
  await tree.getByText("Plan", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: /page content/i })).toBeVisible();
  const b2 = await openBubble(page);
  await expect(b2.getByRole("list", { name: "Context" })).toContainText("Plan");
  await axe(page, "#mascot-bubble");
  await pickOnly(page, ["Plan"]);
  await writeAndStart(page, "Make it a dog.\n@sleep 400\n@replace Notes/Plan.md :: cat => dog\n");
  await expect(art(page)).toHaveAttribute("data-state", "working");
  await expect(mascot(page)).toHaveAccessibleName("Thoth assistant, working");
  await expect(art(page)).toHaveAttribute("data-state", "review", { timeout: 15_000 });
  await axe(page, "#mascot-bubble");
  const review = await openReview(page);
  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe(PLAN);
  await review.getByRole("button", { name: "Apply 1 change" }).click();
  await expect(page.getByRole("region", { name: "Result" })).toContainText("Applied");
  await expect(art(page)).toHaveAttribute("data-state", "done");
  expect(await readFile(join(vault, "Notes/Plan.md"), "utf8")).toBe("# Plan\n\nWe have a dog.\n");
  await expect(art(page)).toHaveAttribute("data-state", "idle", { timeout: 6_000 });
});

/** Puts the window in light or dark (the theme attribute the tokens key off). */
const theme = (page: Page, dark: boolean) => page.evaluate((night) => document.documentElement.setAttribute("data-theme", night ? "night" : "light"), dark);

/** Both versions in both themes, as the mascot is now. Shots are cropped to the corner: the mascot and its bubble. */
async function shootAll(page: Page, name: string) {
  for (const version of ["full", "compact"] as const) {
    if ((await art(page).getAttribute("data-version")) !== version) await page.keyboard.press("ControlOrMeta+Shift+J");
    await expect(art(page)).toHaveAttribute("data-version", version);
    for (const dark of [false, true]) {
      await theme(page, dark);
      await page.screenshot({ path: join(SHOTS, `app-${name}-${version}-${dark ? "dark" : "light"}.png`), clip: { x: 640, y: 100, width: 560, height: 700 } });
    }
  }
  await theme(page, false);
  if ((await art(page).getAttribute("data-version")) !== "full") await page.keyboard.press("ControlOrMeta+Shift+J");
}

test("every state, in both versions, light and dark", async ({ page }) => {
  test.setTimeout(240_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("tree", { name: "Pages in this Private Space" }).getByText("Diary").click();
  await page.getByRole("textbox", { name: /page content/i }).click();
  await page.mouse.move(10, 400);
  await expect(art(page)).toHaveAttribute("data-state", "idle");
  // Shortcuts land on the page, not the editor: Auto size would shrink it while typing.
  await page.getByRole("tree", { name: "Pages in this Private Space" }).getByText("Diary").focus();
  await shootAll(page, "idle");

  await openBubble(page);
  await expect(art(page)).toHaveAttribute("data-state", "listening");
  await bubble(page).getByRole("textbox", { name: "Task" }).fill("Make the diary entry a little warmer.");
  await bubble(page).getByRole("heading", { name: "Ask Thoth" }).click();
  await shootAll(page, "listening");

  await pickOnly(page, ["Plan"]);
  await bubble(page).getByRole("button", { name: "Add context" }).click();
  await writeAndStart(page, "Tidy the plan.\n@replace Notes/Plan.md :: cat => dog\n@hang\n");
  await expect(art(page)).toHaveAttribute("data-state", "working");
  await expect(bubble(page).getByRole("log")).toContainText("Editing Notes/Plan.md");
  await shootAll(page, "working");
  await bubble(page).getByRole("button", { name: "Cancel" }).click();
  await expect(bubble(page).getByRole("button", { name: "New task" })).toBeVisible({ timeout: 15_000 });
  await bubble(page).getByRole("button", { name: "New task" }).click();

  await writeAndStart(page, "Tidy the plan.\n@replace Notes/Plan.md :: cat => dog\n");
  await expect(art(page)).toHaveAttribute("data-state", "review", { timeout: 15_000 });
  await shootAll(page, "review");
  await page.keyboard.press("Escape");
  await shootAll(page, "review-closed");

  // With a review waiting, a click on the mascot opens it.
  await mascot(page).click();
  const review = page.getByRole("region", { name: "Review the changes" });
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "Apply 1 change" }).click();
  await expect(art(page)).toHaveAttribute("data-state", "done");
  await shootAll(page, "done");

  await mascot(page).click();
  await bubble(page).getByRole("button", { name: "New task" }).click();
  await pickOnly(page, ["Plan"]);
  await bubble(page).getByRole("button", { name: "Add context" }).click();
  await writeAndStart(page, "@not-logged-in\n");
  await expect(art(page)).toHaveAttribute("data-state", "error", { timeout: 15_000 });
  await shootAll(page, "error");
  await bubble(page).getByRole("button", { name: "New task" }).click();
  await page.keyboard.press("Escape");

  // In the background, it rests.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(art(page)).toHaveAttribute("data-state", "sleeping");
  await shootAll(page, "sleeping");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  // The settings, light and dark.
  await openAssistantSettings(page);
  for (const dark of [false, true]) {
    await theme(page, dark);
    await page.getByRole("region", { name: "Mascot" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, `app-settings-mascot-${dark ? "dark" : "light"}.png`) });
    await page.getByRole("region", { name: "Agents" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, `app-settings-agents-${dark ? "dark" : "light"}.png`) });
    await page.getByRole("region", { name: "Usage" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, `app-settings-usage-${dark ? "dark" : "light"}.png`) });
  }
});

test("a recording of the motion: the states and the morph", async ({ browser }) => {
  test.setTimeout(180_000);
  const videos = join(scratch, "video");
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, recordVideo: { dir: videos, size: { width: 1200, height: 800 } } });
  const page = await context.newPage();
  await launch(page, context);
  await page.getByRole("tree", { name: "Pages in this Private Space" }).getByText("Diary").click();
  await page.waitForTimeout(2500); // idle: the bob and a blink
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("ControlOrMeta+Shift+J"); // the morph, both ways
    await page.waitForTimeout(900);
  }
  await openBubble(page);
  await page.waitForTimeout(1200); // listening
  await pickOnly(page, ["Plan"]);
  await bubble(page).getByRole("button", { name: "Add context" }).click();
  await writeAndStart(page, "Tidy the plan.\n@sleep 3500\n@replace Notes/Plan.md :: cat => dog\n");
  await expect(art(page)).toHaveAttribute("data-state", "review", { timeout: 15_000 });
  await page.waitForTimeout(4500); // needs review: the nudge
  const review = await openReview(page);
  await review.getByRole("button", { name: "Apply 1 change" }).click();
  await page.waitForTimeout(2000); // done: the hop and the sparkle
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.waitForTimeout(2500); // sleeping
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const video = page.video();
  await context.close();
  if (video) await copyFile(await video.path(), join(SHOTS, "motion.webm"));
  expect((await readdir(SHOTS)).includes("motion.webm")).toBe(true);
});
