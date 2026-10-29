/**
 * Copy and move between two workspaces (ADR-0006, amendment of 2026-10-27) in the real desktop UI on the real Rust
 * host, against the reference server on PostgreSQL: copy by a page's menu, move by dragging onto the other workspace
 * (a plain drop; Alt/Option would copy), and a refused drop that says why. The pages arrive with the destination's own IDs and the links
 * between them rewritten; a move deletes the originals only after the destination has them. Screenshots, light and
 * dark, go to tests/.tmp/workspace-transfer/.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, type Bridge } from "./bridge.ts";
import { buildAll } from "./setup.ts";
import { apiAs, startReferenceServer, type ReferenceServer } from "./reference-server.ts";
import { expectIndicator, startDrag } from "./drag.ts";
import { generateToken, hashToken } from "../../apps/server/src/auth.ts";
import { opaqueId } from "../../apps/server/src/ids.ts";
import { REPO } from "../ports/harness.ts";
import { newStableId } from "@thoth/domain";

const SHOTS = join(REPO, "tests", ".tmp", "workspace-transfer");

let built: { dist: string; bridgeDir: string; binary: string };
let ref: ReferenceServer;
let scratch: string;
let bridge: Bridge;

interface Seeded {
  token: string;
  studio: string;
  archive: string;
  locked: string;
  roadmap: string;
  milestones: string;
}

type Item = { id: string; title: string; parentId: string | null };
const api = (token: string, method: string, path: string) => apiAs(ref.url, token, method, path);
const serverTree = async (token: string, workspace: string): Promise<Item[]> => (await api(token, "GET", `/workspaces/${workspace}/tree`)).json.items as Item[];
const markdownOf = async (token: string, workspace: string, id: string): Promise<string> => (await api(token, "GET", `/workspaces/${workspace}/pages/${id}`)).json.markdown as string;

async function createPage(token: string, workspace: string, title: string, markdown: string, parentId: string | null = null): Promise<string> {
  const id = newStableId();
  const res = await apiAs(ref.url, token, "PUT", `/workspaces/${workspace}/pages/${id}`, { headers: { "if-none-match": "*" }, json: { title, markdown, parentId } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return id;
}

/** Ada owns Studio (Roadmap, and Milestones inside it), Archive, and the export-restricted Locked (Secret). */
async function seedServer(): Promise<Seeded> {
  const ada = opaqueId("usr");
  const token = generateToken();
  const [studio, archive, locked] = [opaqueId("ws"), opaqueId("ws"), opaqueId("ws")];
  await ref.db.query("INSERT INTO users (id, display_name) VALUES ($1, 'Ada')", [ada]);
  await ref.db.query("INSERT INTO access_tokens (id, user_id, token_hash) VALUES ($1, $2, $3)", [opaqueId("tok"), ada, hashToken(token)]);
  await ref.db.query("INSERT INTO workspaces (id, name, export_restricted) VALUES ($1, 'Studio', false), ($2, 'Archive', false), ($3, 'Locked', true)", [studio, archive, locked]);
  await ref.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $4, 'owner'), ($2, $4, 'owner'), ($3, $4, 'owner')", [studio, archive, locked, ada]);
  const roadmap = await createPage(token, studio, "Roadmap", "# Roadmap\n\nFrom the team, ไทย.\n");
  const milestones = await createPage(token, studio, "Milestones", `# Milestones\n\nUp to [[thoth:page/${roadmap}|Roadmap]].\n`, roadmap);
  await createPage(token, locked, "Secret", "# Secret\n");
  return { token, studio, archive, locked, roadmap, milestones };
}

async function signInWithToken(page: Page, token: string) {
  await page.getByRole("button", { name: "Settings" }).click();
  const servers = page.getByRole("region", { name: "Servers" });
  await servers.getByRole("textbox", { name: "Server address" }).fill(ref.url);
  await servers.getByRole("button", { name: "Add server" }).click();
  const card = servers.getByRole("article");
  await card.getByRole("button", { name: "Use a personal access token" }).click();
  await card.getByLabel(/Personal access token/).fill(token);
  await card.getByRole("button", { name: "Sign in with token" }).click();
  await expect(card.getByTestId("server-account")).toHaveText(/Signed in as Ada/, { timeout: 15_000 });
}

const workspaces = (page: Page) => page.getByRole("tree", { name: /^Workspaces on / });
const workspaceRow = (page: Page, name: string) => workspaces(page).getByRole("treeitem", { name: new RegExp(`^${name}`) });
const pagesIn = (page: Page, name: string) => page.getByRole("group", { name: `Pages in ${name}` });
const badge = (page: Page) => page.locator(".space-drag-badge");

