/**
 * ADR-0025 acceptance: several workspaces per account, end to end. The built web client in Chromium against the real
 * reference server (PostgreSQL in Podman, the trial profile: 3 owned workspaces) and its local OIDC test issuer.
 *
 * A new account signs in (it has its own first workspace), creates a second and a third from "New workspace on …",
 * and is then at the limit: the dialog says so and offers no Create. It renames the second, deletes the third after
 * typing its name (it leaves the sidebar; "Recently deleted (1)" appears), restores it from Recently deleted (it is
 * back with its page), deletes it again and deletes it permanently, which makes room for a new one. Pictures (light,
 * dark, phone width) of every dialog are saved under tests/.tmp/workspaces/.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { REPO } from "../ports/harness.ts";
import { freePort, serveWebClient, startReferenceServer, type ReferenceServer } from "./reference-server.ts";
import type { FakeIssuer } from "../../apps/server/test-db/fakes.ts";

const WEB = join(REPO, "apps", "web");
const DIST = join(WEB, "dist");
const SHOTS = join(REPO, "tests", ".tmp", "workspaces");
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

let ref: ReferenceServer;
let issuer: FakeIssuer;
let serverUrl: string;
let site: Server;
let siteUrl: string;

async function serious(page: Page, selector?: string): Promise<string[]> {
  const builder = new AxeBuilder({ page }).withTags(WCAG);
  const results = await (selector ? builder.include(selector) : builder).analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

/** Light and dark pictures of the dialog, and at phone width with no sideways scrolling. */
async function shoot(page: Page, name: string, dialog: ReturnType<Page["locator"]>): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    expect(await serious(page, '[role="dialog"]'), `${name} ${scheme}`).toEqual([]);
    await dialog.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`), animations: "disabled" });
  }
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}: no sideways scrolling on a phone`).toBe(true);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}-phone-${scheme}.png`), animations: "disabled" });
  }
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: "light" });
}

test.describe("several workspaces per account (ADR-0025)", () => {
  test.beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    const sitePort = await freePort();
    siteUrl = `http://127.0.0.1:${sitePort}`;
    const apiPort = await freePort();
    serverUrl = `http://127.0.0.1:${apiPort}`;
    execFileSync("pnpm", ["exec", "vite", "build", "--logLevel", "warn"], { cwd: WEB, stdio: "inherit", env: { ...process.env, VITE_DEFAULT_SERVER: serverUrl } });
    site = await serveWebClient(DIST, sitePort);
    ref = await startReferenceServer({
      issuer: true,
      port: apiPort,
      env: {
        THOTH_PROFILE: "trial",
        RATE_LIMIT_PER_IP: "unlimited",
        RATE_LIMIT_PER_ACCOUNT: "unlimited",
        SIGNUP_LIMIT_PER_IP: "unlimited",
        CORS_ORIGINS: siteUrl,
        WEB_REDIRECT_URIS: `${siteUrl}/app/callback`,
      },
    });
    issuer = ref.issuer!;
  });

  test.afterAll(async () => {
    await ref?.close();
    await new Promise<void>((resolve) => (site ? site.close(() => resolve()) : resolve()));
  });

  test("create up to the limit, rename, delete, restore, delete permanently, create again", async ({ page, context }) => {
    test.setTimeout(300_000);
    await context.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
    await page.setViewportSize({ width: 1280, height: 900 });

    // ---- A new account signs in: its own first workspace.
    issuer.reset({ sub: `sub-ws-${Date.now()}`, name: "Ada Lovelace", email: "ada@example.org" });
    await page.goto(`${siteUrl}/app/`);
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
    const tree = page.getByRole("tree", { name: "Workspaces" });
    await expect(tree.getByRole("treeitem", { name: /^Ada Lovelace's workspace/ })).toBeVisible();
    const userId = (await ref.db.query<{ user_id: string }>("SELECT user_id FROM identities WHERE subject = $1", [issuer.profile.sub])).rows[0]!.user_id;
    const owned = async () => Number((await ref.db.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE user_id = $1 AND role = 'owner'", [userId])).rows[0]!.n);

    // ---- New workspace: 1 of 3; create "Research", it opens in the sidebar.
    const newButton = page.getByRole("button", { name: /^New workspace on / });
    await newButton.click();
    const create = page.getByRole("dialog", { name: /^New workspace on / });
    await expect(create.getByText("You own 1 of 3 workspaces this server allows.")).toBeVisible();
    await expect(create.getByRole("textbox", { name: "Name" })).toBeFocused();
    await create.getByRole("textbox", { name: "Name" }).fill("Research");
    await shoot(page, "new-workspace", create);
    await create.getByRole("button", { name: "Create workspace" }).click();
    const research = tree.getByRole("treeitem", { name: /^Research/ });
    await expect(research).toBeFocused();
    await expect(research).toHaveAttribute("aria-expanded", "true");
    expect(await owned()).toBe(2);
    await expect(page.locator(".ws-footer").getByText("2 of 3 workspaces", { exact: true })).toBeVisible();

    // ---- A page in it, then a third workspace; now at the limit.
    await page.getByRole("button", { name: "New page in Research" }).click();
    await expect(tree.getByRole("treeitem", { name: "Untitled" })).toBeVisible();
    await newButton.click();
    await create.getByRole("textbox", { name: "Name" }).fill("Scratch");
    await create.getByRole("textbox", { name: "Name" }).press("Enter");
    await expect(tree.getByRole("treeitem", { name: /^Scratch/ })).toBeVisible();
    expect(await owned()).toBe(3);
    await newButton.click();
    await expect(create.getByText(/You already own 3 workspaces, the most this server allows/)).toBeVisible();
    await expect(create.getByRole("button", { name: "Create workspace" })).toBeDisabled();
    await shoot(page, "new-workspace-at-limit", create);
    await create.getByRole("button", { name: "Cancel" }).click();

    // ---- Rename "Research" from its row's menu.
    await research.click({ button: "right" });
    await page.getByRole("menu", { name: "Actions for Research" }).getByRole("menuitem", { name: /Rename…/ }).click();
    const rename = page.getByRole("dialog", { name: "Rename “Research”" });
    await rename.getByRole("textbox", { name: "New name" }).fill("Field research");
    await rename.getByRole("button", { name: "Rename" }).click();
    await expect(tree.getByRole("treeitem", { name: /^Field research/ })).toBeVisible();
    expect((await ref.db.query<{ name: string }>("SELECT w.name FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = $1 ORDER BY w.created_at", [userId])).rows.map((r) => r.name)).toEqual(["Ada Lovelace's workspace", "Field research", "Scratch"]);

    // ---- Delete "Field research": only once its name is typed.
    await tree.getByRole("treeitem", { name: /^Field research/ }).click({ button: "right" });
    await page.getByRole("menu", { name: "Actions for Field research" }).getByRole("menuitem", { name: "Delete…" }).click();
    const del = page.getByRole("dialog", { name: "Delete “Field research”?" });
    const confirm = del.getByRole("button", { name: "Delete workspace" });
    await expect(confirm).toBeDisabled();
    await del.getByRole("textbox", { name: /type the workspace's name/ }).fill("Field research");
    await expect(confirm).toBeEnabled();
    await shoot(page, "delete-workspace", del);
    await confirm.click();
    await expect(tree.getByRole("treeitem", { name: /^Field research/ })).toHaveCount(0);
    const ws = (await ref.db.query<{ id: string; deleted_at: Date | null }>("SELECT id, deleted_at FROM workspaces WHERE name = 'Field research'")).rows[0]!;
    expect(ws.deleted_at).not.toBeNull();
    expect((await ref.db.query("SELECT 1 FROM pages WHERE workspace_id = $1", [ws.id])).rowCount).toBe(1);

    // ---- Recently deleted: restore it, with its page.
    await page.getByRole("button", { name: "Recently deleted (1)" }).click();
    const deleted = page.getByRole("dialog", { name: /^Recently deleted on / });
    await expect(deleted.getByRole("list", { name: "Recently deleted workspaces" })).toContainText("Field research");
    await expect(deleted.getByText(/can be restored until/)).toBeVisible();
    await shoot(page, "recently-deleted", deleted);
    await deleted.getByRole("button", { name: "Restore Field research" }).click();
    await expect(deleted.getByRole("status")).toHaveText("Restored Field research.");
    await deleted.getByRole("button", { name: "Done" }).click();
    await expect(tree.getByRole("treeitem", { name: /^Field research/ })).toBeVisible();
    await expect(tree.getByRole("treeitem", { name: "Untitled" })).toBeVisible();

    // ---- Delete it again and permanently: the place is free for a new one.
    await tree.getByRole("treeitem", { name: /^Field research/ }).click({ button: "right" });
    await page.getByRole("menu", { name: "Actions for Field research" }).getByRole("menuitem", { name: "Delete…" }).click();
    await del.getByRole("textbox", { name: /type the workspace's name/ }).fill("Field research");
    await del.getByRole("button", { name: "Delete workspace" }).click();
    await expect(tree.getByRole("treeitem", { name: /^Field research/ })).toHaveCount(0);
    await newButton.click();
    await expect(create.getByText(/You already own 3 workspaces/)).toBeVisible();
    await create.getByRole("button", { name: "Recently deleted (1)" }).click();
    await deleted.getByRole("button", { name: "Delete Field research permanently" }).click();
    const purge = deleted.getByRole("group", { name: "Delete “Field research” permanently?" });
    await purge.getByRole("textbox", { name: /type the workspace's name/ }).fill("Field research");
    await shoot(page, "delete-permanently", deleted);
    await purge.getByRole("button", { name: "Delete permanently" }).click();
    await expect(deleted.getByRole("status")).toHaveText("Field research was deleted permanently.");
    expect((await ref.db.query("SELECT 1 FROM workspaces WHERE id = $1", [ws.id])).rowCount).toBe(0);
    expect((await ref.db.query("SELECT 1 FROM pages WHERE workspace_id = $1", [ws.id])).rowCount).toBe(0);
    await deleted.getByRole("button", { name: "Done" }).click();
    expect(await owned()).toBe(2);
    await newButton.click();
    await expect(create.getByText("You own 2 of 3 workspaces this server allows.")).toBeVisible();
    await create.getByRole("textbox", { name: "Name" }).fill("Fresh start");
    await create.getByRole("button", { name: "Create workspace" }).click();
    await expect(tree.getByRole("treeitem", { name: /^Fresh start/ })).toBeVisible();
    // The whole sidebar after all that, light and dark.
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(250);
      await page.locator("aside.sidebar").screenshot({ path: join(SHOTS, `sidebar-${scheme}.png`), animations: "disabled" });
    }
  });
});
