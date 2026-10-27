/**
 * ADR-0024 acceptance: workspace members and invite links, end to end. The built web client in Chromium against the
 * real reference server (PostgreSQL in Podman, the trial profile) and its local OIDC test issuer.
 *
 * An owner signs in to the web client, opens "Members…" on their workspace and makes an invite link for five people.
 * A second person, in a fresh browser with nothing stored, opens the link: the server's invite page (no script) names
 * the workspace, the inviter and the role; "Sign in with Google to join" goes through the sign-in broker and comes
 * back to the join form; "Join workspace" joins; "Open in Thoth" leads to the web client, where the workspace is in
 * the sidebar. Opening the link again says "already a member". The owner then sees them in the list, makes them a
 * viewer and removes them; the workspace is gone from the second person's sidebar. Pictures (light, dark, phone
 * width) of the dialog and of every invite page are saved under tests/.tmp/members/.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { REPO } from "../ports/harness.ts";
import { freePort, buildWebClient, serveWebClient, startReferenceServer, type ReferenceServer } from "./reference-server.ts";
import type { FakeIssuer } from "../../apps/server/test-db/fakes.ts";

const SHOTS = join(REPO, "tests", ".tmp", "members");
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

let ref: ReferenceServer;
let issuer: FakeIssuer;
let serverUrl: string;
let site: Server;
let siteUrl: string;

/** A context that can reach only 127.0.0.1, with nothing stored. */
async function fresh(browser: Browser, colorScheme: "light" | "dark" = "light", viewport = { width: 1100, height: 900 }): Promise<BrowserContext> {
  const context = await browser.newContext({ colorScheme, viewport });
  await context.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
  return context;
}

