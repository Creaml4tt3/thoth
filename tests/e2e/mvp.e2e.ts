/**
 * Phase 5: the MVP end-to-end scenario (spec §14, docs/architecture/implementation-plan.md). One person, twelve steps,
 * in order, on the real desktop UI in Chromium (the e2e bridge to the real Rust host, `thoth-host-stdio`), the real
 * reference server (PostgreSQL in Podman, the local OIDC test issuer) and the fake `claude` CLI. Each test is one
 * step (2 and 3 are done per source); they share one browser context, one app data folder and three vaults, and a
 * failed step skips the rest.
 *
 * Driven through the UI: every step except the checks, and except these, which have no UI and use what the UI uses:
 * - the server's accounts, workspaces and memberships are seeded in SQL (its admin's job), and Ada's token reads the
 *   workspace for the checks of steps 5–8;
 * - step 3 also reads the vaults' link index through the Node runtime of `@thoth/local-store`, once the app is closed;
 * - step 8 interrupts at a state boundary by holding the host's `api.call` at the commit (the bridge's `holdNext`) and
 *   killing the host, as a crash or a force quit would: the transfer engine's `checkpoint` hook is a unit-test seam
 *   the app does not expose. The harness keeps the sign-in in a file (`--secrets-file`), standing in for the system
 *   keychain, so the restarted app is still signed in, as the desktop app is;
 * - step 11 calls the host's endpoints with `fetch` from the pages, and step 12 calls the server with plain HTTP:
 *   that is what those steps are about.
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@thoth/content";
import { isStableId, newStableId, sha256Hex } from "@thoth/domain";
import { openNodeVault } from "@thoth/local-store/node";
import { REPO } from "../ports/harness.ts";
import { FAKE_CLAUDE_DIR, fakeRecord } from "../helpers/agent.ts";
import { mascot, openBubble, openReview, picker, pickOnly, writeAndStart } from "./assistant.ts";
import { snapshotTree } from "../helpers/fs.ts";
import { dirEntries, writeZip } from "../helpers/zip.ts";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";
import { actAsBrowser, apiAs, buildWebClient, freePort, serveWebClient, startReferenceServer, type ReferenceServer } from "./reference-server.ts";
import { desktopOnlyIn } from "../../apps/web/test/bundle.ts";
import { generateToken, hashToken } from "../../apps/server/src/auth.ts";
import { opaqueId } from "../../apps/server/src/ids.ts";

let built: { dist: string; bridgeDir: string; binary: string };
let ref: ReferenceServer;
let sitePort: number;
let scratch: string;
/** The app's data folder, shared by every session as one installation's is. */
let data: string;
const vaults = { mine: "", notion: "", obsidian: "" };

let context: BrowserContext;
let bridge: Bridge | undefined;
let page: Page;
/** Every request the pages tried to make to anything but the bridge (each one is refused). */
const offBridge: string[] = [];
/** `browser.open` events from the harness: the URLs the host asked the system browser to open. */
const opened: string[] = [];

/** The test issuer's subject for Ada's Google account. */
const SUBJECT = "sub-e2e-mvp-ada";
const people = { ada: opaqueId("usr"), grace: opaqueId("usr") };
const tokens = { ada: generateToken(), grace: generateToken() };
const spaces = { studio: opaqueId("ws"), finance: opaqueId("ws") };
/** What steps 5–6 sent: the vault bytes of the moved pages and the picture, and the copy's ID in Studio. */
let moved: { home: Buffer; cafe: Buffer; diagram: Buffer; welcomeCopy: string };
/** Step 9's page before the agent ran. */
const agentRun = { cafe: Buffer.alloc(0) };

/** Starts the app on `vault` (the harness's folder picker returns it) and opens it, like choosing it on the start screen. */
async function openApp(vault: string, options: { source?: string } = {}): Promise<Page> {
  bridge = await startBridge({
    dist: built.dist,
    bridgeDir: built.bridgeDir,
    host: {
      binary: built.binary,
      pickVault: vault,
      ...(options.source ? { pickSource: options.source } : {}),
      dataDir: data,
      agentSearchDirs: [FAKE_CLAUDE_DIR],
      // The harness keeps sign-ins in memory; this file stands in for the system keychain, which outlives a restart.
      secretsFile: join(data, "keychain.json"),
      // Neither may reach the agent CLI (step 9): Thoth's own variables, and anything naming the open vault.
      env: { THOTH_E2E_SECRET: "do-not-pass", NOTES_FOR_E2E: join(vault, "Obsidian") },
      onHostEvent: (event, payload) => {
        if (event === "browser.open") opened.push((payload as { url: string }).url);
      },
    },
  });
  page = await context.newPage();
  await page.addInitScript(bridge.initScript);
  await page.goto(bridge.url);
  await page.getByRole("button", { name: /choose or create a private space/i }).click();
  return page;
}

async function closeApp(): Promise<void> {
  await page?.close().catch(() => undefined);
  await bridge?.close();
  bridge = undefined;
}

async function editor(p: Page) {
  const box = p.getByRole("textbox", { name: /page content/i });
  await expect(box).toBeVisible();
  return box;
}

/**
 * Puts the caret at the end of the block that reads `text`, as a person does (click, End), and waits until the editor
 * has it there: ProseMirror reads a click's selection a tick later, and a page that is still loading can replace the
 * document under the caret.
 */
async function caretAtEnd(box: Locator, text: string): Promise<void> {
  const where = () =>
    box.evaluate((el) => {
      const { $from } = (el as unknown as { editor: { state: { selection: { $from: { parent: { textContent: string }; parentOffset: number } } } } }).editor.state.selection;
      return `${$from.parent.textContent}@${$from.parentOffset}`;
    });
  await expect(async () => {
    await box.getByText(text, { exact: true }).click();
    await box.page().keyboard.press("End");
    expect(await where()).toBe(`${text}@${text.length}`);
  }).toPass({ timeout: 10_000 });
}

