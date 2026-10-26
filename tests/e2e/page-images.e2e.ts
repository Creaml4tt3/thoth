/**
 * Images in pages (ADR-0028), on the real Rust host in Chromium: an SVG next to the page under its heading (the
 * owner's case) and a relative PNG show (their `naturalWidth` is not 0), a missing image names its file, a web image
 * is a link and is never requested, the SVG's script and web image do nothing, and `/` Image and a dropped file add
 * an image whose file appears next to the page. Light and dark screenshots go to tests/.tmp/page-images/.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { REPO } from "../ports/harness.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";

const SHOTS = join(REPO, "tests", ".tmp", "page-images");

/** A `w`×`h` PNG: a soft gradient with a round sun, so a screenshot shows a real picture. */
function png(w: number, h: number, hue: [number, number, number]): Buffer {
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    rows[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const sun = (x - w * 0.7) ** 2 + (y - h * 0.35) ** 2 < (h * 0.16) ** 2;
      const i = y * (w * 3 + 1) + 1 + x * 3;
      rows[i] = sun ? 250 : Math.round(hue[0] + (y / h) * 60);
      rows[i + 1] = sun ? 214 : Math.round(hue[1] + (x / w) * 40);
      rows[i + 2] = sun ? 120 : Math.round(hue[2] + (y / h) * 50);
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

// What an agent wrote next to the page; its script and its web image must do nothing.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="140" viewBox="0 0 360 140">
<script>window.parent.__svgRan = true; window.__svgRan = true;</script>
<image href="https://tracker.example/pixel.png" width="1" height="1"/>
<rect width="360" height="140" rx="12" fill="#e9f1ee"/>
<g fill="#f6f3e8" stroke="#7a8f86" stroke-width="2">
<polygon points="60,100 80,40 100,100"/><polygon points="120,110 150,30 180,110"/><polygon points="210,100 235,50 260,100"/><polygon points="285,105 300,60 315,105"/>
</g>
<text x="180" y="132" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#3d4a45">Uric acid crystals (illustration)</text>
</svg>`;
const PAGE = "# Birds\n\nBirds excrete nitrogen as uric acid.\n\n![Uric acid crystals](bird-uric-acid.svg)\n\n![Shore at dusk](shore%20at%20dusk.png)\n\n![Lost diagram](gone.png)\n\n![A kite](https://images.example/kite.png)\n\nLast line.\n";

let built: { dist: string; bridgeDir: string; binary: string };
let scratch: string;
let vault: string;
let picked: string;
let bridge: Bridge;
let offBridge: string[];

test.use({ viewport: { width: 1200, height: 900 } });

test.beforeAll(async () => {
  built = await buildAll();
  await mkdir(SHOTS, { recursive: true });
});

test.beforeEach(async ({ page, context }) => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-images-")));
  vault = join(scratch, "Vault");
  await mkdir(join(vault, "Zoo"), { recursive: true });
  await writeFile(join(vault, "Zoo", "Birds.md"), PAGE);
  await writeFile(join(vault, "Zoo", "bird-uric-acid.svg"), SVG);
  await writeFile(join(vault, "Zoo", "shore at dusk.png"), png(480, 200, [40, 70, 110]));
  // The image the host's picker answers with, outside the vault.
  picked = join(scratch, "Picked", "Heron.png");
  await mkdir(join(scratch, "Picked"));
  await writeFile(picked, png(320, 160, [90, 110, 80]));
  bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, pickImage: picked, dataDir: join(scratch, "data") } });
  // No network for the page: only the bridge is reachable, and every other request is recorded.
  offBridge = [];
  await context.route(
    (url) => !url.href.startsWith(bridge.url) && !url.href.startsWith("blob:") && !url.href.startsWith("data:"),
    (route) => {
      offBridge.push(route.request().url());
      return route.abort();
    },
  );
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
});

test.afterEach(async ({ page }) => {
  await page.close();
  await bridge.close();
  await rm(scratch, { recursive: true, force: true });
});

const theme = (page: Page, dark: boolean) => page.evaluate((night) => document.documentElement.setAttribute("data-theme", night ? "night" : "light"), dark);

async function expectAccessible(page: Page, selector: string) {
  const results = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function openBirds(page: Page) {
  const tree = page.getByRole("tree", { name: "Pages in this Private Space" });
  const start = page.getByRole("button", { name: /start writing/i });
  await expect(tree.or(start)).toBeVisible();
  if (await start.isVisible()) await start.click();
  const folder = tree.getByRole("treeitem", { name: "Zoo", exact: true });
  if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await settled(page);
  await tree.getByRole("treeitem", { name: "Birds", exact: true }).click();
  const box = page.getByRole("textbox", { name: /page content/i });
  await expect(box).toContainText("Birds excrete nitrogen");
  return box;
}

const naturalWidth = (page: Page, name: string) => page.getByRole("img", { name, exact: true }).evaluate((img) => (img as HTMLImageElement).naturalWidth);

test("images next to the page show; a missing one names its file; a web one is a link and is never requested", async ({ page }) => {
  const box = await openBirds(page);
  const svg = box.getByRole("img", { name: "Uric acid crystals", exact: true });
  await expect(svg).toBeVisible();
  await expect(svg).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => naturalWidth(page, "Uric acid crystals")).toBeGreaterThan(0);
  await expect.poll(() => naturalWidth(page, "Shore at dusk")).toBe(480);
  // It fits the page: never wider than the text column.
  const fits = await box.evaluate((el) => [...el.querySelectorAll("img")].every((img) => img.getBoundingClientRect().width <= el.getBoundingClientRect().width + 0.5));
  expect(fits).toBe(true);

  await expect(box.getByText("Image not found: gone.png")).toBeVisible();
  const web = box.getByRole("link", { name: /A kite.*https:\/\/images\.example\/kite\.png/ });
  await expect(web).toBeVisible();

  // The SVG ran nothing and loaded nothing; the web image was never asked for.
  expect(await page.evaluate(() => (window as { __svgRan?: boolean }).__svgRan)).toBeUndefined();
  expect(await page.locator("svg script, svg image").count()).toBe(0);
  expect(offBridge.filter((u) => /images\.example|tracker\.example/.test(u))).toEqual([]);

  await settled(page);
  await expectAccessible(page, ".editor-surface");

  // Opening and closing changed nothing on disk.
  expect(await readFile(join(vault, "Zoo", "Birds.md"), "utf8")).toBe(PAGE);

  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const dark of [false, true]) {
    await theme(page, dark);
    await settled(page);
    await page.locator(".page-scroll").screenshot({ path: join(SHOTS, `page-${dark ? "dark" : "light"}.png`) });
  }
  expect(offBridge.filter((u) => /images\.example|tracker\.example/.test(u))).toEqual([]);
});

test("/ Image and a dropped file add an image, and the file appears next to the page", async ({ page }) => {
  const box = await openBirds(page);
  await box.getByText("Last line.").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/image");
  const menu = page.getByRole("listbox", { name: "Insert block" });
  await expect(menu.getByRole("option").first()).toContainText("Image");
  await page.keyboard.press("Enter");
  const heron = box.getByRole("img", { name: "Heron", exact: true });
  await expect(heron).toBeVisible();
  await expect.poll(() => naturalWidth(page, "Heron")).toBe(320);
  await expect.poll(async () => (await readdir(join(vault, "Zoo"))).sort()).toEqual(["Birds.md", "Heron.png", "bird-uric-acid.svg", "shore at dusk.png"]);

  // A file dropped from the system onto the first paragraph: it goes in after that paragraph.
  await box.getByText("Birds excrete nitrogen").evaluate((el) => {
    const w = 200;
    const h = 100;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#c86b4a";
    g.fillRect(0, 0, w, h);
    return new Promise<void>((resolve) =>
      canvas.toBlob((blob) => {
        const data = new DataTransfer();
        data.items.add(new File([blob!], "Feather sample.png", { type: "image/png" }));
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + r.height / 2 }));
        el.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + r.height / 2 }));
        resolve();
      }, "image/png"),
    );
  });
  await expect(box.getByRole("img", { name: "Feather sample", exact: true })).toBeVisible();
  await expect.poll(() => naturalWidth(page, "Feather sample")).toBe(200);
  await expect.poll(async () => (await readdir(join(vault, "Zoo"))).includes("Feather sample.png")).toBe(true);

  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => readFile(join(vault, "Zoo", "Birds.md"), "utf8"))
    .toBe(PAGE.replace("uric acid.\n", "uric acid.\n\n![Feather sample](Feather%20sample.png)\n").replace("Last line.\n", "Last line.\n\n![Heron](Heron.png)\n"));

  // Alt text from the block menu, in both themes.
  await heron.click();
  await page.keyboard.press("Enter");
  const field = box.getByRole("textbox", { name: "Alt text" });
  await expect(field).toBeFocused();
  await settled(page);
  await expectAccessible(page, ".editor-surface");
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const dark of [false, true]) {
    await theme(page, dark);
    await settled(page);
    const at = (await heron.boundingBox())!;
    await page.screenshot({ path: join(SHOTS, `alt-field-${dark ? "dark" : "light"}.png`), clip: { x: Math.max(0, at.x - 24), y: Math.max(0, at.y - 24), width: Math.min(760, at.width + 400), height: at.height + 140 } });
  }
  await field.fill("A grey heron standing in shallow water");
  await page.keyboard.press("Enter");
  await expect(box.getByRole("img", { name: "A grey heron standing in shallow water" })).toBeVisible();
  expect(offBridge).toEqual([]);
});
