/**
 * Motion in the real desktop UI (Chromium, real Rust host, the dev bridge): the animations the CSS promises really run, they
 * end, they never take focus or the keyboard with them, they leave nothing hidden-but-focusable behind, they stay out of the
 * text people type, and `prefers-reduced-motion: reduce` turns every one of them off.
 *
 * The other specs run with motion on and stay robust by waiting for what they check (`expect` retries; a check that reads
 * colours first calls `settled`), so no `reducedMotion` override is set in playwright.config.ts.
 *
 * MOTION_CAPTURE=<dir> also records pictures of the key moments (each paused part way through its motion) in light and dark,
 * and a video, into <dir>. It is off by default, so `pnpm e2e` writes nothing outside tests/.tmp.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, type Bridge } from "./bridge.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let bridge: Bridge;

test.beforeAll(async () => {
  built = await buildAll();
});

test.beforeEach(async ({ page, context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-motion-")));
  const vault = join(scratch, "Vault");
  await mkdir(vault);
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, pickSource: join(scratch, "source"), dataDir: join(scratch, "data") } });
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

async function press(page: Page, name: RegExp | string) {
  const button = page.getByRole("button", { name });
  await button.focus();
  await page.keyboard.press("Enter");
}

async function openVault(page: Page) {
  await press(page, /choose or create a private space/i);
  await press(page, /start writing/i);
  await expect(page.getByRole("heading", { name: "Nothing open" })).toBeVisible();
}

async function newPage(page: Page, name: string) {
  await page.keyboard.press("ControlOrMeta+n");
  const dialog = page.getByRole("dialog", { name: "New page" });
  await expect(dialog).toBeVisible();
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
}

/** The names of the animations and transitions still running on elements matching `selector` right now (a finished one holds nothing). */
const running = (page: Page, selector: string) =>
  page.evaluate(
    (css) =>
      document
        .getAnimations()
        .filter((a) => a.playState === "running" || a.pending)
        .filter((a) => (a.effect as KeyframeEffect | null)?.target?.matches?.(css) || (a.effect as KeyframeEffect | null)?.target?.closest?.(css))
        .map((a) => (a instanceof CSSAnimation ? a.animationName : a instanceof CSSTransition ? `transition:${a.transitionProperty}` : "other")),
    selector,
  );

/** The animations on the scrim's own backdrop (its ::before). */
const backdrop = (page: Page, state: "in" | "out") =>
  page.evaluate((s) => document.querySelector(s === "in" ? ".modal-scrim:not([data-state])" : '.modal-scrim[data-state="closing"]')?.getAnimations({ subtree: true }).map((a) => (a instanceof CSSAnimation ? a.animationName : "other")) ?? [], state);

const folderRow = (page: Page, name: string) => page.getByRole("treeitem", { name: new RegExp(`^${name}`) });

