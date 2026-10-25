/**
 * Phase 2b part 3 acceptance (docs/architecture/implementation-plan.md): the
 * real UI in Chromium, on the real Rust host, against the real reference
 * server (PostgreSQL in Podman) and its local OIDC test issuer.
 *
 * Add a local server, sign in through the fake provider, open a workspace
 * page, edit it, meet a 412 from a concurrent edit, and keep both.
 *
 * The test plays the system browser: the harness reports the sign-in URL as a
 * `browser.open` host event (it never opens a browser), and the test follows
 * the redirects through the server and the issuer back to the host's loopback
 * callback. It is skipped until `crates/thoth-host` lists the `server.*`
 * commands.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newStableId } from "@thoth/domain";
import { REPO } from "../ports/harness.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";
import { actAsBrowser, apiAs, startReferenceServer, type ReferenceServer } from "./reference-server.ts";
import { generateToken, hashToken } from "../../apps/server/src/auth.ts";
import type { Database } from "../../apps/server/src/db.ts";
import { opaqueId } from "../../apps/server/src/ids.ts";
import type { FakeIssuer } from "../../apps/server/test-db/fakes.ts";

const HOST_LIB = readFileSync(join(REPO, "crates/thoth-host/src/lib.rs"), "utf8");
const HOST_HAS_SERVERS = /"server\.add"/.test(HOST_LIB) && /"api\.call"/.test(HOST_LIB);

const SUBJECT = "sub-e2e-ada";

let built: { dist: string; bridgeDir: string; binary: string };
let ref: ReferenceServer;
let issuer: FakeIssuer;
let serverUrl: string;
let db: Database;
let scratch: string;
let bridge: Bridge;
/** `browser.open` events from the harness: the URLs the host asked the system browser to open. */
let opened: string[];

/** A second person editing through the API with a personal access token. */
const asOther = (token: string, method: string, path: string, init: { headers?: Record<string, string>; json?: unknown } = {}) => apiAs(serverUrl, token, method, path, init);

async function editor(page: Page) {
  const box = page.getByRole("textbox", { name: /page content/i });
  await expect(box).toBeVisible();
  return box;
}

