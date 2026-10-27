/**
 * Phase 2c acceptance (docs/architecture/implementation-plan.md, ADR-0015): the built web client in Chromium,
 * served from a local static server under /app/, against the real reference server (PostgreSQL in Podman) and
 * its local OIDC test issuer.
 *
 * A brand-new account signs in, finds its own workspace, creates a page, edits it in Blocks and in Plain, reloads
 * and is still signed in (cookie refresh), meets a 412 from a concurrent edit through a personal access token and
 * keeps both, then signs out (the server shows the session revoked). No token is ever readable by the page, and
 * no request leaves 127.0.0.1.
 */
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import { join } from "node:path";
import { REPO } from "../ports/harness.ts";
import { newStableId } from "@thoth/domain";
import { startDrag } from "./drag.ts";
import { settled } from "./settled.ts";
import { apiAs, freePort, serveWebClient, startReferenceServer, type ReferenceServer } from "./reference-server.ts";
import { generateToken, hashToken } from "../../apps/server/src/auth.ts";
import type { Database } from "../../apps/server/src/db.ts";
import { opaqueId } from "../../apps/server/src/ids.ts";
import type { FakeIssuer } from "../../apps/server/test-db/fakes.ts";

const WEB = join(REPO, "apps", "web");
const DIST = join(WEB, "dist");
const TOKEN = /thoth_(at|rt|pat)_/;

let ref: ReferenceServer;
let issuer: FakeIssuer;
let serverUrl: string;
let db: Database;
let site: Server;
let siteUrl: string;

/** A second person editing through the API with a personal access token. */
const asOther = (token: string, method: string, path: string, init: { headers?: Record<string, string>; json?: unknown } = {}) => apiAs(serverUrl, token, method, path, init);

/** Everything a script on the page can read: both storages, the cookies it can see, the DOM, the address. */
const readable = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie + document.documentElement.outerHTML + location.href);

async function editor(page: Page) {
  const box = page.getByRole("textbox", { name: /page content/i });
  await expect(box).toBeVisible();
  return box;
}

