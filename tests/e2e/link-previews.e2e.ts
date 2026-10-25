/**
 * Links from pasted URLs and link previews in the real desktop UI (ADR-0020; Chromium, the real Rust host through the
 * dev bridge). A local page server stands in for the web: the harness runs with `--link-preview-loopback` (the
 * test-only switch the app cannot turn on), and the page itself can reach nothing but the bridge, so every fetch is
 * the host's. Pasting the page's address on its own line makes a link and shows its card; after a reload the card
 * comes from the host's cache (the page server is not asked again). axe checks the card and its menu.
 *
 * It saves pictures of the card, light and dark, under tests/.tmp/links/ (git-ignored).
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync } from "node:zlib";
import { REPO } from "../ports/harness.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";

const SHOTS = join(REPO, "tests", ".tmp", "links");
/** A 240×160 PNG: a dusk gradient with a moon, so the card's picture is a real image. */
function coverPng(): Buffer {
  const [w, h] = [240, 160];
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    rows[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const moon = (x - 170) ** 2 + (y - 55) ** 2 < 22 ** 2;
      const i = y * (w * 3 + 1) + 1 + x * 3;
      rows[i] = moon ? 240 : 30 + Math.round((y / h) * 60);
      rows[i + 1] = moon ? 214 : 40 + Math.round((x / w) * 40);
      rows[i + 2] = moon ? 140 : 90 + Math.round((y / h) * 90);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = coverPng();
const ARTICLE = `<!doctype html><html><head><meta charset="utf-8">
<title>Fallback</title>
<meta property="og:site_name" content="The Scribe's Journal">
<meta property="og:title" content="How Thoth keeps notes &amp; links">
<meta property="og:description" content="Plain Markdown files, a block editor on top, and previews for the links you paste. This sentence is long enough to need a second line in the card.">
<meta property="og:image" content="/cover.png">
</head><body><p>The article.</p></body></html>`;

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let bridge: Bridge;
let pages: Server;
let origin: string;
let served: string[];

test.use({ viewport: { width: 1200, height: 800 } });

test.beforeAll(async () => {
  built = await buildAll();
  await mkdir(SHOTS, { recursive: true });
});

test.beforeEach(async ({ page, context }) => {
  served = [];
  pages = createServer((req, res) => {
    served.push(req.url ?? "");
    if (req.url === "/article") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ARTICLE);
    } else if (req.url === "/cover.png") {
      res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;

  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-links-")));
  vault = join(scratch, "Vault");
  await mkdir(vault);
  await writeFile(join(vault, "Notes.md"), "# Notes\n\nIntro line.\n\nLast line.\n");
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, dataDir: join(scratch, "data"), linkPreviewLoopback: true } });
  // No network for the page: only the bridge is reachable. The page server is reached by the host alone.
  await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await new Promise((resolve) => pages.close(resolve));
  await rm(scratch, { recursive: true, force: true });
});

const theme = (page: Page, dark: boolean) => page.evaluate((night) => document.documentElement.setAttribute("data-theme", night ? "night" : "light"), dark);

async function expectAccessible(page: Page, selector: string) {
  const results = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** What the browser sends for Cmd/Ctrl+V with `text` on the clipboard. */
async function paste(page: Page, text: string) {
  await page.evaluate((value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

async function openNotes(page: Page) {
  // The first visit shows the intro; later ones go straight to the tree.
  const tree = page.getByRole("tree", { name: "Pages in this Private Space" });
  const start = page.getByRole("button", { name: /start writing/i });
  await expect(tree.or(start)).toBeVisible();
  if (await start.isVisible()) await start.click();
  await page.getByRole("tree", { name: "Pages in this Private Space" }).getByRole("treeitem", { name: "Notes" }).click();
  const box = page.getByRole("textbox", { name: /page content/i });
  await expect(box).toContainText("Intro line.");
  return box;
}

test("a pasted address becomes a link with its preview card, and the card comes from the cache after a reload", async ({ page }) => {
  const box = await openNotes(page);
  await box.getByText("Intro line.").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const url = `${origin}/article`;
  await paste(page, url);

  const card = page.getByRole("group", { name: "Link preview: How Thoth keeps notes & links" });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText("The Scribe's Journal")).toBeVisible();
  await expect(card.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  expect(served).toEqual(["/article", "/cover.png"]);

  // The file has the link in the serializer's usual form; the card is not in it.
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(join(vault, "Notes.md"), "utf8")).toBe(`# Notes\n\nIntro line.\n\n<${url}>\n\nLast line.\n`);

  // axe: the card, then its open menu.
  await expectAccessible(page, "[data-link-card]");
  await card.getByRole("button", { name: "Link preview options" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(card.getByRole("menuitem", { name: "Show as link" })).toBeFocused();
  await expectAccessible(page, "[data-link-card]");
  await page.keyboard.press("Escape");
  await expect(card.getByRole("button", { name: "Link preview options" })).toBeFocused();

  // Pictures, light and dark, still.
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const dark of [false, true]) {
    await theme(page, dark);
    await card.screenshot({ path: join(SHOTS, `card-${dark ? "dark" : "light"}.png`) });
    await card.getByRole("button", { name: "Link preview options" }).click();
    await page.screenshot({ path: join(SHOTS, `card-menu-${dark ? "dark" : "light"}.png`), clip: await clipAround(card) });
    await page.keyboard.press("Escape");
  }

  // A reload is a new session: the card comes back from the host's cache, and the page server is not asked again.
  await page.reload();
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  await openNotes(page);
  await expect(page.getByRole("group", { name: "Link preview: How Thoth keeps notes & links" })).toBeVisible({ timeout: 10_000 });
  expect(served).toEqual(["/article", "/cover.png"]);
  // The cache is in the app data folder, never in the vault.
  expect((await readdir(join(scratch, "data", "link-previews"))).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  expect((await readdir(vault)).sort()).toEqual([".thoth", "Notes.md"]);
});

async function clipAround(card: ReturnType<Page["getByRole"]>) {
  const box = (await card.boundingBox())!;
  return { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: box.height + 150 };
}