/** A tree row by its vault path. */
const rowAt = (p: Page, path: string): Locator => p.locator(`[data-tree-id="${path}"]`);

/** Opens a folder row in the Private Space tree (a no-op when it is open). */
async function expandFolder(path: string): Promise<void> {
  const row = rowAt(page, path);
  await expect(row).toBeVisible();
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
}

/** Every step of the import wizard, from the start screen or Settings, to its report. */
async function importThroughWizard(system: "notion" | "obsidian", pick: "zip" | "folder", destination: string): Promise<Locator> {
  await page.getByRole("button", { name: /import from notion or obsidian/i }).filter({ hasText: /import/i }).click();
  await page.getByRole("radio", { name: new RegExp(system, "i") }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /i have it ready/i }).click();
  await page.getByRole("button", { name: pick === "zip" ? /choose zip file/i : /choose folder/i }).click();
  await expect(page.getByText(/Preview of/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("region", { name: "Import" }).getByRole("textbox").fill(destination);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /start import/i }).click();
  const report = page.getByTestId("import-report");
  await expect(report.getByText("Import complete")).toBeVisible({ timeout: 60_000 });
  return report;
}

const NOTION_FIXTURE = join(REPO, "tests/fixtures/notion-export");
const OBSIDIAN_FIXTURE = join(REPO, "tests/fixtures/obsidian-vault");
const HANDBOOK = "Notion/Thoth Handbook";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

