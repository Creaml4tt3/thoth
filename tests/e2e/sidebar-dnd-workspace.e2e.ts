/**
 * Drag and drop in a workspace tree with a real pointer, on the real desktop UI in Chromium, the real Rust host and the
 * real reference server (PostgreSQL in Podman): reorder before and after, move into a folder page, move to the top level
 * (the workspace row), open a closed folder by hovering it, refuse a drop into a descendant, and `locator.dragTo`. The
 * server's tree is read back to check where each page landed (`parentId`, `position`).
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { newStableId } from "@thoth/domain";
import { folderMarkdown } from "../../packages/app-ui/src/workspace/folders.ts";
import { spread } from "../../packages/app-ui/src/order/fractional.ts";
import { generateToken, hashToken } from "../../apps/server/src/auth.ts";
import { loadConfig } from "../../apps/server/src/config.ts";
import { createDatabase, type Database } from "../../apps/server/src/db.ts";
import { opaqueId } from "../../apps/server/src/ids.ts";
import { startServer, type RunningServer } from "../../apps/server/src/server.ts";
import startPostgres from "../../apps/server/test-db/global-setup.ts";
import { startFakeIssuer, type FakeIssuer } from "../../apps/server/test-db/fakes.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { expectIndicator, indicators, rowByName, rowNames, startDrag } from "./drag.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";

const SUBJECT = "sub-e2e-dnd";

let built: { dist: string; bridgeDir: string; binary: string };
let stopPostgres: () => Promise<void>;
let databaseUrl: string;
let issuer: FakeIssuer;
let server: RunningServer;
let serverUrl: string;
let db: Database;
let scratch: string;
let bridge: Bridge;
let opened: string[];
let token: string;
let workspace: string;
let ids: Record<string, string>;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** Follows an authorization URL like a browser would, down to the host's loopback callback. */
async function actAsBrowser(start: string): Promise<void> {
  const jar = new Map<string, Map<string, string>>();
  let url = start;
  for (let hop = 0; hop < 20; hop++) {
    const origin = new URL(url).origin;
    const cookies = jar.get(origin);
    const res = await fetch(url, { redirect: "manual", headers: cookies && cookies.size > 0 ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {} });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = pair!.indexOf("=");
      const forOrigin = jar.get(origin) ?? new Map<string, string>();
      forOrigin.set(pair!.slice(0, at), pair!.slice(at + 1));
      jar.set(origin, forOrigin);
    }
    const location = res.headers.get("location");
    await res.arrayBuffer();
    if (res.status < 300 || res.status >= 400 || !location) {
      if (new URL(url).pathname === "/callback") return;
      throw new Error(`Sign-in stopped at ${new URL(url).origin}${new URL(url).pathname} with HTTP ${res.status}`);
    }
    url = new URL(location, url).toString();
  }
  throw new Error("Too many redirects during sign-in");
}