async function serious(page: Page, selector?: string): Promise<string[]> {
  const builder = new AxeBuilder({ page }).withTags(WCAG);
  const results = await (selector ? builder.include(selector) : builder).analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

/** Light and dark pictures of a page (or one element of it). */
async function shoot(page: Page, name: string, target?: ReturnType<Page["locator"]>): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    if (target) await target.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`), animations: "disabled" });
    else await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** The invite page at phone width, light and dark, with no sideways scrolling. */
async function phone(browser: Browser, url: string, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await fresh(browser, scheme, { width: 390, height: 844 });
    const p = await ctx.newPage();
    await p.goto(url);
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scrolling on a phone").toBe(true);
    expect(await serious(p), `${name} ${scheme}`).toEqual([]);
    await p.screenshot({ path: join(SHOTS, `${name}-phone-${scheme}.png`), fullPage: true });
    await ctx.close();
  }
}

test.describe("members and invite links (ADR-0024)", () => {
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
        SIGNUP_LIMIT_PER_IP: "unlimited",
        INVITE_OPENS_PER_IP: "unlimited",
        INVITE_ACCEPTS_PER_IP: "unlimited",
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

  test("an owner invites, a second person joins through the invite page, then is made a viewer and removed", async ({ page, context, browser }) => {
    test.setTimeout(300_000);
    await context.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
    await page.setViewportSize({ width: 1280, height: 900 });

    // ---- The owner signs in; a new account has its own workspace.
    issuer.reset({ sub: `sub-owner-${Date.now()}`, name: "Grace Hopper", email: "grace@example.org" });
    await page.goto(`${siteUrl}/app/`);
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
    const wsName = "Grace Hopper's workspace";
    const tree = page.getByRole("tree", { name: "Workspaces" });
    await expect(tree.getByRole("treeitem", { name: new RegExp(`^${wsName}`) })).toBeVisible();

    // ---- "Members…": the owner alone; an invite link for five people as an editor.
    await page.getByRole("button", { name: `Members of ${wsName}` }).click();
    const dialog = page.getByRole("dialog", { name: `Members of “${wsName}”` });
    await expect(dialog.getByRole("list", { name: "Members" }).getByRole("listitem")).toHaveCount(1);
    await expect(dialog.getByRole("list", { name: "Members" })).toContainText("Grace Hopper (you)");
    const invite = dialog.getByRole("region", { name: "Invite people" });
    await expect(invite.getByRole("radio", { name: "Editor" })).toBeChecked();
    await invite.getByRole("radio", { name: "5 people" }).check();
    await invite.getByRole("button", { name: "Create invite link" }).click();
    const field = invite.getByRole("textbox", { name: "Invite link" });
    await expect(field).toBeVisible();
    const url = await field.inputValue();
    expect(url).toMatch(new RegExp(`^${serverUrl}/i/[A-Za-z0-9_-]{32}$`));
    await expect(invite.getByRole("list", { name: "Active invite links" }).getByRole("listitem")).toHaveCount(1);
    await expect(invite.getByRole("list", { name: "Active invite links" })).toContainText("Editor · 5 places left");
    expect(await serious(page, '[role="dialog"]')).toEqual([]);
    await shoot(page, "dialog-owner-invite", dialog);
    await dialog.getByRole("button", { name: "Done" }).click();

    // ---- A second person opens the link with nothing stored: the invite page, signed out.
    const guestContext = await fresh(browser);
    const guest = await guestContext.newPage();
    const logs: string[] = [];
    guest.on("console", (m) => void (m.type() === "error" && logs.push(m.text())));
    const opened = await guest.goto(url);
    expect(opened!.status()).toBe(200);
    expect(opened!.headers()["content-security-policy"]).toContain("default-src 'none'");
    expect(opened!.headers()["content-security-policy"]).toContain("form-action 'self'");
    await expect(guest.getByRole("heading", { level: 1, name: `Join ${wsName}` })).toBeVisible();
    await expect(guest.getByText("Grace Hopper invited you to join")).toBeVisible();
    await expect(guest.getByText(/as an editor/)).toBeVisible();
    expect(await guest.evaluate(() => document.scripts.length)).toBe(0);
    expect(await guest.content()).not.toContain("grace@example.org");
    expect(await serious(guest)).toEqual([]);
    await shoot(guest, "invite-signed-out");
    await phone(browser, url, "invite-signed-out");

    // ---- "Sign in with Google to join" -> the broker -> back to the join form (nothing joined yet).
    issuer.reset({ sub: `sub-guest-${Date.now()}`, name: "Linus Pauling", email: "linus@example.org" });
    await guest.getByRole("link", { name: "Sign in with Google to join" }).click();
    await expect(guest).toHaveURL(`${serverUrl}/i/accept`);
    await expect(guest.getByText("Signed in as Linus Pauling")).toBeVisible();
    const join = guest.getByRole("button", { name: "Join workspace" });
    await expect(join).toBeVisible();
    expect(await serious(guest)).toEqual([]);
    await shoot(guest, "invite-ready");
    const guestId = (await ref.db.query<{ user_id: string }>("SELECT user_id FROM identities WHERE subject = $1", [issuer.profile.sub])).rows[0]!.user_id;
    const ws = (await ref.db.query<{ id: string }>("SELECT id FROM workspaces WHERE name = $1", [wsName])).rows[0]!.id;
    expect((await ref.db.query("SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2", [ws, guestId])).rowCount).toBe(0);

    // ---- "Join workspace": a POST; then "Open in Thoth" and how to add it in the desktop app.
    await join.click();
    await expect(guest.getByRole("heading", { level: 1, name: `You joined ${wsName}` })).toBeVisible();
    await expect(guest.getByText("You are an editor of this workspace now.")).toBeVisible();
    await expect(guest.getByText(/In the Thoth desktop app, add/)).toBeVisible();
    expect(await serious(guest)).toEqual([]);
    await shoot(guest, "invite-joined");
    expect((await ref.db.query<{ role: string }>("SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2", [ws, guestId])).rows[0]?.role).toBe("editor");

    // ---- Opening the link again: "already a member", nothing changes.
    await guest.goto(url);
    await guest.getByRole("link", { name: "Sign in with Google to join" }).click();
    await expect(guest.getByRole("heading", { level: 1, name: `You are already a member of ${wsName}` })).toBeVisible();
    await expect(guest.getByText("Your role stays editor. Nothing was changed.")).toBeVisible();
    await shoot(guest, "invite-already-member");
    // Nothing on the invite pages was refused or failed (no script, every style and font from this origin).
    expect(logs).toEqual([]);

    // ---- A dead token: the not-found page.
    await guest.goto(`${serverUrl}/i/${"Q".repeat(32)}`);
    await expect(guest.getByRole("heading", { level: 1, name: "This invite is not available" })).toBeVisible();
    await shoot(guest, "invite-not-found");
    await phone(browser, `${serverUrl}/i/${"Q".repeat(32)}`, "invite-not-found");

    // ---- "Open in Thoth": the web client; signing in there shows the joined workspace in the sidebar.
    await guest.goto(url);
    await guest.getByRole("link", { name: "Sign in with Google to join" }).click();
    await guest.getByRole("link", { name: "Open in Thoth" }).click();
    await expect(guest).toHaveURL(`${siteUrl}/app/`);
    await guest.getByRole("button", { name: "Sign in with Google" }).click();
    await expect(guest.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
    const guestTree = guest.getByRole("tree", { name: "Workspaces" });
    await expect(guestTree.getByRole("treeitem", { name: new RegExp(`^${wsName}`) })).toBeVisible();

    // ---- The owner sees them, and makes them a viewer.
    await page.getByRole("button", { name: `Members of ${wsName}` }).click();
    await expect(dialog.getByRole("list", { name: "Members" }).getByRole("listitem")).toHaveCount(2);
    await dialog.getByRole("combobox", { name: "Role of Linus Pauling" }).selectOption("viewer");
    await expect(dialog.getByRole("status")).toHaveText("Linus Pauling is now Viewer.");
    expect((await ref.db.query<{ role: string }>("SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2", [ws, guestId])).rows[0]?.role).toBe("viewer");
    await shoot(page, "dialog-owner-members", dialog);

    // ---- The viewer's own view of the dialog: read-only, with Leave.
    await guest.reload();
    await guest.getByRole("button", { name: `Members of ${wsName}` }).click();
    const guestDialog = guest.getByRole("dialog", { name: `Members of “${wsName}”` });
    await expect(guestDialog.getByRole("list", { name: "Members" }).getByRole("listitem")).toHaveCount(2);
    await expect(guestDialog.getByRole("combobox")).toHaveCount(0);
    await expect(guestDialog.getByRole("region", { name: "Invite people" })).toHaveCount(0);
    await expect(guestDialog.getByRole("button", { name: "Leave workspace" })).toBeVisible();
    expect(await serious(guest, '[role="dialog"]')).toEqual([]);
    await shoot(guest, "dialog-viewer", guestDialog);
    await guestDialog.getByRole("button", { name: "Done" }).click();

    // ---- The owner removes them; the workspace leaves their sidebar.
    await dialog.getByRole("button", { name: "Remove Linus Pauling from the workspace" }).click();
    await dialog.getByRole("group", { name: "Remove Linus Pauling?" }).getByRole("button", { name: "Remove member" }).click();
    await expect(dialog.getByRole("list", { name: "Members" }).getByRole("listitem")).toHaveCount(1);
    expect((await ref.db.query("SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2", [ws, guestId])).rowCount).toBe(0);
    await guest.reload();
    await expect(guest.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
    await expect(guestTree.getByRole("treeitem", { name: new RegExp(`^${wsName}`) })).toHaveCount(0);
    await guestContext.close();
  });
});