async function shot(page: Page, name: string) {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test.describe("copy and move between two workspaces", () => {
  test.beforeAll(async () => {
    built = await buildAll();
    ref = await startReferenceServer();
  });

  test.afterAll(async () => {
    await ref?.close();
  });

  test.beforeEach(async ({ page, context }) => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-wsx-")));
    const vault = join(scratch, "Vault");
    await mkdir(vault, { recursive: true });
    await writeFile(join(vault, "Diary.md"), "# Diary\n");
    bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, dataDir: join(scratch, "data") } });
    await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
    await page.setViewportSize({ width: 1180, height: 760 });
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

  test("copy by a page's menu: the page and its sub-page arrive with their own IDs and links between them rewritten", async ({ page }) => {
    const s = await seedServer();
    await signInWithToken(page, s.token);
    await workspaceRow(page, "Studio").click();
    await pagesIn(page, "Studio").getByRole("treeitem", { name: "Roadmap" }).click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Actions for Roadmap" });
    await shot(page, "menu-light");
    await menu.getByRole("menuitem", { name: "Copy to another workspace…" }).click();
    const dialog = page.getByRole("dialog", { name: "Copy “Roadmap” to another workspace" });
    await dialog.getByRole("combobox", { name: "Workspace" }).selectOption({ label: "Archive" });
    const preview = dialog.getByRole("region", { name: "Who can see it" });
    await expect(preview).toContainText("Milestones");
    await expect(preview).toContainText("From Studio");
    await expect(preview).toContainText("Nothing has been written to Archive yet.");
    await shot(page, "dialog-copy-light");
    expect(await serverTree(s.token, s.archive)).toEqual([]);
    await dialog.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("2 pages were copied to Archive. Every page was checked at the destination.", { timeout: 20_000 });
    await shot(page, "result-copy-light");
    await dialog.locator(".modal-actions").getByRole("button", { name: "Close" }).click();

    const items = await serverTree(s.token, s.archive);
    const roadmap = items.find((n) => n.title === "Roadmap")!;
    const milestones = items.find((n) => n.title === "Milestones")!;
    expect([roadmap.id, milestones.id]).not.toContain(s.roadmap);
    expect(milestones.parentId).toBe(roadmap.id);
    expect(await markdownOf(s.token, s.archive, milestones.id)).toContain(`[[thoth:page/${roadmap.id}|Roadmap]]`);
    // The originals are untouched.
    expect((await serverTree(s.token, s.studio)).map((n) => n.title).sort()).toEqual(["Milestones", "Roadmap"]);
  });

  test("move by dragging onto the other workspace: the originals leave only after the copy is there", async ({ page }) => {
    const s = await seedServer();
    await page.emulateMedia({ colorScheme: "dark" });
    await signInWithToken(page, s.token);
    await workspaceRow(page, "Studio").click();
    const drag = await startDrag(page, pagesIn(page, "Studio").getByRole("treeitem", { name: "Roadmap" }));
    await drag.over(workspaceRow(page, "Archive"), 0.5);
    await expectIndicator(page, ["Archive: inside"]);
    await expect(badge(page)).toHaveText("Move to Archive…");
    await shot(page, "drag-move-dark");
    await drag.drop();
    const dialog = page.getByRole("dialog", { name: "Move “Roadmap” to another workspace" });
    await expect(dialog.getByRole("radio", { name: /^Move/ })).toBeChecked();
    await expect(dialog.getByRole("region", { name: "Who can see it" })).toContainText("Nothing has been written to Archive yet.");
    await shot(page, "dialog-move-dark");
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("2 pages were moved to Archive.", { timeout: 20_000 });
    await shot(page, "result-move-dark");
    await dialog.locator(".modal-actions").getByRole("button", { name: "Close" }).click();
    expect(await serverTree(s.token, s.studio)).toEqual([]);
    expect((await serverTree(s.token, s.archive)).map((n) => n.title).sort()).toEqual(["Milestones", "Roadmap"]);
    await expect(pagesIn(page, "Studio").getByRole("treeitem", { name: "Roadmap" })).toHaveCount(0, { timeout: 15_000 });
  });

  test("a refused drop says why and opens nothing: an export-restricted source", async ({ page }) => {
    const s = await seedServer();
    await signInWithToken(page, s.token);
    await workspaceRow(page, "Locked").click();
    const drag = await startDrag(page, pagesIn(page, "Locked").getByRole("treeitem", { name: "Secret" }));
    await drag.over(workspaceRow(page, "Archive"), 0.5);
    await expect(badge(page)).toHaveText("Locked does not allow copying or moving its pages out.");
    await expectIndicator(page, []);
    await shot(page, "refused-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "refused-dark");
    await drag.drop();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await serverTree(s.token, s.archive)).toEqual([]);
  });
});