test.describe("with motion", () => {
  test("a dialog rises in, and leaves on an inert copy: focus is back at once and the keyboard is not blocked", async ({ page }) => {
    await openVault(page);
    await newPage(page, "Plan");
    await settled(page);

    const opener = page.locator(".search-trigger");
    await opener.focus();
    await page.keyboard.press("Enter");
    const palette = page.getByRole("dialog", { name: "Search" });
    await expect(palette).toBeVisible();
    expect(await running(page, ".modal")).toContain("thoth-modal-in");
    expect(await backdrop(page, "in")).toContain("thoth-fade-in");
    await settled(page);
    expect(await running(page, ".modal")).toEqual([]);

    await page.keyboard.press("Escape");
    // The dialog is gone for the keyboard and for assistive technology in the same moment ...
    await expect(palette).toBeHidden();
    await expect(opener).toBeFocused();
    // ... while a picture of it plays the exit.
    const ghost = page.locator('.modal-scrim[data-state="closing"]');
    expect(await ghost.count()).toBeLessThanOrEqual(1);
    if ((await ghost.count()) === 1) {
      expect(await ghost.getAttribute("aria-hidden")).toBe("true");
      expect(await ghost.getAttribute("inert")).not.toBeNull();
      expect(await ghost.locator('[role="dialog"], [id], [tabindex]').count()).toBe(0);
      expect(await ghost.evaluate((el) => el.contains(document.activeElement))).toBe(false);
    }
    // A shortcut pressed while the picture is still there is not swallowed by it.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(ghost).toHaveCount(0);
  });

  test("folders open and close with a short height change; closing rows are inert; nothing animates before the tree is used", async ({ page }) => {
    await openVault(page);
    await newPage(page, "Archive/Old");
    await newPage(page, "Archive/New");
    await settled(page);

    // The open page's folder opened by itself while nobody had used the tree: no motion.
    const group = page.locator(".tree-collapse");
    await expect(group).toHaveAttribute("data-state", "open");
    expect(await running(page, ".tree-collapse")).toEqual([]);

    // Focus is on a row inside; closing the folder with the mouse moves it to the folder's row. (Folders animate once the
    // tree has been used; a key pressed in it counts.)
    const row = page.getByRole("treeitem", { name: "Old" });
    await row.focus();
    await page.keyboard.press("Shift");
    await folderRow(page, "Archive").evaluate((el) => (el as HTMLElement).click()); // click without moving focus
    await expect(group).toHaveAttribute("data-state", "closed");
    await expect(folderRow(page, "Archive")).toBeFocused();
    expect(await group.locator("ul").getAttribute("inert")).not.toBeNull();
    expect(await group.locator("ul").getAttribute("aria-hidden")).toBe("true");
    await expect(page.getByRole("treeitem", { name: "Old" })).toHaveCount(0); // not exposed while leaving
    expect(await running(page, ".tree-collapse")).toEqual(expect.arrayContaining(["transition:grid-template-rows"]));
    await expect(group).toHaveCount(0); // and gone once it has closed

    await folderRow(page, "Archive").click();
    await expect(group).toHaveAttribute("data-state", "open");
    expect(await running(page, ".tree-collapse")).toEqual(expect.arrayContaining(["transition:grid-template-rows"]));
    await settled(page);
    await expect(page.getByRole("treeitem", { name: "Old" })).toBeVisible();
    // Arrow keys inside the open list work, and do not animate.
    await folderRow(page, "Archive").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("treeitem", { name: "New" })).toBeFocused(); // A to Z: New, Old
  });

  test("tabs: a new tab enters, a closed tab narrows away out of the tab list, the first tabs did not animate", async ({ page }) => {
    await openVault(page);
    await newPage(page, "Plan");
    await settled(page);
    expect(await page.locator(".tab[data-enter]").count()).toBe(0);

    await page.keyboard.press("ControlOrMeta+t");
    await expect(page.getByRole("tab", { selected: true })).toHaveText("New tab");
    expect(await page.locator(".tab[data-enter]").count()).toBe(1);
    expect(await running(page, ".tab")).toContain("thoth-tab-in");
    await settled(page);

    await page.keyboard.press("ControlOrMeta+w");
    await expect(page.getByRole("tab")).toHaveCount(1); // the tab list is right at once
    const leaving = page.locator(".tab[data-leaving]");
    if ((await leaving.count()) === 1) {
      expect(await leaving.getAttribute("aria-hidden")).toBe("true");
      expect(await leaving.getAttribute("inert")).not.toBeNull();
      expect(await leaving.locator("button, [tabindex]").count()).toBe(0);
    }
    await expect(leaving).toHaveCount(0);
  });

  test("changing the theme dissolves the page once; the first paint and a second look never do", async ({ page }) => {
    const dissolving = () => page.evaluate(() => document.getAnimations().filter((a) => ((a.effect as KeyframeEffect | null)?.pseudoElement ?? "").startsWith("::view-transition")).length);
    await openVault(page);
    await newPage(page, "Plan");
    await settled(page);
    expect(await dissolving()).toBe(0);

    await page.keyboard.press("ControlOrMeta+Shift+L"); // system, which is light here, to light
    await settled(page);
    await page.keyboard.press("ControlOrMeta+Shift+L"); // light to dark
    await expect.poll(dissolving, { timeout: 2_000 }).toBeGreaterThan(0);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
    await settled(page);
    expect(await dissolving()).toBe(0);
    // Nothing is left transitioning on the surfaces: hover and typing do not inherit a theme fade.
    expect(await running(page, ".sidebar")).toEqual([]);
    expect(await page.locator("html").getAttribute("data-theme-changing")).toBeNull();
  });

  test("nothing in the page text animates while typing", async ({ page }) => {
    await openVault(page);
    await newPage(page, "Plan");
    await settled(page);
    const editor = page.getByRole("textbox", { name: /page content/i });
    await editor.focus();
    await page.keyboard.type("Typing is never delayed by motion. ".repeat(3), { delay: 5 });
    // Whatever is running (the caret does not count), none of it is on the text.
    expect(await running(page, ".prose")).toEqual([]);
    expect(await running(page, ".page-scroll")).toEqual([]);
    await expect(editor).toContainText("Typing is never delayed by motion.");
  });

  test("the slash menu pops in once from its caret, and its rows do not animate while the filter changes", async ({ page }) => {
    await openVault(page);
    await newPage(page, "Plan");
    const editor = page.getByRole("textbox", { name: /page content/i });
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    const menu = page.locator(".slash-menu");
    await expect(menu).toBeVisible();
    expect(await running(page, ".slash-menu")).toContain("thoth-pop-in");
    await expect(menu).toHaveAttribute("data-side", /top|bottom/);
    await settled(page);
    await page.keyboard.type("hea");
    expect(await running(page, ".slash-menu")).toEqual([]); // typing re-filters; the menu does not pop again
    await page.keyboard.press("Escape");
  });
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("nothing is animated or transitioned, and exits do not wait", async ({ page }) => {
    await openVault(page);
    await newPage(page, "Archive/Old");
    await newPage(page, "Archive/New");
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

    // Dialog: no animation on the dialog or its backdrop, and no picture left behind when it closes.
    await page.locator(".search-trigger").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
    const style = await page.evaluate(() => {
      const modal = document.querySelector(".modal")!;
      const scrim = document.querySelector(".modal-scrim")!;
      return { modal: getComputedStyle(modal).animationName, back: getComputedStyle(scrim, "::before").animationName, move: getComputedStyle(document.querySelector(".tree-item")!).transitionDuration, any: document.getAnimations().length };
    });
    expect(style).toEqual({ modal: "none", back: "none", move: "0s", any: 0 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.locator('.modal-scrim, [data-state="closing"]').count()).toBe(0);

    // Folder: closes and goes at once, with no wrapper left to animate.
    await folderRow(page, "Archive").click();
    await expect(page.locator(".tree-collapse")).toHaveCount(0);
    await folderRow(page, "Archive").click();
    await expect(page.getByRole("treeitem", { name: "Old" })).toBeVisible();
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);

    // Tabs: nothing enters or leaves.
    await page.keyboard.press("ControlOrMeta+t");
    await expect(page.getByRole("tab", { selected: true })).toHaveText("New tab");
    expect(await page.locator(".tab[data-enter]").count()).toBe(0);
    await page.keyboard.press("ControlOrMeta+w");
    await expect(page.getByRole("tab")).toHaveCount(1);
    expect(await page.locator(".tab[data-leaving]").count()).toBe(0);

    // Theme: it changes, and nothing dissolves.
    await page.keyboard.press("ControlOrMeta+Shift+L");
    await page.keyboard.press("ControlOrMeta+Shift+L");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Pictures and a video of the key moments, for a person to look at. Off unless MOTION_CAPTURE names a directory.

const CAPTURE = process.env["MOTION_CAPTURE"];
// (A video cannot be switched on inside a describe group, so it is on for the whole file while capturing.)
test.use({ video: CAPTURE ? { mode: "on", size: { width: 1280, height: 800 } } : "off" });

/** Pauses every running animation at `ms` into it, so a picture shows one moment of the motion. */
async function freeze(page: Page, ms: number) {
  await page.evaluate((at) => {
    for (const a of document.getAnimations()) {
      if ((a.effect as KeyframeEffect | null)?.getComputedTiming().iterations === Infinity) continue;
      a.pause();
      a.currentTime = at;
    }
  }, ms);
}

/** Lets the paused animations run to their end again. */
async function thaw(page: Page) {
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      if ((a.effect as KeyframeEffect | null)?.getComputedTiming().iterations === Infinity) continue;
      a.finish();
    }
  });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`capture, ${scheme}`, () => {
    test.skip(!CAPTURE, "set MOTION_CAPTURE=<directory> to record pictures and a video");
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });

    test(`key moments in ${scheme}`, async ({ page }) => {
      const out = join(CAPTURE!, scheme);
      await mkdir(out, { recursive: true });
      const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`) });
      /** A picture at the start, middle and end of whatever is moving. */
      const frames = async (name: string, at: number[] = [0, 70, 140]) => {
        for (const ms of at) {
          await freeze(page, ms);
          await shot(`${name}-${String(ms).padStart(3, "0")}ms`);
        }
        await thaw(page);
        await settled(page);
      };

      await openVault(page);
      await newPage(page, "Archive/Old");
      await newPage(page, "Archive/Notes");
      await newPage(page, "Plan");
      await settled(page);
      const editor = page.getByRole("textbox", { name: /page content/i });
      await editor.focus();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Motion should help you find your place, and then get out of the way.");
      await shot("00-rest");

      // Command palette.
      await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
      await frames("01-palette-in", [0, 60, 200]);
      await page.keyboard.type(">theme");
      await shot("01-palette-commands");
      await page.keyboard.press("Escape");
      await frames("02-palette-out", [0, 60, 140]);

      // A dialog with actions.
      await page.keyboard.press("ControlOrMeta+n");
      await expect(page.getByRole("dialog", { name: "New page" })).toBeVisible();
      await frames("03-new-page-in", [0, 60, 200]);
      await page.keyboard.press("Escape");
      await settled(page);

      // Folder collapse and expand.
      await folderRow(page, "Archive").click();
      await frames("04-folder-close", [0, 70, 140]);
      await folderRow(page, "Archive").click();
      await frames("05-folder-open", [0, 70, 140]);

      // Tabs.
      await page.keyboard.press("ControlOrMeta+t");
      await expect(page.getByRole("tab")).toHaveCount(2);
      await frames("06-tab-in", [0, 70, 140]);
      await page.keyboard.press("ControlOrMeta+w");
      await expect(page.getByRole("tab")).toHaveCount(1);
      await frames("07-tab-out", [0, 70, 140]);

      // Context menu and the slash menu.
      await folderRow(page, "Archive").click({ button: "right" });
      await frames("08-context-menu", [0, 70, 140]);
      await page.keyboard.press("Escape");
      await settled(page);
      await editor.focus();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");
      await frames("09-slash-menu", [0, 70, 140]);
      await page.keyboard.press("Escape");

      // Selection toolbar.
      await page.keyboard.press("Backspace");
      await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
      await settled(page);
      await frames("10-selection-toolbar", [0, 70, 140]);

      // Theme change (a view transition: pausing its animations freezes the dissolve part way).
      await page.keyboard.press("ControlOrMeta+Shift+L");
      await page.keyboard.press("ControlOrMeta+Shift+L");
      await page.waitForTimeout(60);
      await frames("11-theme-change", [0, 100, 200]);

      await page.close();
      await page.video()?.saveAs(join(CAPTURE!, `${scheme}.webm`));
    });
  });
}