test.describe("workspace servers", () => {
  test.skip(!HOST_HAS_SERVERS, "Pending on the Rust side: crates/thoth-host does not list the server.* and api.call commands yet.");

  test.beforeAll(async () => {
    built = await buildAll();
    // The same throwaway PostgreSQL the server's test-db suite uses (Podman, tmpfs, 127.0.0.1 only), and the test issuer.
    ref = await startReferenceServer({ issuer: true });
    issuer = ref.issuer!;
    issuer.reset({ sub: SUBJECT, name: "Ada Lovelace", email: "ada@example.org" });
    serverUrl = ref.url;
    db = ref.db;
  });

  test.afterAll(async () => {
    await ref?.close();
  });

  test.beforeEach(async ({ page, context }) => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-ws-")));
    await mkdir(join(scratch, "Vault"));
    opened = [];
    bridge = await startBridge({
      dist: built.dist,
      bridgeDir: built.bridgeDir,
      host: {
        binary: built.binary,
        pickVault: join(scratch, "Vault"),
        dataDir: join(scratch, "data"),
        onHostEvent: (event, payload) => {
          if (event === "browser.open") opened.push((payload as { url: string }).url);
        },
      },
    });
    // The page reaches only the bridge; the server is reached by the host.
    await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
    await page.addInitScript(bridge.initScript);
    await page.goto(bridge.url);
    await page.getByRole("button", { name: /choose or create a private space/i }).click();
    await page.getByRole("button", { name: /start writing/i }).click();
  });

  test.afterEach(async ({ page }) => {
    await page.close();
    await bridge.close();
    await rm(scratch, { recursive: true, force: true });
  });

  test("add a local server, sign in through the provider, edit a workspace page, keep both after a 412", async ({ page }) => {
    // Ada already has an account linked to the test issuer's subject, and is an editor of "Studio".
    // Grace edits the same page through the API with a personal access token.
    const ada = opaqueId("usr");
    const grace = opaqueId("usr");
    const graceToken = generateToken();
    const workspace = opaqueId("ws");
    await db.query("INSERT INTO users (id, display_name, email) VALUES ($1, 'Ada Lovelace', 'ada@example.org'), ($2, 'Grace', NULL)", [ada, grace]);
    await db.query("INSERT INTO identities (provider, subject, user_id) VALUES ('google', $1, $2)", [SUBJECT, ada]);
    await db.query("INSERT INTO access_tokens (id, user_id, token_hash) VALUES ($1, $2, $3)", [opaqueId("tok"), grace, hashToken(graceToken)]);
    await db.query("INSERT INTO workspaces (id, name, export_restricted) VALUES ($1, 'Studio', false)", [workspace]);
    await db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'editor'), ($1, $3, 'editor')", [workspace, ada, grace]);
    const planId = newStableId();
    const created = await asOther(graceToken, "PUT", `/workspaces/${workspace}/pages/${planId}`, { headers: { "if-none-match": "*" }, json: { title: "Plan", markdown: "# Plan\n\nFirst line.\n" } });
    expect(created.status).toBe(201);

    // Settings → Servers → Add server.
    await page.getByRole("button", { name: "Settings" }).click();
    const servers = page.getByRole("region", { name: "Servers" });
    await servers.getByRole("textbox", { name: "Server address" }).fill(serverUrl);
    await servers.getByRole("button", { name: "Add server" }).click();
    const card = servers.getByRole("article");
    await expect(card).toContainText(serverUrl);

    // Sign in: the host opens the "browser" (reported to the test), which comes back to the loopback callback.
    await card.getByRole("button", { name: "Sign in with Google" }).click();
    await expect(card.getByRole("status")).toContainText(/finish signing in with google/i);
    await expect.poll(() => opened.length, { timeout: 15_000 }).toBe(1);
    expect(opened[0]!.startsWith(`${serverUrl}/auth/authorize?`)).toBe(true);
    await actAsBrowser(opened[0]!);
    await expect(card.getByTestId("server-account")).toHaveText(/Signed in as Ada Lovelace/, { timeout: 15_000 });

    // No credential ever reaches the webview.
    expect(await page.evaluate<string>("JSON.stringify({ ...localStorage }) + document.documentElement.outerHTML")).not.toMatch(/thoth_(pat|at|rt)_|"refresh_token"|access_token/);

    // The workspace appears in the sidebar; open its page.
    const list = page.getByRole("tree", { name: /^Workspaces on / });
    await list.getByRole("treeitem", { name: /^Studio/ }).click();
    await page.getByRole("group", { name: "Pages in Studio" }).getByRole("treeitem", { name: "Plan" }).click();
    const box = await editor(page);
    await expect(box).toContainText("First line.");
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Workspace · Studio");

    // Edit and save: the host sends it with If-Match.
    await box.getByText("First line.").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Ada was here.");
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(async () => (await asOther(graceToken, "GET", `/workspaces/${workspace}/pages/${planId}`)).json.markdown).toContain("First line. Ada was here.");

    // Grace edits concurrently; Ada's next save is stale and the server answers 412.
    const current = await asOther(graceToken, "GET", `/workspaces/${workspace}/pages/${planId}`);
    const graceWrite = await asOther(graceToken, "PUT", `/workspaces/${workspace}/pages/${planId}`, {
      headers: { "if-match": `"${current.json.revision.id}"` },
      json: { title: "Plan", markdown: "# Plan\n\nRewritten by Grace.\n" },
    });
    expect(graceWrite.status).toBe(200);
    await page.keyboard.type(" And more.");
    await page.keyboard.press("ControlOrMeta+s");

    const conflict = page.getByRole("dialog", { name: "This page changed on the server" });
    await expect(conflict).toBeVisible({ timeout: 15_000 });
    await expect(conflict.getByText("Rewritten by Grace.")).toBeVisible();
    await conflict.getByRole("button", { name: /keep both/i }).click();
    await expect(conflict).toBeHidden();

    // Grace's version stays; Ada's is a new page in the same workspace.
    expect((await asOther(graceToken, "GET", `/workspaces/${workspace}/pages/${planId}`)).json.markdown).toBe("# Plan\n\nRewritten by Grace.\n");
    const tree = await asOther(graceToken, "GET", `/workspaces/${workspace}/tree`);
    const copy = (tree.json.items as { id: string; title: string }[]).find((n) => n.title === "Plan (conflict copy)");
    expect(copy).toBeDefined();
    expect((await asOther(graceToken, "GET", `/workspaces/${workspace}/pages/${copy!.id}`)).json.markdown).toContain("First line. Ada was here. And more.");
    await expect(box).toContainText("Rewritten by Grace.");
    await expect(page.getByRole("group", { name: "Pages in Studio" }).getByRole("treeitem", { name: "Plan (conflict copy)" })).toBeVisible();
  });
});
