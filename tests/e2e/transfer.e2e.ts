/**
 * Phase 3 acceptance (docs/architecture/implementation-plan.md): the real desktop UI in Chromium, on the real
 * Rust host (`thoth-host-stdio`, through the dev bridge), against the real reference server on PostgreSQL.
 *
 * Copy a page into a workspace, move another, then move it back from the workspace page: the preview shows
 * who can see the pages and how links are classified, the workspace gets the pages with links mapped by ID,
 * the moved original disappears only after the server confirmed, and the move back restores it in place.
 * Sign-in uses a personal access token, so no identity provider is needed.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";
import { generateToken, hashToken } from "../../apps/server/src/auth.ts";
import { loadConfig } from "../../apps/server/src/config.ts";
import { createDatabase, type Database } from "../../apps/server/src/db.ts";
import { opaqueId } from "../../apps/server/src/ids.ts";
import { startServer, type RunningServer } from "../../apps/server/src/server.ts";
import startPostgres from "../../apps/server/test-db/global-setup.ts";

let built: { dist: string; bridgeDir: string; binary: string };
let stopPostgres: () => Promise<void>;
let databaseUrl: string;
let server: RunningServer;
let serverUrl: string;
let db: Database;
let scratch: string;
let bridge: Bridge;

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

async function api(token: string, path: string) {
  const res = await fetch(`${serverUrl}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, json: (await res.json()) as any };
}

async function signInWithToken(page: Page, token: string) {
  await page.getByRole("button", { name: "Settings" }).click();
  const servers = page.getByRole("region", { name: "Servers" });
  await servers.getByRole("textbox", { name: "Server address" }).fill(serverUrl);
  await servers.getByRole("button", { name: "Add server" }).click();
  const card = servers.getByRole("article");
  await card.getByRole("button", { name: "Use a personal access token" }).click();
  await card.getByLabel(/Personal access token/).fill(token);
  await card.getByRole("button", { name: "Sign in with token" }).click();
  await expect(card.getByTestId("server-account")).toHaveText(/Signed in as Ada/, { timeout: 15_000 });
}

test.describe("transfers", () => {
  test.beforeAll(async () => {
    built = await buildAll();
    stopPostgres = await startPostgres({ provide: (_key: string, value: string) => void (databaseUrl = value) } as unknown as TestProject);
    const port = await freePort();
    serverUrl = `http://127.0.0.1:${port}`;
    server = await startServer(loadConfig({ DATABASE_URL: databaseUrl, HOST: "127.0.0.1", PORT: String(port), LOG_LEVEL: "silent", BLOB_STORE: "postgres", PUBLIC_URL: serverUrl }));
    db = createDatabase(databaseUrl, { max: 2 });
  });

  test.afterAll(async () => {
    await db?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await stopPostgres?.();
  });

  test.beforeEach(async ({ page, context }) => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-xfer-")));
    const vault = join(scratch, "Vault");
    await mkdir(join(vault, "Projects"), { recursive: true });
    await writeFile(join(vault, "Projects", "Plan.md"), "# Plan\n\nSee [[Notes]] and [[Nowhere]].\n");
    await writeFile(join(vault, "Projects", "Notes.md"), "# Notes\n\nBack to [[Plan]].\n");
    bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, dataDir: join(scratch, "data") } });
    // The page reaches only the bridge; the server is reached by the host.
    await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
    await page.addInitScript(bridge.initScript);
    await page.goto(bridge.url);
    await page.getByRole("button", { name: /choose or create a private space/i }).click();
    await expect(page.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    await page.close();
    await bridge.close();
    await rm(scratch, { recursive: true, force: true });
  });

  test("copy a page to a workspace, move another, then move it back", async ({ page }) => {
    const ada = opaqueId("usr");
    const grace = opaqueId("usr");
    const token = generateToken();
    const workspace = opaqueId("ws");
    await db.query("INSERT INTO users (id, display_name) VALUES ($1, 'Ada'), ($2, 'Grace')", [ada, grace]);
    await db.query("INSERT INTO access_tokens (id, user_id, token_hash) VALUES ($1, $2, $3)", [opaqueId("tok"), ada, hashToken(token)]);
    await db.query("INSERT INTO workspaces (id, name, export_restricted) VALUES ($1, 'Studio', false)", [workspace]);
    await db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'viewer')", [workspace, ada, grace]);
    const vault = join(scratch, "Vault");
    const tree = page.getByRole("tree", { name: "Pages in this Private Space" });

    await signInWithToken(page, token);
    // The shell opens the first page (Notes) and expands its folder; selecting then starts with it.
    await tree.getByRole("treeitem", { name: "Notes" }).click();
    await expect(tree.getByRole("treeitem", { name: "Notes" })).toHaveAttribute("aria-current", "page");

    // 1. Copy Notes. The preview says who will see it and how its links travel.
    await page.getByRole("button", { name: "Select pages" }).click();
    await expect(tree.getByRole("checkbox", { name: "Select Notes" })).toBeChecked();
    await page.getByRole("button", { name: "Copy to workspace…" }).click();
    const copy = page.getByRole("dialog", { name: "Copy 1 page to a workspace" });
    const preview = copy.getByRole("region", { name: "Who can see it" });
    await expect(preview).toContainText("Everyone in this workspace (2 members) can see these pages.");
    await expect(preview).toContainText("Grace");
    await expect(preview).toContainText(/1\s*point to pages that stay behind/);
    await expect(preview).toContainText("Nothing has left this computer yet.");
    await copy.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(copy.getByRole("status")).toContainText("1 page was copied to Studio. Every page was checked at the destination.", { timeout: 20_000 });
    await copy.locator(".modal-actions").getByRole("button", { name: "Close" }).click();
    const notesId = ((await api(token, `/workspaces/${workspace}/tree`)).json.items as { id: string; title: string }[]).find((n) => n.title === "Notes")!.id;
    expect(await readFile(join(vault, "Projects", "Notes.md"), "utf8")).toContain("Back to [[Plan]].");

    // 2. Move Plan. Its link to Notes now points at the copy already in the workspace; [[Nowhere]] is kept.
    await page.getByRole("button", { name: "Select pages" }).click();
    await tree.getByRole("checkbox", { name: "Select Notes" }).uncheck();
    await tree.getByRole("checkbox", { name: "Select Plan" }).check();
    await page.getByRole("button", { name: "Move to workspace…" }).click();
    const move = page.getByRole("dialog", { name: "Move 1 page to a workspace" });
    const movePreview = move.getByRole("region", { name: "Who can see it" });
    await expect(movePreview).toContainText(/1\s*point to pages already in the workspace/);
    await expect(movePreview).toContainText(/1\s*point to nothing that exists/);
    await move.getByRole("button", { name: "Move", exact: true }).click();
    await expect(move.getByRole("status")).toContainText("1 page was moved to Studio.", { timeout: 20_000 });
    await move.locator(".modal-actions").getByRole("button", { name: "Close" }).click();
    expect(await readdir(join(vault, "Projects"))).toEqual(["Notes.md"]);
    const remote = ((await api(token, `/workspaces/${workspace}/tree`)).json.items as { id: string; title: string }[]).find((n) => n.title === "Plan")!;
    const remoteMd = (await api(token, `/workspaces/${workspace}/pages/${remote.id}`)).json.markdown as string;
    expect(remoteMd).toContain(`[[thoth:page/${notesId}|Notes]]`);
    expect(remoteMd).toContain("[[Nowhere]]");

    // 3. Move Plan back from its workspace page: it returns to Projects/Plan.md, its link to Notes in vault form.
    const list = page.getByRole("tree", { name: /^Workspaces on / });
    await list.getByRole("treeitem", { name: /^Studio/ }).click();
    await page.getByRole("group", { name: "Pages in Studio" }).getByRole("treeitem", { name: "Plan" }).click();
    await page.getByRole("button", { name: "Move to Private Space…" }).click();
    const back = page.getByRole("dialog", { name: "Move “Plan” to your Private Space" });
    await back.getByRole("textbox", { name: /Folder in your Private Space/ }).fill("Inbox");
    await expect(back.getByRole("region", { name: "Who can see it" })).toContainText("Nothing has been written to your Private Space yet.");
    await back.getByRole("button", { name: "Move", exact: true }).click();
    await expect(back.getByRole("status")).toContainText("1 page was moved to your Private Space.", { timeout: 20_000 });
    await back.locator(".modal-actions").getByRole("button", { name: "Close" }).click();

    expect((await readdir(join(vault, "Projects"))).sort()).toEqual(["Notes.md", "Plan.md"]);
    const restored = await readFile(join(vault, "Projects", "Plan.md"), "utf8");
    expect(restored).toContain("See [[Notes]] and [[Nowhere]].");
    // The workspace keeps the copy of Notes; Plan was deleted there after the verified commit.
    expect(((await api(token, `/workspaces/${workspace}/tree`)).json.items as { title: string }[]).map((n) => n.title)).toEqual(["Notes"]);
    await expect(tree.getByRole("treeitem", { name: "Plan" })).toBeVisible();
  });
});