test.describe.serial("the MVP, end to end (spec §14)", () => {
  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    offBridge.length = 0;
    opened.length = 0;
    built = await buildAll();
    // The web client (step 11) is served from its own origin, which the server lets in.
    sitePort = await freePort();
    ref = await startReferenceServer({ issuer: true, env: { CORS_ORIGINS: `http://127.0.0.1:${sitePort}`, WEB_REDIRECT_URIS: `http://127.0.0.1:${sitePort}/app/callback` } });
    scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-mvp-")));
    data = join(scratch, "data");
    await mkdir(data);
    for (const name of Object.keys(vaults) as (keyof typeof vaults)[]) {
      vaults[name] = join(scratch, `vault-${name}`);
      await mkdir(vaults[name]);
    }
    context = await browser.newContext();
    // The page reaches only the bridge of the session that is running; the server is reached by the host.
    await context.route(
      (url) => !(bridge && url.href.startsWith(bridge.url)),
      (route) => {
        offBridge.push(route.request().url());
        return route.abort();
      },
    );
  });

  test.afterAll(async () => {
    await closeApp().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await ref?.close().catch(() => undefined);
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  test("1. create Markdown notes privately, with no network", async () => {
    await openApp(vaults.mine);
    await page.getByRole("button", { name: /start writing/i }).click();

    const create = async (name: string, line: string) => {
      await page.getByRole("button", { name: "New page" }).click();
      const dialog = page.getByRole("dialog", { name: "New page" });
      await dialog.getByRole("textbox").fill(name);
      await dialog.getByRole("button", { name: "Create" }).click();
      const box = await editor(page);
      await caretAtEnd(box, name.split("/").pop()!);
      await page.keyboard.press("Enter");
      await page.keyboard.type(line);
      await page.keyboard.press("ControlOrMeta+s");
    };
    await create("Journal/Today", "Written with no network.");
    await create("Ideas", "A second note.");

    await expect.poll(() => readFile(join(vaults.mine, "Journal/Today.md"), "utf8").catch(() => "")).toMatch(new RegExp(`^---\\nthoth_id: ${UUID}\\n---\\n# Today\\n\\nWritten with no network\\.\\n$`));
    await expect.poll(() => readFile(join(vaults.mine, "Ideas.md"), "utf8").catch(() => "")).toMatch(new RegExp(`^---\\nthoth_id: ${UUID}\\n---\\n# Ideas\\n\\nA second note\\.\\n$`));
    expect((await readdir(vaults.mine)).sort()).toEqual([".thoth", "Ideas.md", "Journal"]);
    // Nothing but the bridge was asked for, and the host knows no server.
    expect(offBridge).toEqual([]);
    await expect(readFile(join(data, "servers.json"))).rejects.toThrow();
    await closeApp();
  });

  test("2–3 (Notion). import a Notion export into its own vault: nested pages, attachments, metadata, links that resolve", async () => {
    const zip = await writeZip(join(scratch, "notion-export.zip"), await dirEntries(NOTION_FIXTURE));
    const zipBefore = await readFile(zip);
    await openApp(vaults.notion, { source: zip });
    const report = await importThroughWizard("notion", "zip", "Notion");
    await expect(report.getByRole("group", { name: "Import results" })).toContainText(/9\s*pages imported\s*3\s*attachments\s*2\s*databases/);
    // The one unresolved link is the fixture's page that is not in the export (Archived Roadmap).
    await expect(report).toContainText("Links: 18 resolved, 1 unresolved, 0 ambiguous.");
    await expect(report).toContainText(/Archived%20Roadmap[^"]*\.md" was not found in the import/);
    await report.getByRole("button", { name: "Close" }).click();

    // The tree has the hierarchy: the handbook, its Engineering section and the page nested under it.
    for (const folder of ["Notion", HANDBOOK, `${HANDBOOK}/Engineering`]) await expandFolder(folder);
    await expect(rowAt(page, `${HANDBOOK}/Engineering/Deep Dive.md`)).toBeVisible();
    // Deep Dive's backlink is the Engineering page that links to it.
    await rowAt(page, `${HANDBOOK}/Engineering/Deep Dive.md`).click();
    await expect(page.getByRole("region", { name: /^Backlinks/ })).toContainText("Engineering");
    await closeApp();

    // On disk: the attachment bytes, the provenance and the CSV are the export's; the export itself is untouched.
    const fixtureDir = join(NOTION_FIXTURE, "Thoth Handbook 1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6");
    expect(await readFile(join(vaults.notion, HANDBOOK, "Project Atlas/diagram.png"))).toEqual(await readFile(join(fixtureDir, "Project Atlas/diagram.png")));
    expect(await readFile(join(vaults.notion, HANDBOOK, "Tasks_all.csv"))).toEqual(await readFile(join(fixtureDir, "Tasks 8b9c0d1e2f3a4e15c6d7e8f901122334_all.csv")));
    const atlas = await readFile(join(vaults.notion, HANDBOOK, "Project Atlas.md"), "utf8");
    expect(parseFrontmatter(atlas).data["thoth_source"]).toMatchObject({ system: "notion", sourceId: "6f708192a3b44cf3a4b5c6d7e8f90112" });
    expect(isStableId(parseFrontmatter(atlas).data["thoth_id"] as string)).toBe(true);
    expect(Buffer.compare(await readFile(zip), zipBefore)).toBe(0);

    // The link index the app built: every link resolves.
    const { vault } = await openNodeVault(vaults.notion);
    try {
      // Every link resolves but the one to the page the export does not have.
      expect((await vault.unresolvedLinks()).map((u) => `${u.sourcePath} -> ${u.resolution}`)).toEqual([`${HANDBOOK}.md -> unresolved`]);
      expect((await vault.unresolvedLinks())[0]!.target).toContain("Archived Roadmap");
      expect((await vault.backlinks(`${HANDBOOK}/Project Atlas/diagram.png`)).map((b) => b.sourcePath)).toEqual([`${HANDBOOK}/Project Atlas.md`]);
      expect((await vault.backlinks(`${HANDBOOK}/Engineering/Deep Dive.md`)).map((b) => b.sourcePath)).toEqual([`${HANDBOOK}/Engineering.md`]);
    } finally {
      await vault.close();
    }
  });

  test("2–3 (Obsidian). import an Obsidian vault into another vault: nested pages, attachments, frontmatter, links that resolve", async () => {
    const sourceBefore = await snapshotTree(OBSIDIAN_FIXTURE);
    await openApp(vaults.obsidian, { source: OBSIDIAN_FIXTURE });
    const report = await importThroughWizard("obsidian", "folder", "Obsidian");
    await expect(report.getByRole("group", { name: "Import results" })).toContainText(/11\s*pages imported\s*2\s*attachments\s*0\s*databases/);
    // The fixture's two deliberate problems, and nothing else: [[Does Not Exist]] and the ambiguous [[Alpha]].
    await expect(report).toContainText(/Links: \d+ resolved, 1 unresolved, 1 ambiguous\./);
    await report.getByRole("button", { name: "Close" }).click();

    for (const folder of ["Obsidian", "Obsidian/Projects", "Obsidian/บันทึก"]) await expandFolder(folder);
    await expect(rowAt(page, "Obsidian/Projects/Beta.md")).toBeVisible();
    await expect(rowAt(page, "Obsidian/บันทึก/การประชุม 🚀.md")).toBeVisible();
    await rowAt(page, "Obsidian/Home.md").click();
    const backlinks = page.getByRole("region", { name: /^Backlinks/ });
    await expect(backlinks).toContainText("Beta");
    await expect(backlinks).toContainText("การประชุม 🚀");
    await closeApp();

    // Frontmatter kept (unknown keys and nested maps too), identity and provenance added, body byte-identical.
    const home = await readFile(join(vaults.obsidian, "Obsidian/Home.md"), "utf8");
    const fm = parseFrontmatter(home).data;
    expect(fm).toMatchObject({ aliases: ["Home Page", "Index"], tags: ["hub", "project/thoth"], cssclasses: ["wide-page"], publish: true, custom: { owner: "Somchai", review: { status: "draft", due: "2026-11-01" } } });
    expect(isStableId(fm["thoth_id"] as string)).toBe(true);
    expect(fm["thoth_source"]).toMatchObject({ system: "obsidian", sourcePath: "Home.md" });
    const original = await readFile(join(OBSIDIAN_FIXTURE, "Home.md"), "utf8");
    expect(home.endsWith(original.slice(original.indexOf("# Home")))).toBe(true);
    expect(await readFile(join(vaults.obsidian, "Obsidian/Attachments/diagram.png"))).toEqual(await readFile(join(OBSIDIAN_FIXTURE, "Attachments/diagram.png")));
    expect(await readFile(join(vaults.obsidian, "Obsidian/Attachments/report.pdf"))).toEqual(await readFile(join(OBSIDIAN_FIXTURE, "Attachments/report.pdf")));
    await expect(readdir(join(vaults.obsidian, "Obsidian/.obsidian"))).rejects.toThrow(); // settings and plugin code are never imported
    expect(await snapshotTree(OBSIDIAN_FIXTURE)).toEqual(sourceBefore);

    const { vault } = await openNodeVault(vaults.obsidian);
    try {
      expect((await vault.unresolvedLinks()).map((u) => `${u.sourcePath} -> ${u.target} (${u.resolution})`)).toEqual(["Obsidian/Home.md -> Does Not Exist (unresolved)", "Obsidian/Meeting Notes.md -> Alpha (ambiguous)"]);
      expect((await vault.backlinks("Obsidian/Attachments/diagram.png")).map((b) => b.sourcePath)).toEqual(["Obsidian/Home.md", "Obsidian/Home.md"]);
      expect((await vault.backlinks("Obsidian/Welcome.md")).map((b) => b.sourcePath).sort()).toEqual(["Obsidian/Home.md", "Obsidian/Meeting Notes.md"]);
      expect((await vault.backlinks("Obsidian/Café.md")).map((b) => b.sourcePath)).toContain("Obsidian/Home.md");
    } finally {
      await vault.close();
    }
  });

  test("4. connect to the reference server: add it in Settings and sign in through the provider", async () => {
    // What the server's admin set up: Ada (signs in with Google) owns "Studio", where Grace is a viewer, and "Finance",
    // where Grace is not a member. Ada's own token is only for the test's checks on the server.
    await ref.db.query("INSERT INTO users (id, display_name, email) VALUES ($1, 'Ada Lovelace', 'ada@example.org'), ($2, 'Grace', NULL)", [people.ada, people.grace]);
    await ref.db.query("INSERT INTO identities (provider, subject, user_id) VALUES ('google', $1, $2)", [SUBJECT, people.ada]);
    await ref.db.query("INSERT INTO access_tokens (id, user_id, token_hash) VALUES ($1, $2, $3), ($4, $5, $6)", [opaqueId("tok"), people.ada, hashToken(tokens.ada), opaqueId("tok"), people.grace, hashToken(tokens.grace)]);
    await ref.db.query("INSERT INTO workspaces (id, name, export_restricted) VALUES ($1, 'Studio', false), ($2, 'Finance', false)", [spaces.studio, spaces.finance]);
    await ref.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $3, 'owner'), ($1, $4, 'viewer'), ($2, $3, 'owner')", [spaces.studio, spaces.finance, people.ada, people.grace]);
    ref.issuer!.reset({ sub: SUBJECT, name: "Ada Lovelace", email: "ada@example.org" });

    await openApp(vaults.obsidian);
    await expect(page.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();
    const servers = page.getByRole("region", { name: "Servers" });
    await servers.getByRole("textbox", { name: "Server address" }).fill(ref.url);
    await servers.getByRole("button", { name: "Add server" }).click();
    const card = servers.getByRole("article");
    await expect(card).toContainText(ref.url);
    // The host asks the system browser to open the sign-in page; the test is that browser.
    await card.getByRole("button", { name: "Sign in with Google" }).click();
    await expect.poll(() => opened.length, { timeout: 15_000 }).toBe(1);
    expect(opened[0]!.startsWith(`${ref.url}/auth/authorize?`)).toBe(true);
    await actAsBrowser(opened[0]!);
    await expect(card.getByTestId("server-account")).toHaveText(/Signed in as Ada Lovelace/, { timeout: 15_000 });
    // Both workspaces are listed; no credential ever reaches the page.
    const list = page.getByRole("tree", { name: /^Workspaces on / });
    await expect(list.getByRole("treeitem", { name: /^Studio/ })).toBeVisible();
    await expect(list.getByRole("treeitem", { name: /^Finance/ })).toBeVisible();
    expect(await page.evaluate<string>("JSON.stringify({ ...localStorage }) + document.documentElement.outerHTML")).not.toMatch(/thoth_(pat|at|rt)_|"refresh_token"|access_token/);
  });

  test("5–6. copy, then move, selected pages to a workspace: content, hashes, the attachment and link mapping on the server", async () => {
    const tree = page.getByRole("tree", { name: "Pages in this Private Space" });
    await expandFolder("Obsidian");
    const local = (path: string) => readFile(join(vaults.obsidian, "Obsidian", path));
    const before = { welcome: await local("Welcome.md"), home: await local("Home.md"), cafe: await local("Café.md"), diagram: await local("Attachments/diagram.png") };

    // Copy Welcome (the page Home reaches through its alias [[Start]]).
    await rowAt(page, "Obsidian/Welcome.md").click();
    await page.getByRole("button", { name: "Select pages" }).click();
    await expect(tree.getByRole("checkbox", { name: "Select Welcome" })).toBeChecked();
    await page.getByRole("button", { name: "Copy to workspace…" }).click();
    const copy = page.getByRole("dialog", { name: "Copy 1 page to a workspace" });
    await copy.getByRole("combobox", { name: "Workspace" }).selectOption({ label: "Studio" });
    const copyPreview = copy.getByRole("region", { name: "Who can see it" });
    await expect(copyPreview).toContainText("Everyone in this workspace (2 members) can see these pages.");
    await expect(copyPreview).toContainText("Grace");
    await expect(copyPreview).toContainText("Nothing has left this computer yet.");
    await copy.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(copy.getByRole("status")).toContainText("1 page was copied to Studio. Every page was checked at the destination.", { timeout: 20_000 });
    await copy.locator(".modal-actions").getByRole("button", { name: "Close" }).click();

    // Move Home (with its picture, and links to Café in the same selection and to Welcome, already copied) and Café.
    await page.getByRole("button", { name: "Select pages" }).click();
    await tree.getByRole("checkbox", { name: "Select Welcome" }).uncheck();
    await tree.getByRole("checkbox", { name: "Select Home" }).check();
    await tree.getByRole("checkbox", { name: "Select Café" }).check();
    await page.getByRole("button", { name: "Move to workspace…" }).click();
    const move = page.getByRole("dialog", { name: "Move 2 pages to a workspace" });
    await move.getByRole("combobox", { name: "Workspace" }).selectOption({ label: "Studio" });
    const movePreview = move.getByRole("region", { name: "Who can see it" });
    await expect(movePreview).toContainText("1 attachment is uploaded");
    await expect(movePreview).toContainText(/point to pages or files in this transfer/);
    await expect(movePreview).toContainText(/point to pages already in the workspace/);
    await move.getByRole("button", { name: "Move", exact: true }).click();
    await expect(move.getByRole("status")).toContainText("2 pages were moved to Studio.", { timeout: 20_000 });
    await move.locator(".modal-actions").getByRole("button", { name: "Close" }).click();

    // The moved originals are gone, the copied one and the picture are not.
    const left = await readdir(join(vaults.obsidian, "Obsidian"));
    expect(left).not.toContain("Home.md");
    expect(left).not.toContain("Café.md");
    expect(await local("Welcome.md")).toEqual(before.welcome);
    expect(await local("Attachments/diagram.png")).toEqual(before.diagram);

    // On the server: three pages, each revision's hash is the hash of its Markdown, links travel by ID.
    const remote = await studioPages();
    expect(Object.keys(remote).sort()).toEqual(["Café", "Home", "Welcome"]);
    for (const p of Object.values(remote)) expect(p.revision.contentHash).toBe(sha256Hex(new TextEncoder().encode(p.markdown)));
    const idOf = (bytes: Buffer) => parseFrontmatter(bytes.toString("utf8")).data["thoth_id"] as string;
    // A move keeps the page's identity; a copy gets its own, written into its frontmatter.
    expect(remote["Home"]!.id).toBe(idOf(before.home));
    expect(remote["Café"]!.id).toBe(idOf(before.cafe));
    expect(remote["Welcome"]!.id).not.toBe(idOf(before.welcome));
    expect(remote["Welcome"]!.markdown).toBe(before.welcome.toString("utf8").replace(idOf(before.welcome), remote["Welcome"]!.id).replace("[[Start]]", `[[thoth:page/${remote["Welcome"]!.id}|Start]]`));
    expect(remote["Café"]!.markdown).toBe(before.cafe.toString("utf8"));
    // Home: byte for byte the vault's file, except each link to a page or file that travelled, which now names it by ID
    // (the original text kept as its label). Links to pages that stayed behind and the missing one are as written.
    const attachment = /!\[\[thoth:attachment\/([0-9a-f-]{36})\|diagram\.png\]\]/.exec(remote["Home"]!.markdown)?.[1];
    expect(attachment).toBeDefined();
    expect(remote["Home"]!.markdown).toBe(
      before.home
        .toString("utf8")
        .replace("[[Start]]", `[[thoth:page/${remote["Welcome"]!.id}|Start]]`)
        .replace("![[Café]]", `![[thoth:page/${remote["Café"]!.id}|Café]]`)
        .replace("[[Café]]", `[[thoth:page/${remote["Café"]!.id}|Café]]`)
        .replace("![[diagram.png]]", `![[thoth:attachment/${attachment}|diagram.png]]`)
        .replace("![[diagram.png|100]]", `![[thoth:attachment/${attachment}|100]]`),
    );
    // The picture's bytes and hash, as the server stores and serves them.
    const download = await fetch(`${ref.url}/api/v1/workspaces/${spaces.studio}/attachments/${attachment}`, { headers: { authorization: `Bearer ${tokens.ada}` } });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(before.diagram);
    const stored = (await ref.db.query<{ hash: string; size: string }>("SELECT hash, size::text FROM attachments WHERE workspace_id = $1 AND id = $2", [spaces.studio, attachment])).rows;
    expect(stored).toEqual([{ hash: sha256Hex(before.diagram), size: String(before.diagram.length) }]);
    moved = { home: before.home, cafe: before.cafe, diagram: before.diagram, welcomeCopy: remote["Welcome"]!.id };
  });

  test("7. edit the shared page in the workspace, then move it back to the Private Space", async () => {
    const list = page.getByRole("tree", { name: /^Workspaces on / });
    await list.getByRole("treeitem", { name: /^Studio/ }).click();
    const studio = page.getByRole("group", { name: "Pages in Studio" });

    // Edit Home in the workspace editor and save: the server gets a new revision.
    await studio.getByRole("treeitem", { name: "Home" }).click();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Workspace · Studio");
    const box = await editor(page);
    await caretAtEnd(box, "Home");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Edited in the workspace.");
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(async () => (await studioPages())["Home"]?.markdown ?? "").toContain("# Home\n\nEdited in the workspace.\n\nInline tag:");

    // Move both pages back from their workspace pages: Café, then Home.
    const moveBack = async (title: string) => {
      await studio.getByRole("treeitem", { name: title }).click();
      await page.getByRole("button", { name: "Move to Private Space…" }).click();
      const back = page.getByRole("dialog", { name: `Move “${title}” to your Private Space` });
      await expect(back.getByRole("region", { name: "Who can see it" })).toContainText("Nothing has been written to your Private Space yet.");
      await back.getByRole("button", { name: "Move", exact: true }).click();
      await expect(back.getByRole("status")).toContainText("1 page was moved to your Private Space.", { timeout: 20_000 });
      await back.locator(".modal-actions").getByRole("button", { name: "Close" }).click();
    };
    await moveBack("Café");
    await moveBack("Home");

    // Back where they were, with the edit; every link in vault form again (the picture is the one in the vault).
    const home = await readFile(join(vaults.obsidian, "Obsidian/Home.md"), "utf8");
    expect(home).toBe(moved.home.toString("utf8").replace("# Home\n\n", "# Home\n\nEdited in the workspace.\n\n"));
    expect(await readFile(join(vaults.obsidian, "Obsidian/Café.md"))).toEqual(moved.cafe);
    expect(await readFile(join(vaults.obsidian, "Obsidian/Attachments/diagram.png"))).toEqual(moved.diagram);
    // The workspace keeps only the copy.
    expect(Object.values(await studioPages()).map((p) => p.id)).toEqual([moved.welcomeCopy]);
    await expect(rowAt(page, "Obsidian/Home.md")).toBeVisible();
  });

  test("8. the app dies in the middle of a transfer: after a restart it recovers, and no source is lost", async () => {
    const projects = join(vaults.obsidian, "Obsidian/Projects");
    const beta = await readFile(join(projects, "Beta.md"));
    const spec = await readFile(join(projects, "Spec Doc.md"));
    const isCommit = (a: Record<string, unknown>) => a["method"] === "POST" && /^\/api\/v1\/transfers\/[^/]+\/commit$/.test(String(a["path"]));
    const operations = async () => {
      const dir = join(vaults.obsidian, ".thoth/operations");
      const names = (await readdir(dir)).filter((n) => n.endsWith(".json")); // journal/ and imports/ are the vault's own
      const records = await Promise.all(names.map(async (n) => JSON.parse(await readFile(join(dir, n), "utf8")) as { id: string; mode: string; state: string }));
      return Object.fromEntries(records.map((r) => [r.id, r]));
    };
    const before = await operations();
    const newest = async () => Object.values(await operations()).filter((r) => !before[r.id])[0]!;

    /** Selects one page in Obsidian/Projects and starts copying or moving it to Studio; `hold` stops the host at that call. */
    const startTransfer = async (title: string, mode: "Copy" | "Move", hold: (args: Record<string, unknown>) => boolean) => {
      const tree = page.getByRole("tree", { name: "Pages in this Private Space" });
      for (const folder of ["Obsidian", "Obsidian/Projects"]) await expandFolder(folder);
      await rowAt(page, `Obsidian/Projects/${title}.md`).click();
      await page.getByRole("button", { name: "Select pages" }).click();
      await expect(tree.getByRole("checkbox", { name: `Select ${title}` })).toBeChecked();
      await page.getByRole("button", { name: `${mode} to workspace…` }).click();
      const dialog = page.getByRole("dialog", { name: `${mode} 1 page to a workspace` });
      await dialog.getByRole("combobox", { name: "Workspace" }).selectOption({ label: "Studio" });
      await expect(dialog.getByRole("region", { name: "Who can see it" })).toContainText("Nothing has left this computer yet.");
      const held = bridge!.holdNext("api.call", hold);
      await dialog.getByRole("button", { name: mode, exact: true }).click();
      await held.reached;
    };
    const restart = async () => {
      await openApp(vaults.obsidian);
      await expect(page.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();
    };
    const recovery = () => page.getByRole("status").filter({ hasText: "Unfinished transfers" });
    const serverState = async (id: string) => (await ref.db.query<{ state: string }>("SELECT state FROM transfers WHERE operation_id = $1", [id])).rows[0]?.state;

    // A move of Beta dies just before its commit: the server has it staged, the vault still has it.
    await startTransfer("Beta", "Move", isCommit);
    await closeApp(); // the held call never returns: the host is gone, as after a crash or a force quit
    const interrupted = await newest();
    expect(interrupted.mode).toBe("move");
    expect(["transfer", "verify"]).toContain(interrupted.state);
    expect(await serverState(interrupted.id)).toBe("stage");
    expect(await readFile(join(projects, "Beta.md"))).toEqual(beta);
    await restart();
    await expect(recovery()).toContainText("1 transfer that was interrupted before it was saved at the destination was undone. The originals are unchanged.", { timeout: 20_000 });
    const rolledBack = await newest();
    expect(rolledBack).toMatchObject({ mode: "move", state: "aborted" });
    expect(await readFile(join(projects, "Beta.md"))).toEqual(beta);
    const serverSide = await ref.db.query<{ state: string; items: string }>("SELECT t.state, (SELECT count(*) FROM transfer_items i WHERE i.operation_id = t.operation_id AND i.markdown IS NOT NULL)::text AS items FROM transfers t WHERE t.operation_id = $1", [rolledBack.id]);
    expect(serverSide.rows).toEqual([{ state: "aborted", items: "0" }]);
    expect(Object.keys(await studioPages())).toEqual(["Welcome"]);
    await recovery().getByRole("button", { name: "Dismiss" }).click();

    // A copy of Spec Doc dies right after the server committed it: recovery finishes it, once.
    let committed = false;
    await startTransfer("Spec Doc", "Copy", (a) => committed || ((committed = isCommit(a)), false));
    await closeApp();
    const cut = Object.values(await operations()).find((r) => !before[r.id] && r.id !== rolledBack.id)!;
    expect(cut.state).not.toBe("done");
    expect(["done", "commit_destination"]).toContain(await serverState(cut.id)); // the server committed; the app never heard
    await restart();
    await expect(recovery()).toContainText("1 transfer that was interrupted when Thoth last closed has been finished.", { timeout: 20_000 });
    const finished = Object.values(await operations()).find((r) => !before[r.id] && r.id !== rolledBack.id)!;
    expect(finished).toMatchObject({ mode: "copy", state: "done" });
    const remote = await studioPages();
    expect(Object.keys(remote).sort()).toEqual(["Spec Doc", "Welcome"]);
    expect(remote["Spec Doc"]!.revision.contentHash).toBe(sha256Hex(new TextEncoder().encode(remote["Spec Doc"]!.markdown)));
    expect(remote["Spec Doc"]!.markdown).toContain("Deprecated singular `tag` key");
    expect(await readFile(join(projects, "Spec Doc.md"))).toEqual(spec);
    expect(await readFile(join(projects, "Beta.md"))).toEqual(beta);
    expect((await readdir(projects)).sort()).toEqual(["Alpha.md", "Beta.md", "Spec Doc.md"]);
    // No staged leftovers on the server, no temp files in the vault.
    expect((await ref.db.query("SELECT 1 FROM transfers WHERE state NOT IN ('done', 'aborted')")).rows).toEqual([]);
    expect(await readdir(join(vaults.obsidian, ".thoth/tmp")).catch(() => [])).toEqual([]);
    await recovery().getByRole("button", { name: "Dismiss" }).click();
  });

  test("9. ask the local AI CLI from the mascot, with one page as its only context, on the user's own login", async () => {
    agentRun.cafe = await readFile(join(vaults.obsidian, "Obsidian/Café.md"));
    const bubble = await openBubble(page);
    await expect(bubble.locator('option[value="claude"]')).toHaveText("Claude Code · Ready, 2.1.310");
    await pickOnly(page, ["Café"]);
    await expect(await picker(page)).toContainText("1 selected");
    await writeAndStart(page, `Tidy the spelling.\n@replace Obsidian/Café.md :: normalised => normalized\n@write Obsidian/Summary.md :: # Summary\\n`);
    await expect(bubble.getByRole("log", { name: "What the agent is doing" })).toContainText("Editing Obsidian/Café.md");
    await expect(mascot(page)).toHaveAccessibleName("Thoth assistant, changes ready for review", { timeout: 15_000 });

    // What the CLI was given: only the staged copy of that page, in a working directory of its own.
    await expect.poll(async () => (await readdir(join(data, "agent-runs")).catch(() => [])).length).toBe(1);
    const work = join(data, "agent-runs", (await readdir(join(data, "agent-runs")))[0]!, "work");
    const record = await fakeRecord(work);
    expect(record.files).toEqual([
      { path: "Obsidian", kind: "directory" },
      { path: "Obsidian/Café.md", kind: "file" },
    ]);
    expect(record.cwd).toBe(work);
    expect(record.argv).toEqual([...JSON.parse(await readFile(join(FAKE_CLAUDE_DIR, "../fixtures/argv.json"), "utf8")).cases[0].argv, "--max-budget-usd", "1"]);
    expect(record.stdin).toContain("Tidy the spelling.");
    // Nothing of Thoth's and nothing naming the vault; the user's own home (where the CLI keeps its login) is kept.
    expect(Object.entries(record.env).filter(([k, v]) => /^THOTH_/i.test(k) || v.includes(vaults.obsidian))).toEqual([]);
    expect(record.argv.some((a) => a.includes(vaults.obsidian))).toBe(false);
    expect(record.env["HOME"]).toBe(process.env["HOME"]);
    // Nothing is written before the review.
    expect(await readFile(join(vaults.obsidian, "Obsidian/Café.md"))).toEqual(agentRun.cafe);
    await expect(readFile(join(vaults.obsidian, "Obsidian/Summary.md"))).rejects.toThrow();
  });

  test("10. review the proposed changes: apply one, discard the other", async () => {
    const review = await openReview(page);
    await expect(review.getByRole("group", { name: "Changes to Obsidian/Café.md" })).toContainText("NFC-normalized filename");
    await review.getByRole("checkbox", { name: "Apply the change to Obsidian/Summary.md" }).uncheck();
    await review.getByRole("button", { name: "Apply 1 change" }).click();
    await expect(page.getByRole("region", { name: "Result" })).toContainText("Applied");
    // Exactly the approved bytes; the discarded file was never written; the working copy is gone.
    expect(await readFile(join(vaults.obsidian, "Obsidian/Café.md"), "utf8")).toBe(agentRun.cafe.toString("utf8").replace("normalised", "normalized"));
    await expect(readFile(join(vaults.obsidian, "Obsidian/Summary.md"))).rejects.toThrow();
    await expect.poll(async () => readdir(join(data, "agent-runs"))).toEqual([]);
    const [name] = await readdir(join(vaults.obsidian, ".thoth/agent/runs"));
    expect(JSON.parse(await readFile(join(vaults.obsidian, ".thoth/agent/runs", name!), "utf8"))).toMatchObject({ state: "applied", provider: { id: "claude" }, context: [{ path: "Obsidian/Café.md", via: "selected" }] });
    await closeApp();
  });

  test("11. a browser cannot read local files or launch a CLI without the explicit local bridge", async ({ browser }: { browser: Browser }) => {
    // The desktop app runs with its bridge: the only way to the host, and only for a page that holds its token.
    await openApp(vaults.mine);
    await expect(page.getByRole("tree", { name: "Pages in this Private Space" })).toBeVisible();
    await expect(mascot(page)).toBeVisible();
    const userFiles = async () => Object.fromEntries(Object.entries(await snapshotTree(vaults.mine)).filter(([path]) => !path.startsWith(".thoth")));
    const filesBefore = await userFiles();

    // The web client's production bundle has no filesystem, Tauri, process or agent code.
    const webDist = await buildWebClient({ VITE_DEFAULT_SERVER: ref.url, VITE_GA4_ID: "" });
    expect(desktopOnlyIn(webDist)).toEqual({});
    const site = await serveWebClient(webDist, sitePort);
    const outside = await browser.newContext();
    await outside.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
    try {
      // The web client: no Platform, no Tauri, no assistant; and the host's endpoints refuse it.
      const web = await outside.newPage();
      await web.goto(`http://127.0.0.1:${sitePort}/app/`);
      await expect(web.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
      expect(await web.evaluate(() => ({ platform: "__THOTH_PLATFORM__" in window, tauri: "__TAURI_INTERNALS__" in window || "__TAURI__" in window }))).toEqual({ platform: false, tauri: false });
      await expect(mascot(web)).toHaveCount(0);
      const fromWeb = await web.evaluate(async (url) => {
        try {
          const res = await fetch(`${url}/call`, { method: "POST", body: JSON.stringify({ command: "agent.run.create", args: { provider: "claude" } }) });
          return `answered ${res.status}`;
        } catch {
          return "refused";
        }
      }, bridge!.url);
      expect(fromWeb).toBe("refused");

      // The desktop UI itself, on the bridge's own origin, but without the bridge's script and token.
      const plain = await outside.newPage();
      await plain.goto(bridge!.url);
      await plain.getByRole("button", { name: /choose or create a private space/i }).click();
      await expect(plain.getByText(/No Thoth host is connected/)).toBeVisible();
      expect(await plain.evaluate(() => "__THOTH_PLATFORM__" in window)).toBe(false);
      await expect(mascot(plain)).toHaveCount(0);
      const statuses = await plain.evaluate(async () => {
        const call = (headers: Record<string, string>, command: string, args: unknown) => fetch("/call", { method: "POST", headers, body: JSON.stringify({ command, args }) }).then((r) => r.status);
        return [await call({}, "agent.run.create", { provider: "claude" }), await call({ "x-thoth-bridge": "guessed" }, "vault.pick", {}), await fetch("/events").then((r) => r.status), await fetch("/events?token=guessed").then((r) => r.status)];
      });
      expect(statuses).toEqual([403, 403, 403, 403]);
    } finally {
      await outside.close();
      await new Promise<void>((resolve) => site.close(() => resolve()));
    }
    // Nothing reached the host: no agent run was created, no file changed.
    expect(await readdir(join(data, "agent-runs")).catch(() => [])).toEqual([]);
    expect(await userFiles()).toEqual(filesBefore);
    await closeApp();
    // The whole scenario's pages never reached anything but their bridge.
    expect(offBridge).toEqual([]);
  });

  test("12. the server's permissions hold against direct calls that skip the client", async () => {
    // Finance has a page Grace may not see.
    const budgetId = newStableId();
    expect((await apiAs(ref.url, tokens.ada, "PUT", `/workspaces/${spaces.finance}/pages/${budgetId}`, { headers: { "if-none-match": "*" }, json: { title: "Budget", markdown: "# Budget\n\nSecret numbers.\n" } })).status).toBe(201);
    const studio = await studioPages();
    const welcome = studio["Welcome"]!;
    const budget = (await apiAs(ref.url, tokens.ada, "GET", `/workspaces/${spaces.finance}/pages/${budgetId}`)).json as { revision: { id: string } };
    const snapshot = async () => ({
      pages: (await ref.db.query("SELECT workspace_id, id::text, parent_id::text, title, current_revision_id, revision_count, deleted_at FROM pages ORDER BY workspace_id, id")).rows,
      revisions: (await ref.db.query("SELECT count(*)::int AS n FROM page_revisions")).rows,
      attachments: (await ref.db.query("SELECT count(*)::int AS n FROM attachments")).rows,
      changes: (await ref.db.query("SELECT count(*)::int AS n FROM changes")).rows,
    });
    const before = await snapshot();
    const grace = (method: string, path: string, init?: { headers?: Record<string, string>; json?: unknown }) => apiAs(ref.url, tokens.grace, method, path, init);
    const ifMatch = (revision: string) => ({ "if-match": `"${revision}"` });

    // Grace only sees Studio, where she is a viewer: she can read it, and nothing else.
    expect(((await grace("GET", "/workspaces")).json.items as { name: string; role: string }[]).map((w) => `${w.name}:${w.role}`)).toEqual(["Studio:viewer"]);
    expect((await grace("GET", `/workspaces/${spaces.studio}/pages/${welcome.id}`)).status).toBe(200);
    const refused = {
      write: (await grace("PUT", `/workspaces/${spaces.studio}/pages/${welcome.id}`, { headers: ifMatch(welcome.revision.id), json: { title: "Welcome", markdown: "# Taken over\n" } })).status,
      create: (await grace("PUT", `/workspaces/${spaces.studio}/pages/${newStableId()}`, { headers: { "if-none-match": "*" }, json: { title: "Mine", markdown: "# Mine\n" } })).status,
      move: (await grace("POST", `/workspaces/${spaces.studio}/pages/${welcome.id}/move`, { headers: ifMatch(welcome.revision.id), json: { parentId: null, position: null } })).status,
      delete: (await grace("DELETE", `/workspaces/${spaces.studio}/pages/${welcome.id}`, { headers: ifMatch(welcome.revision.id) })).status,
      // Finance, where she is not a member: not even its existence is confirmed.
      readOther: (await grace("GET", `/workspaces/${spaces.finance}/pages/${budgetId}`)).status,
      treeOther: (await grace("GET", `/workspaces/${spaces.finance}/tree`)).status,
      writeOther: (await grace("PUT", `/workspaces/${spaces.finance}/pages/${budgetId}`, { headers: ifMatch(budget.revision.id), json: { title: "Budget", markdown: "# Budget\n\nChanged.\n" } })).status,
      moveOther: (await grace("POST", `/workspaces/${spaces.finance}/pages/${budgetId}/move`, { headers: ifMatch(budget.revision.id), json: { parentId: null, position: null } })).status,
      deleteOther: (await grace("DELETE", `/workspaces/${spaces.finance}/pages/${budgetId}`, { headers: ifMatch(budget.revision.id) })).status,
    };
    expect(refused).toEqual({ write: 403, create: 403, move: 403, delete: 403, readOther: 404, treeOther: 404, writeOther: 404, moveOther: 404, deleteOther: 404 });
    // No credential, or a made-up one, gets nothing at all.
    expect((await apiAs(ref.url, "", "GET", `/workspaces/${spaces.studio}/tree`)).status).toBe(401);
    expect((await apiAs(ref.url, generateToken(), "GET", `/workspaces/${spaces.studio}/tree`)).status).toBe(401);
    // And nothing changed in the database.
    expect(await snapshot()).toEqual(before);
  });
});

/** Studio's pages on the server, by title, read with Ada's token (not through the app). */
async function studioPages(): Promise<Record<string, { id: string; markdown: string; revision: { id: string; contentHash: string } }>> {
  const tree = await apiAs(ref.url, tokens.ada, "GET", `/workspaces/${spaces.studio}/tree`);
  expect(tree.status, JSON.stringify(tree.json)).toBe(200);
  const out: Record<string, { id: string; markdown: string; revision: { id: string; contentHash: string } }> = {};
  for (const node of tree.json.items as { id: string; title: string }[]) {
    const got = await apiAs(ref.url, tokens.ada, "GET", `/workspaces/${spaces.studio}/pages/${node.id}`);
    expect(got.status).toBe(200);
    out[node.title] = { id: node.id, markdown: got.json.markdown, revision: got.json.revision };
  }
  return out;
}