test.describe("web client", () => {
  test.beforeAll(async () => {
    const sitePort = await freePort();
    siteUrl = `http://127.0.0.1:${sitePort}`;
    const apiPort = await freePort();
    serverUrl = `http://127.0.0.1:${apiPort}`;
    // The client's address for its server is fixed at build time.
    execFileSync("pnpm", ["exec", "vite", "build", "--logLevel", "warn"], { cwd: WEB, stdio: "inherit", env: { ...process.env, VITE_DEFAULT_SERVER: serverUrl } });
    site = await serveWebClient(DIST, sitePort);

    ref = await startReferenceServer({
      issuer: true,
      port: apiPort,
      env: {
        THOTH_PROFILE: "trial",
        // The trial's rate limits are for people; the test is quick.
        RATE_LIMIT_PER_IP: "unlimited",
        RATE_LIMIT_PER_ACCOUNT: "unlimited",
        CORS_ORIGINS: siteUrl,
        WEB_REDIRECT_URIS: `${siteUrl}/app/callback`,
      },
    });
    issuer = ref.issuer!;
    issuer.reset({ sub: `sub-web-${Date.now()}`, name: "Ada Lovelace", email: "ada@example.org" });
    db = ref.db;
  });

  test.afterAll(async () => {
    await ref?.close();
    await new Promise<void>((resolve) => (site ? site.close(() => resolve()) : resolve()));
  });

  test("tabs are dragged to a new place with a real pointer and come back in that order after a reload (ADR-0019: reorder only)", async ({ page, context }) => {
    await context.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
    // An account of its own; the other test's account comes back afterwards.
    const before = { ...issuer.profile };
    issuer.reset({ sub: `sub-web-tabs-${Date.now()}`, name: "Tab Tester", email: "tabs@example.org" });
    try {
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.goto(`${siteUrl}/app/`);
      await page.getByRole("button", { name: "Sign in with Google" }).click();
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });

      // Three pages in the account's own workspace, written through the API with a token of its own.
      const userId = (await db.query<{ id: string }>("SELECT u.id FROM users u JOIN identities i ON i.user_id = u.id WHERE i.provider = 'google' AND i.subject = $1", [issuer.profile.sub])).rows[0]!.id;
      const workspace = (await db.query<{ id: string }>("SELECT workspace_id AS id FROM memberships WHERE user_id = $1 AND role = 'owner'", [userId])).rows[0]!.id;
      const token = generateToken();
      await db.query("INSERT INTO access_tokens (id, user_id, token_hash) VALUES ($1, $2, $3)", [opaqueId("tok"), userId, hashToken(token)]);
      for (const title of ["Alpha", "Beta", "Gamma"]) {
        const made = await asOther(token, "PUT", `/workspaces/${workspace}/pages/${newStableId(Date.now())}`, { headers: { "if-none-match": "*", "idempotency-key": crypto.randomUUID() }, json: { title, markdown: `# ${title}\n` } });
        expect(made.status, JSON.stringify(made.json)).toBe(201);
      }
      await page.reload();
      const pages = page.getByRole("tree", { name: "Workspaces" }).getByRole("group", { name: "Pages in Tab Tester's workspace" });
      await pages.getByRole("treeitem", { name: "Alpha" }).click();
      for (const name of ["Beta", "Gamma"]) await pages.getByRole("treeitem", { name }).click({ modifiers: ["ControlOrMeta"] });
      const tabNames = () => page.getByRole("tab").allTextContents();
      await expect.poll(tabNames).toEqual(["Alpha", "Beta", "Gamma"]);
      await settled(page);

      // Alpha past Gamma, with the pointer: the same live preview as on the desktop (Beta and Gamma slide back to open
      // the gap at the end), then the new order. Below the bar there is no new window here.
      const boxOf = (name: string) => page.getByRole("tab", { name }).locator("xpath=..");
      const left = async (name: string) => Math.round((await boxOf(name).boundingBox())!.x);
      const betaWas = await left("Beta");
      const drag = await startDrag(page, boxOf("Alpha"));
      const gamma = (await page.getByRole("tab", { name: "Gamma" }).boundingBox())!;
      await drag.moveTo(gamma.x + gamma.width * 0.9, gamma.y + gamma.height / 2);
      await expect.poll(async () => Math.abs((await left("Gamma")) - betaWas) <= 2).toBe(true);
      await expect(page.locator(".tab[data-drop]")).toHaveCount(0);
      // Below the bar (left of the split zone of ADR-0030, which starts 60% across the page area): still no new window.
      await drag.moveTo(400, gamma.y + 300);
      await expect(page.getByText("Release to open in a new window")).toHaveCount(0);
      await drag.moveTo(gamma.x + gamma.width * 0.9, gamma.y + gamma.height / 2);
      await drag.drop();
      await expect.poll(tabNames).toEqual(["Beta", "Gamma", "Alpha"]);
      await expect(page.getByRole("tab", { selected: true })).toHaveText("Gamma");

      await page.reload();
      await expect.poll(tabNames, { timeout: 15_000 }).toEqual(["Beta", "Gamma", "Alpha"]);
      await expect(page.getByRole("tab", { selected: true })).toHaveText("Gamma");
    } finally {
      issuer.reset(before);
    }
  });

  test("a new account signs in, writes in its own workspace, survives a reload and a 412, and signs out", async ({ page, context }) => {
    // Only 127.0.0.1 is reachable; anything else is recorded and refused.
    const elsewhere: string[] = [];
    await context.route(
      (url) => url.hostname !== "127.0.0.1",
      (route) => {
        elsewhere.push(route.request().url());
        return route.abort();
      },
    );

    // The CSP is enforced from the page's meta tag; record anything it blocks.
    const console: string[] = [];
    page.on("console", (message) => void console.push(`${message.type()}: ${message.text()}`));

    // ---- Sign in through the server's broker and the test issuer, as a brand-new account.
    await page.goto(`${siteUrl}/app/`);
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).pathname).toBe("/app/");
    expect(new URL(page.url()).search).toBe("");
    await expect(page.getByText("Signed in as Ada Lovelace")).toBeVisible();

    // ---- The first-run workspace is there, and it is the account's own.
    const tree = page.getByRole("tree", { name: "Workspaces" });
    const pages = tree.getByRole("group", { name: "Pages in Ada Lovelace's workspace" });
    await expect(pages).toContainText("No pages yet.");
    const userId = (await db.query<{ id: string }>("SELECT u.id FROM users u JOIN identities i ON i.user_id = u.id WHERE i.provider = 'google' AND i.subject = $1", [issuer.profile.sub])).rows[0]!.id;
    const workspace = (await db.query<{ id: string }>("SELECT workspace_id AS id FROM memberships WHERE user_id = $1 AND role = 'owner'", [userId])).rows[0]!.id;

    // ---- New page, then write in Blocks.
    await tree.getByRole("button", { name: "New page in Ada Lovelace's workspace" }).click();
    let box = await editor(page);
    await expect(pages.getByRole("treeitem", { name: "Untitled" })).toBeVisible();
    await box.click();
    await page.keyboard.type("# Field notes");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Written in Blocks.");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    const pageRow = async () => (await db.query<{ id: string; title: string }>("SELECT id::text AS id, title FROM pages WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY created_at", [workspace])).rows;
    await expect.poll(async () => (await pageRow())[0]?.title).toBe("Field notes");
    const pageId = (await pageRow())[0]!.id;
    await expect(pages.getByRole("treeitem", { name: "Field notes" })).toBeVisible();

    // ---- Switch to Plain and keep writing.
    await page.getByRole("button", { name: "Plain" }).click();
    box = await editor(page);
    await box.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("\nAnd in Plain.");
    await page.keyboard.press("ControlOrMeta+s");

    // ---- Someone else, with a personal access token, sees it.
    const grace = opaqueId("usr");
    const graceToken = generateToken();
    await db.query("INSERT INTO users (id, display_name) VALUES ($1, 'Grace')", [grace]);
    await db.query("INSERT INTO access_tokens (id, user_id, token_hash) VALUES ($1, $2, $3)", [opaqueId("tok"), grace, hashToken(graceToken)]);
    await db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'editor')", [workspace, grace]);
    await expect.poll(async () => (await asOther(graceToken, "GET", `/workspaces/${workspace}/pages/${pageId}`)).json?.markdown).toMatch(/# Field notes\s+Written in Blocks\.\s+And in Plain\./);

    // ---- No token is readable by the page.
    expect(await readable(page)).not.toMatch(TOKEN);

    // ---- Reload: still signed in, through the refresh cookie alone.
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Signed in as Ada Lovelace")).toBeVisible();
    expect(await readable(page)).not.toMatch(TOKEN);

    // ---- Open the page again; Grace changes it underneath; the next save is a 412 and Keep both keeps both.
    await page.getByRole("group", { name: "Pages in Ada Lovelace's workspace" }).getByRole("treeitem", { name: "Field notes" }).click();
    box = await editor(page);
    await expect(box).toContainText("And in Plain.");
    const current = await asOther(graceToken, "GET", `/workspaces/${workspace}/pages/${pageId}`);
    const graceWrite = await asOther(graceToken, "PUT", `/workspaces/${workspace}/pages/${pageId}`, { headers: { "if-match": `"${current.json.revision.id}"` }, json: { title: "Field notes", markdown: "# Field notes\n\nRewritten by Grace.\n" } });
    expect(graceWrite.status).toBe(200);
    await box.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" Ada again.");
    await page.keyboard.press("ControlOrMeta+s");
    const conflict = page.getByRole("dialog", { name: "This page changed on the server" });
    await expect(conflict).toBeVisible({ timeout: 15_000 });
    await expect(conflict.getByText("Rewritten by Grace.")).toBeVisible();
    await conflict.getByRole("button", { name: /Keep both/ }).click();
    await expect(conflict).toBeHidden();
    expect((await asOther(graceToken, "GET", `/workspaces/${workspace}/pages/${pageId}`)).json.markdown).toBe("# Field notes\n\nRewritten by Grace.\n");
    const treeNow = await asOther(graceToken, "GET", `/workspaces/${workspace}/tree`);
    const copy = (treeNow.json.items as { id: string; title: string }[]).find((n) => n.title === "Field notes (conflict copy)");
    expect(copy).toBeDefined();
    expect((await asOther(graceToken, "GET", `/workspaces/${workspace}/pages/${copy!.id}`)).json.markdown).toContain("Ada again.");
    await expect(box).toContainText("Rewritten by Grace.");

    // ---- Sign out: the server revokes the session; a reload lands on the sign-in page.
    const sessionsLive = async () => Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM sessions WHERE user_id = $1 AND client_id = 'thoth-web' AND revoked_at IS NULL", [userId])).rows[0]!.n);
    expect(await sessionsLive()).toBe(1);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
    await expect.poll(sessionsLive).toBe(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
    expect(await readable(page)).not.toMatch(TOKEN);

    // ---- Nothing left 127.0.0.1 (no fonts, scripts or analytics from anywhere else).
    expect(elsewhere).toEqual([]);
    // ---- The CSP blocked nothing the app needs. (Browsers ignore frame-ancestors in a meta tag and say so; the
    // static host must also send the policy as a header for it to apply.)
    expect(console.filter((line) => /Content Security Policy|Refused to/i.test(line) && !/frame-ancestors/.test(line))).toEqual([]);
  });
});