async function api(method: string, path: string, init: { headers?: Record<string, string>; json?: unknown } = {}) {
  const res = await fetch(`${serverUrl}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(init.json === undefined ? {} : { "content-type": "application/json" }), ...(init.headers ?? {}) },
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : undefined };
}

/** The server's tree: title → { parent title, position }, and the titles under a parent in the order the client shows them. */
async function serverTree() {
  const { json } = await api("GET", `/workspaces/${workspace}/tree`);
  const items = json.items as { id: string; title: string; parentId: string | null; position: string | null }[];
  const title = (id: string | null) => (id === null ? null : (items.find((i) => i.id === id)?.title ?? "?"));
  const under = (parent: string | null) =>
    items
      .filter((i) => i.parentId === (parent === null ? null : ids[parent]))
      .sort((a, b) => (a.position !== null && b.position !== null ? (a.position < b.position ? -1 : 1) : a.title.localeCompare(b.title)))
      .map((i) => i.title);
  return { parentOf: (name: string) => title(items.find((i) => i.title === name)?.parentId ?? null), under };
}

test.describe("workspace tree drag and drop", () => {
  test.beforeAll(async () => {
    built = await buildAll();
    stopPostgres = await startPostgres({ provide: (_key: string, value: string) => void (databaseUrl = value) } as unknown as TestProject);
    issuer = await startFakeIssuer();
    issuer.reset({ sub: SUBJECT, name: "Ada Lovelace", email: "ada@example.org" });
    const port = await freePort();
    serverUrl = `http://127.0.0.1:${port}`;
    const config = loadConfig({ DATABASE_URL: databaseUrl, HOST: "127.0.0.1", PORT: String(port), LOG_LEVEL: "silent", BLOB_STORE: "postgres", PUBLIC_URL: serverUrl, OIDC_GOOGLE_CLIENT_ID: issuer.clientId, OIDC_GOOGLE_CLIENT_SECRET: issuer.clientSecret });
    for (const p of config.signIn!.providers) if (p.kind === "oidc") p.issuer = issuer.url;
    server = await startServer(config);
    db = createDatabase(databaseUrl, { max: 2 });
    // Ada (the person in the browser) is an editor of every workspace made below; Grace's token seeds the pages.
    const ada = opaqueId("usr");
    const grace = opaqueId("usr");
    token = generateToken();
    await db.query("INSERT INTO users (id, display_name, email) VALUES ($1, 'Ada Lovelace', 'ada@example.org'), ($2, 'Grace', NULL)", [ada, grace]);
    await db.query("INSERT INTO identities (provider, subject, user_id) VALUES ('google', $1, $2)", [SUBJECT, ada]);
    await db.query("INSERT INTO access_tokens (id, user_id, token_hash) VALUES ($1, $2, $3)", [opaqueId("tok"), grace, hashToken(token)]);
    (globalThis as any).__dndUsers = { ada, grace };
  });

  test.afterAll(async () => {
    await db?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await issuer?.close().catch(() => undefined);
    await stopPostgres?.();
  });

  test.beforeEach(async ({ page, context }) => {
    const { ada, grace } = (globalThis as any).__dndUsers as { ada: string; grace: string };
    // A fresh workspace "Studio": top level Alpha, Beta, Gamma and a folder page "Folder" holding One and Two.
    await db.query("DELETE FROM memberships WHERE user_id = ANY($1)", [[ada, grace]]); // the workspaces of earlier tests
    workspace = opaqueId("ws");
    await db.query("INSERT INTO workspaces (id, name, export_restricted) VALUES ($1, 'Studio', false)", [workspace]);
    await db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'editor'), ($1, $3, 'editor')", [workspace, ada, grace]);
    ids = {};
    const top = spread(4);
    const make = async (title: string, position: string, parent?: string, markdown?: string) => {
      const id = newStableId();
      ids[title] = id;
      const res = await api("PUT", `/workspaces/${workspace}/pages/${id}`, {
        headers: { "if-none-match": "*" },
        json: { title, markdown: markdown ?? `# ${title}\n`, position, ...(parent ? { parentId: ids[parent] } : {}) },
      });
      expect(res.status, `${title}: ${JSON.stringify(res.json)}`).toBe(201);
    };
    await make("Alpha", top[0]!);
    await make("Beta", top[1]!);
    await make("Gamma", top[2]!);
    const folderId = newStableId();
    await make("Folder", top[3]!, undefined, folderMarkdown(folderId));
    const inner = spread(2);
    await make("One", inner[0]!, "Folder");
    await make("Two", inner[1]!, "Folder");

    scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-wsdnd-")));
    await mkdir(join(scratch, "Vault"));
    opened = [];
    bridge = await startBridge({
      dist: built.dist,
      bridgeDir: built.bridgeDir,
      host: { binary: built.binary, pickVault: join(scratch, "Vault"), dataDir: join(scratch, "data"), onHostEvent: (event, payload) => void (event === "browser.open" && opened.push((payload as { url: string }).url)) },
    });
    await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
    await page.addInitScript(bridge.initScript);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(bridge.url);
    await page.getByRole("button", { name: /choose or create a private space/i }).click();
    await page.getByRole("button", { name: /start writing/i }).click();
    await page.getByRole("button", { name: "Settings" }).click();
    const servers = page.getByRole("region", { name: "Servers" });
    await servers.getByRole("textbox", { name: "Server address" }).fill(serverUrl);
    await servers.getByRole("button", { name: "Add server" }).click();
    const card = servers.getByRole("article");
    await card.getByRole("button", { name: "Sign in with Google" }).click();
    await expect.poll(() => opened.length, { timeout: 15_000 }).toBe(1);
    await actAsBrowser(opened[0]!);
    await expect(card.getByTestId("server-account")).toHaveText(/Signed in as Ada Lovelace/, { timeout: 15_000 });
    await tree(page).getByRole("treeitem", { name: /^Studio/ }).click();
    await expect(group(page)).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    await page.close();
    await bridge.close();
    await rm(scratch, { recursive: true, force: true });
  });

  const tree = (page: Page) => page.getByRole("tree", { name: /^Workspaces on / });
  const group = (page: Page) => page.getByRole("group", { name: "Pages in Studio" });
  const names = (page: Page) => rowNames(group(page));
  const row = rowByName;
  const openFolder = async (page: Page) => {
    await row(page, "Folder").click();
    await expect(row(page, "Folder")).toHaveAttribute("aria-expanded", "true");
    await expect(row(page, "One")).toBeVisible();
    await settled(page);
  };

  test("reorder at the top level and inside a folder page, before and after: the line shows where it lands and the server keeps the order", async ({ page }) => {
    await expect.poll(() => names(page)).toEqual(["Alpha", "Beta", "Gamma", "Folder"]);

    const drag = await startDrag(page, row(page, "Gamma"));
    await drag.over(row(page, "Alpha"), 0.2);
    await expectIndicator(page, ["Alpha: before"]);
    await drag.drop();
    await expect.poll(() => names(page)).toEqual(["Gamma", "Alpha", "Beta", "Folder"]);
    await expect.poll(async () => (await serverTree()).under(null)).toEqual(["Gamma", "Alpha", "Beta", "Folder"]);
    expect(await indicators(page)).toEqual([]);

    const second = await startDrag(page, row(page, "Gamma"));
    await second.over(row(page, "Beta"), 0.9);
    await expectIndicator(page, ["Beta: after"]);
    await second.drop();
    await expect.poll(() => names(page)).toEqual(["Alpha", "Beta", "Gamma", "Folder"]);
    await expect.poll(async () => (await serverTree()).under(null)).toEqual(["Alpha", "Beta", "Gamma", "Folder"]);

    // Inside the folder page.
    await openFolder(page);
    const inside = await startDrag(page, row(page, "Two"));
    await inside.over(row(page, "One"), 0.2);
    await expectIndicator(page, ["One: before"]);
    await inside.drop();
    await expect.poll(async () => (await serverTree()).under("Folder")).toEqual(["Two", "One"]);
    await expect.poll(() => names(page)).toEqual(["Alpha", "Beta", "Gamma", "Folder", "Two", "One"]);
  });

  test("move into a page or a folder and out to the top level (the workspace row)", async ({ page }) => {
    const into = await startDrag(page, row(page, "Alpha"));
    await into.over(row(page, "Beta"), 0.5);
    await expectIndicator(page, ["Beta: inside"]);
    await into.drop();
    await expect.poll(async () => (await serverTree()).parentOf("Alpha")).toBe("Beta");

    await openFolder(page);
    const out = await startDrag(page, row(page, "One"));
    const studio = tree(page).getByRole("treeitem", { name: /^Studio/ });
    await out.over(studio, 0.5);
    await expect(studio).toHaveAttribute("data-drop", "inside");
    await out.drop();
    await expect.poll(async () => (await serverTree()).parentOf("One")).toBeNull();
    await expect.poll(async () => (await serverTree()).under("Folder")).toEqual(["Two"]);
  });

  test("a closed folder opens under a dragged page, the lower edge of an open one goes first inside it, and nothing goes into itself", async ({ page }) => {
    const drag = await startDrag(page, row(page, "Alpha"));
    await drag.over(row(page, "Folder"), 0.5);
    await expectIndicator(page, ["Folder: inside"]);
    await expect(row(page, "Folder")).toHaveAttribute("aria-expanded", "true", { timeout: 3000 });
    await expect(row(page, "One")).toBeVisible();
    await settled(page);
    await drag.over(row(page, "Folder"), 0.95);
    await expectIndicator(page, ["One: before"]);
    await drag.drop();
    await expect.poll(async () => (await serverTree()).under("Folder")).toEqual(["Alpha", "One", "Two"]);

    const refuse = await startDrag(page, row(page, "Folder"));
    await refuse.over(row(page, "One"), 0.5);
    await expectIndicator(page, []);
    await refuse.over(row(page, "Two"), 0.2);
    await expectIndicator(page, []);
    await refuse.drop();
    await page.waitForTimeout(300);
    expect((await serverTree()).parentOf("Folder")).toBeNull();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("locator.dragTo reorders and moves too", async ({ page }) => {
    await row(page, "Gamma").dragTo(row(page, "Alpha"), { targetPosition: { x: 60, y: 3 } });
    await expect.poll(async () => (await serverTree()).under(null)).toEqual(["Gamma", "Alpha", "Beta", "Folder"]);
    // The server showing the order is not the UI showing it: the second dragTo measures its rows at once, so wait for the
    // list on screen first (as the Private Space twin of this test does). NOT REPRODUCED: this test did not fail in ~128
    // runs of the investigation; the wait follows from the code (the UI redraws after movePage returns, a few ms after the
    // server poll can already see it), not from a failing run.
    await expect.poll(() => names(page)).toEqual(["Gamma", "Alpha", "Beta", "Folder"]);
    await row(page, "Beta").dragTo(row(page, "Gamma"));
    await expect.poll(async () => (await serverTree()).parentOf("Beta")).toBe("Gamma");
  });
});
