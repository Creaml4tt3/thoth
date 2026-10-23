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
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import type { TestProject } from "vitest/node";
import { REPO } from "../ports/harness.ts";
import { generateToken, hashToken } from "../../apps/server/src/auth.ts";
import { loadConfig } from "../../apps/server/src/config.ts";
import { createDatabase, type Database } from "../../apps/server/src/db.ts";
import { opaqueId } from "../../apps/server/src/ids.ts";
import { startServer, type RunningServer } from "../../apps/server/src/server.ts";
import startPostgres from "../../apps/server/test-db/global-setup.ts";
import { startFakeIssuer, type FakeIssuer } from "../../apps/server/test-db/fakes.ts";

const WEB = join(REPO, "apps", "web");
const DIST = join(WEB, "dist");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const TOKEN = /thoth_(at|rt|pat)_/;

let stopPostgres: () => Promise<void>;
let databaseUrl: string;
let issuer: FakeIssuer;
let server: RunningServer;
let serverUrl: string;
let db: Database;
let site: Server;
let siteUrl: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = netServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** The built client under /app/, with the SPA fallback a static host gives it (/app/callback serves index.html). */
async function serveApp(port: number): Promise<Server> {
  const http = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (!path.startsWith("/app/")) {
      res.writeHead(404).end();
      return;
    }
    const rel = normalize(path.slice("/app/".length));
    const file = rel === "." || rel === "" || !extname(rel) ? "index.html" : rel;
    if (file.split(sep).includes("..")) {
      res.writeHead(400).end();
      return;
    }
    readFile(join(DIST, file))
      .then((body) => res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body))
      .catch(() => res.writeHead(404).end());
  });
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  return http;
}

/** A second person editing through the API with a personal access token. */
async function asOther(token: string, method: string, path: string, init: { headers?: Record<string, string>; json?: unknown } = {}) {
  const res = await fetch(`${serverUrl}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(init.json === undefined ? {} : { "content-type": "application/json" }), ...(init.headers ?? {}) },
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : undefined };
}

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
    site = await serveApp(sitePort);

    stopPostgres = await startPostgres({ provide: (_key: string, value: string) => void (databaseUrl = value) } as unknown as TestProject);
    issuer = await startFakeIssuer();
    issuer.reset({ sub: `sub-web-${Date.now()}`, name: "Ada Lovelace", email: "ada@example.org" });
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      HOST: "127.0.0.1",
      PORT: String(apiPort),
      LOG_LEVEL: "silent",
      BLOB_STORE: "postgres",
      THOTH_PROFILE: "trial",
      // The trial's rate limits are for people; the test is quick.
      RATE_LIMIT_PER_IP: "unlimited",
      RATE_LIMIT_PER_ACCOUNT: "unlimited",
      PUBLIC_URL: serverUrl,
      CORS_ORIGINS: siteUrl,
      WEB_REDIRECT_URIS: `${siteUrl}/app/callback`,
      OIDC_GOOGLE_CLIENT_ID: issuer.clientId,
      OIDC_GOOGLE_CLIENT_SECRET: issuer.clientSecret,
    });
    // Google's issuer is fixed in configuration; point it at the local test issuer.
    for (const p of config.signIn!.providers) if (p.kind === "oidc") p.issuer = issuer.url;
    server = await startServer(config);
    db = createDatabase(databaseUrl, { max: 2 });
  });

  test.afterAll(async () => {
    await db?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await issuer?.close().catch(() => undefined);
    await new Promise<void>((resolve) => (site ? site.close(() => resolve()) : resolve()));
    await stopPostgres?.();
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
