/**
 * Feedback (ADR-0033) end to end, against the real reference server (PostgreSQL in Podman): the desktop app on the real
 * Rust host, signed in to the server, Settings → Help and feedback → Send feedback; the message arrives with the account
 * and the details the dialog showed, and nothing about the Private Space. (The website's support page is tested in the
 * website's own repository, ADR-0039.)
 *
 * Pictures (light and dark) go to tests/.tmp/feedback/.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "../ports/harness.ts";
import { opaqueId } from "../../apps/server/src/ids.ts";
import type { FakeIssuer } from "../../apps/server/test-db/fakes.ts";
import { axe } from "./assistant.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { actAsBrowser, startReferenceServer, type ReferenceServer } from "./reference-server.ts";
import { settled } from "./settled.ts";
import { buildAll } from "./setup.ts";

const SHOTS = join(REPO, "tests", ".tmp", "feedback");
const HOST_LIB = readFileSync(join(REPO, "crates/thoth-host/src/lib.rs"), "utf8");
const HOST_HAS_SERVERS = /"server\.add"/.test(HOST_LIB) && /"api\.call"/.test(HOST_LIB);

const rows = async (ref: ReferenceServer) => (await ref.db.query<{ kind: string; message: string; email: string | null; context: Record<string, string> | null; account_id: string | null }>("SELECT kind, message, email, context, account_id FROM feedback ORDER BY created_at")).rows;

test.describe("Send feedback in the desktop app (ADR-0033)", () => {
  test.skip(!HOST_HAS_SERVERS, "Pending on the Rust side: crates/thoth-host does not list the server.* and api.call commands yet.");
  const SUBJECT = "sub-e2e-feedback";
  let built: { dist: string; bridgeDir: string; binary: string };
  let ref: ReferenceServer;
  let issuer: FakeIssuer;
  let scratch: string;
  let bridge: Bridge;
  let opened: string[];

  test.beforeAll(async () => {
    await mkdir(SHOTS, { recursive: true });
    built = await buildAll();
    ref = await startReferenceServer({ issuer: true });
    issuer = ref.issuer!;
    issuer.reset({ sub: SUBJECT, name: "Ada Lovelace", email: "ada@example.org" });
  });
  test.afterAll(async () => {
    await ref?.close();
  });

  test.beforeEach(async ({ page, context }) => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-fb-")));
    await mkdir(join(scratch, "Vault"));
    await writeFile(join(scratch, "Vault", "Secret plan.md"), "# Secret plan\n\nDo not send.\n");
    opened = [];
    bridge = await startBridge({
      dist: built.dist,
      bridgeDir: built.bridgeDir,
      host: { binary: built.binary, pickVault: join(scratch, "Vault"), dataDir: join(scratch, "data"), onHostEvent: (event, payload) => void (event === "browser.open" && opened.push((payload as { url: string }).url)) },
    });
    await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
    await page.addInitScript(bridge.initScript);
    await page.goto(bridge.url);
    await page.getByRole("button", { name: /choose or create a private space/i }).click();
  });
  test.afterEach(async ({ page }) => {
    await page.close();
    await bridge.close();
    await rm(scratch, { recursive: true, force: true });
  });

  test("signed in, the message reaches the server with the account and exactly the details shown", async ({ page }) => {
    const ada = opaqueId("usr");
    await ref.db.query("INSERT INTO users (id, display_name, email) VALUES ($1, 'Ada Lovelace', 'ada@example.org')", [ada]);
    await ref.db.query("INSERT INTO identities (provider, subject, user_id) VALUES ('google', $1, $2)", [SUBJECT, ada]);

    await page.getByRole("button", { name: "Settings" }).click();
    const servers = page.getByRole("region", { name: "Servers" });
    await servers.getByRole("textbox", { name: "Server address" }).fill(ref.url);
    await servers.getByRole("button", { name: "Add server" }).click();
    const card = servers.getByRole("article");
    await card.getByRole("button", { name: "Sign in with Google" }).click();
    await expect.poll(() => opened.length, { timeout: 15_000 }).toBe(1);
    await actAsBrowser(opened[0]!);
    await expect(card.getByTestId("server-account")).toHaveText(/Signed in as Ada Lovelace/, { timeout: 15_000 });

    const section = page.getByRole("region", { name: "Help and feedback" });
    await section.getByRole("button", { name: "Send feedback…" }).click();
    const dialog = page.getByRole("dialog", { name: "Send feedback" });
    await expect(dialog.getByText(/^Sent to /)).toBeVisible();
    await dialog.getByRole("radio", { name: "A problem" }).check();
    await dialog.getByRole("textbox", { name: "Your message" }).fill("The sidebar froze after a drag.");
    const shown = (await dialog.locator(".feedback-details li").allTextContents()).map((line) => line.split(": ") as [string, string]);
    expect(shown.map(([k]) => k)).toEqual(expect.arrayContaining(["client", "os", "language"]));
    for (const dark of [false, true]) {
      await page.evaluate((night) => document.documentElement.setAttribute("data-theme", night ? "night" : "light"), dark);
      await settled(page);
      await dialog.screenshot({ path: join(SHOTS, `desktop-dialog-${dark ? "dark" : "light"}.png`) });
      await axe(page, ".modal");
    }
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

    // An empty message is refused in the dialog, with the focus on the field.
    await dialog.getByRole("textbox", { name: "Your message" }).fill("");
    await dialog.getByRole("button", { name: "Send" }).click();
    await expect(dialog.getByRole("textbox", { name: "Your message" })).toBeFocused();
    await expect(dialog.getByRole("textbox", { name: "Your message" })).toHaveAttribute("aria-invalid", "true");
    expect(await rows(ref)).toEqual([]);

    // The app log (ADR-0040): off on open; the bridge keeps no log, so ticking it says so and the message still goes.
    const logBox = dialog.getByRole("checkbox", { name: "Include recent app log" });
    await expect(logBox).not.toBeChecked();
    await logBox.check();
    await expect(dialog.getByText("No log yet.")).toBeVisible();
    await dialog.getByRole("textbox", { name: "Your message" }).fill("The sidebar froze after a drag.");
    await dialog.getByRole("button", { name: "Send" }).click();
    await expect(dialog.getByRole("status")).toHaveText("Thank you. Your message was sent.");
    await dialog.screenshot({ path: join(SHOTS, "desktop-dialog-sent-light.png") });
    const stored = await rows(ref);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "problem", message: "The sidebar froze after a drag.", email: null, account_id: ada });
    expect(stored[0]!.context).toEqual(Object.fromEntries(shown));
    expect(JSON.stringify(stored)).not.toMatch(/Secret plan|Vault/);
  });
});
