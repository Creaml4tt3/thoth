/**
 * ADR-0023 acceptance: public read-only share links, end to end. The built web client in Chromium against the real
 * reference server (PostgreSQL in Podman, the trial profile) and its local OIDC test issuer.
 *
 * A signed-in owner opens "Share…" on a page that has a picture and a sub-page, creates a link and reads its address.
 * A fresh browser context with no cookies and no sign-in opens the address: the page, its picture and its sub-page are
 * there, nothing runs a script, and axe finds nothing serious. The owner revokes the link; the same address is then
 * the not-found page. Pictures of the share page (light, dark, phone width) and of the dialog are saved under
 * tests/.tmp/share/.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { newStableId } from "@thoth/domain";
import { REPO } from "../ports/harness.ts";
import { apiAs, freePort, buildWebClient, serveWebClient, startReferenceServer, type ReferenceServer } from "./reference-server.ts";
import { generateToken, hashToken } from "../../apps/server/src/auth.ts";
import { opaqueId } from "../../apps/server/src/ids.ts";
import type { FakeIssuer } from "../../apps/server/test-db/fakes.ts";

const SHOTS = join(REPO, "tests", ".tmp", "share");
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

let ref: ReferenceServer;
let issuer: FakeIssuer;
let serverUrl: string;
let site: Server;
let siteUrl: string;

/** A PNG of `w`×`h` pixels: a warm gradient, big enough to see in a screenshot. */
function picture(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) row.set([232 - Math.round((x / w) * 60), 89 + Math.round((y / h) * 80), 12 + Math.round((x / w) * 120)], 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

/** A context that can reach only 127.0.0.1, with nothing stored: a stranger who was sent the address. */
async function stranger(browser: Browser, colorScheme: "light" | "dark" = "light", viewport = { width: 1100, height: 900 }): Promise<BrowserContext> {
  const context = await browser.newContext({ colorScheme, viewport });
  await context.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
  return context;
}

async function serious(page: Page, selector?: string): Promise<string[]> {
  const builder = new AxeBuilder({ page }).withTags(WCAG);
  const results = await (selector ? builder.include(selector) : builder).analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test.describe("public share links (ADR-0023)", () => {
  test.beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    const sitePort = await freePort();
    siteUrl = `http://127.0.0.1:${sitePort}`;
    const apiPort = await freePort();
    serverUrl = `http://127.0.0.1:${apiPort}`;
    site = await serveWebClient(await buildWebClient({ VITE_DEFAULT_SERVER: serverUrl }), sitePort);
    ref = await startReferenceServer({
      issuer: true,
      port: apiPort,
      env: {
        THOTH_PROFILE: "trial",
        RATE_LIMIT_PER_IP: "unlimited",
        RATE_LIMIT_PER_ACCOUNT: "unlimited",
        SHARE_VIEWS_PER_IP: "unlimited",
        SHARE_VIEWS_PER_LINK: "unlimited",
        CORS_ORIGINS: siteUrl,
        WEB_REDIRECT_URIS: `${siteUrl}/app/callback`,
      },
    });
    issuer = ref.issuer!;
    issuer.reset({ sub: `sub-share-${Date.now()}`, name: "Grace Hopper", email: "grace@example.org" });
  });

  test.afterAll(async () => {
    await ref?.close();
    await new Promise<void>((resolve) => (site ? site.close(() => resolve()) : resolve()));
  });

  test("a link made in the web client opens without sign-in, with its picture and sub-page, and stops when revoked", async ({ page, context, browser }) => {
    test.setTimeout(180_000);
    await context.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
    await page.setViewportSize({ width: 1280, height: 860 });

    // ---- Sign in; the account's own workspace gets a page with a picture and a sub-page (written through the API).
    await page.goto(`${siteUrl}/app/`);
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
    const userId = (await ref.db.query<{ id: string }>("SELECT u.id FROM users u JOIN identities i ON i.user_id = u.id WHERE i.provider = 'google' AND i.subject = $1", [issuer.profile.sub])).rows[0]!.id;
    const ws = (await ref.db.query<{ id: string; name: string }>("SELECT w.id, w.name FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = $1 AND m.role = 'owner'", [userId])).rows[0]!;
    const token = generateToken();
    await ref.db.query("INSERT INTO access_tokens (id, user_id, token_hash) VALUES ($1, $2, $3)", [opaqueId("tok"), userId, hashToken(token)]);
    const upload = await fetch(`${serverUrl}/api/v1/workspaces/${ws.id}/attachments?fileName=sunrise.png`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "image/png" }, body: new Uint8Array(picture(640, 280)) });
    expect(upload.status).toBe(201);
    const imageId = ((await upload.json()) as { id: string }).id;
    // An SVG with a script in it: shown as a picture, and opened on its own the script still does not run.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80"><style>rect{fill:#e8590c}</style><rect width="200" height="80" rx="12"/><script>document.documentElement.setAttribute("data-ran","1")</script></svg>';
    const svgUpload = await fetch(`${serverUrl}/api/v1/workspaces/${ws.id}/attachments?fileName=badge.svg`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "image/svg+xml" }, body: svg });
    expect(svgUpload.status).toBe(201);
    const svgId = ((await svgUpload.json()) as { id: string }).id;
    const rootId = newStableId(Date.now());
    const childId = newStableId(Date.now() + 1);
    const markdown = `# Field notes\n\nWhat we saw on the **north shore** this week.\n\n![Sunrise over the bay](thoth:attachment/${imageId})\n\n![Orange badge](thoth:attachment/${svgId})\n\n- [x] Count the ibises\n- [ ] Map the nests\n\n> Bring a second pair of boots.\n\nMore in [[thoth:page/${childId}|the nest survey]].\n`;
    for (const [id, title, md, parentId] of [
      [rootId, "Field notes", markdown, null],
      [childId, "Nest survey", "# Nest survey\n\nTwelve nests, three new.\n", rootId],
    ] as const) {
      const made = await apiAs(serverUrl, token, "PUT", `/workspaces/${ws.id}/pages/${id}`, { headers: { "if-none-match": "*" }, json: { title, markdown: md, parentId } });
      expect(made.status, JSON.stringify(made.json)).toBe(201);
    }
    await page.reload();
    const pages = page.getByRole("tree", { name: "Workspaces" }).getByRole("group", { name: `Pages in ${ws.name}` });
    const row = pages.getByRole("treeitem", { name: "Field notes" });
    await row.click();

    // ---- "Share…" from the page's menu: create a link (30 days by default) and read its address.
    await row.click({ button: "right" });
    await page.getByRole("menu", { name: "Actions for Field notes" }).getByRole("menuitem", { name: "Share…" }).click();
    const dialog = page.getByRole("dialog", { name: "Share “Field notes”" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("No active links.")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "30 days" })).toBeChecked();
    await dialog.getByRole("button", { name: "Create link" }).click();
    const field = dialog.getByRole("textbox", { name: "Public link" });
    await expect(field).toBeVisible();
    const url = await field.inputValue();
    expect(url).toMatch(new RegExp(`^${serverUrl}/s/[A-Za-z0-9_-]{32}$`));
    await expect(dialog.getByRole("list", { name: "Active links" }).getByRole("listitem")).toHaveCount(1);
    expect(await serious(page, '[role="dialog"]')).toEqual([]);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(250);
      await dialog.screenshot({ path: join(SHOTS, `dialog-${scheme}.png`), animations: "disabled" });
    }
    await page.emulateMedia({ colorScheme: "light" });

    // ---- A stranger opens it: no cookies, no sign-in.
    const visitor = await stranger(browser);
    const view = await visitor.newPage();
    const blocked: string[] = [];
    view.on("console", (m) => void (m.type() === "error" && blocked.push(m.text())));
    const response = await view.goto(url);
    expect(response!.status()).toBe(200);
    expect(response!.headers()["content-security-policy"]).toContain("default-src 'none'");
    expect(response!.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    await expect(view.getByRole("heading", { level: 1, name: "Field notes" })).toBeVisible();
    await expect(view.getByText("What we saw on the")).toBeVisible();
    const img = view.getByRole("img", { name: "Sunrise over the bay" });
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(640);
    expect(await view.evaluate(() => document.scripts.length)).toBe(0);
    const badge = view.getByRole("img", { name: "Orange badge" });
    await expect(badge).toBeVisible();
    await expect.poll(() => badge.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(200);
    expect(await view.locator("meta[name=robots]").getAttribute("content")).toBe("noindex, nofollow");
    expect(await view.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("Inter Variable");
    expect(await serious(view)).toEqual([]);
    expect(blocked).toEqual([]);
    await view.screenshot({ path: join(SHOTS, "page-light.png"), fullPage: true });
    const svgUrl = `${new URL(url).origin}${await badge.getAttribute("src")}`;

    // The sub-page is reachable through the link, and from it the way back.
    await view.getByRole("link", { name: "the nest survey" }).click();
    await expect(view.getByRole("heading", { level: 1, name: "Nest survey" })).toBeVisible();
    await expect(view.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Field notes" })).toBeVisible();
    expect(await serious(view)).toEqual([]);
    // The SVG opened on its own: the picture, its own styles, and no script run.
    const direct = await visitor.newPage();
    const svgResponse = await direct.goto(svgUrl);
    expect(svgResponse!.headers()["content-type"]).toBe("image/svg+xml");
    expect(svgResponse!.headers()["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    await expect(direct.locator("rect")).toHaveCount(1);
    expect(await direct.evaluate(() => document.documentElement.getAttribute("data-ran"))).toBeNull();
    expect(await direct.locator("rect").evaluate((el) => getComputedStyle(el).fill)).toBe("rgb(232, 89, 12)");
    await direct.close();
    await visitor.close();

    // Dark, and phone width, light and dark.
    for (const [name, scheme, viewport] of [
      ["page-dark", "dark", { width: 1100, height: 900 }],
      ["page-phone-light", "light", { width: 390, height: 844 }],
      ["page-phone-dark", "dark", { width: 390, height: 844 }],
    ] as const) {
      const ctx = await stranger(browser, scheme, viewport);
      const p = await ctx.newPage();
      await p.goto(url);
      await expect(p.getByRole("img", { name: "Sunrise over the bay" })).toBeVisible();
      await expect.poll(() => p.getByRole("img", { name: "Sunrise over the bay" }).evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(640);
      expect(await serious(p), name).toEqual([]);
      if (viewport.width < 500) expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scrolling on a phone").toBe(true);
      await p.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
      await ctx.close();
    }

    // ---- The owner revokes it in the dialog; the address is then the not-found page, for anyone.
    await dialog.getByRole("button", { name: /^Revoke the link created / }).click();
    await expect(dialog.getByRole("status")).toHaveText("Link revoked. It no longer works.");
    await expect(dialog.getByText("No active links.")).toBeVisible();
    const after = await stranger(browser);
    const gone = await after.newPage();
    const refused = await gone.goto(url);
    expect(refused!.status()).toBe(404);
    await expect(gone.getByRole("heading", { name: "This page is not available" })).toBeVisible();
    await expect(gone.getByText("Field notes")).toHaveCount(0);
    const picture404 = await gone.goto(`${url}/a/${imageId}`);
    expect(picture404!.status()).toBe(404);
    await gone.goto(url);
    await gone.screenshot({ path: join(SHOTS, "not-found-light.png") });
    await after.close();
  });
});
