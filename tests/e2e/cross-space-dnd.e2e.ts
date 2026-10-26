/**
 * Drag and drop between the Private Space and a workspace (ADR-0006, amendment of 2026-10-26), with a real pointer
 * (`drag.ts`) in the real desktop UI on the real Rust host, against the reference server on PostgreSQL.
 *
 * A drop across spaces opens the transfer dialog prefilled; only the dialog's confirmation transfers. A page dragged
 * onto a workspace arrives with its exact text and stays (copy) or leaves (move, Alt/Option); a folder travels as a
 * folder page with its pages, inside the page it was dropped on; a workspace page dropped on the Private Space lands
 * at its top level or in the folder under the pointer. A viewer workspace and an export-restricted source refuse with
 * no indicator and say why. A drag within a tree still only reorders. Screenshots, light and dark, go to
 * tests/.tmp/cross-space-dnd/.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

const SHOTS = join(REPO, "tests", ".tmp", "cross-space-dnd");

let built: { dist: string; bridgeDir: string; binary: string };
let ref: ReferenceServer;
let scratch: string;
let vault: string;
let bridge: Bridge;

const DIARY = "# Diary\n\nWritten here, ไทย too.\n";

interface Seeded {
  token: string;
  studio: string;
  gallery: string;
  locked: string;
}

/** Ada: owner of Studio and of the export-restricted Locked, viewer of Gallery. */
async function seedServer(): Promise<Seeded> {
  const ada = opaqueId("usr");
  const token = generateToken();
  const [studio, gallery, locked] = [opaqueId("ws"), opaqueId("ws"), opaqueId("ws")];
  await ref.db.query("INSERT INTO users (id, display_name) VALUES ($1, 'Ada')", [ada]);
  await ref.db.query("INSERT INTO access_tokens (id, user_id, token_hash) VALUES ($1, $2, $3)", [opaqueId("tok"), ada, hashToken(token)]);
  await ref.db.query("INSERT INTO workspaces (id, name, export_restricted) VALUES ($1, 'Studio', false), ($2, 'Gallery', false), ($3, 'Locked', true)", [studio, gallery, locked]);
  await ref.db.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $4, 'owner'), ($2, $4, 'viewer'), ($3, $4, 'owner')", [studio, gallery, locked, ada]);
  return { token, studio, gallery, locked };
}

const api = (token: string, method: string, path: string) => apiAs(ref.url, token, method, path);

async function createPage(token: string, workspace: string, title: string, markdown: string): Promise<string> {
  const id = newStableId();
  const res = await apiAs(ref.url, token, "PUT", `/workspaces/${workspace}/pages/${id}`, { headers: { "if-none-match": "*" }, json: { title, markdown } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return id;
}

type Item = { id: string; title: string; parentId: string | null };
const serverTree = async (token: string, workspace: string): Promise<Item[]> => (await api(token, "GET", `/workspaces/${workspace}/tree`)).json.items as Item[];
const markdownOf = async (token: string, workspace: string, id: string): Promise<string> => (await api(token, "GET", `/workspaces/${workspace}/pages/${id}`)).json.markdown as string;

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

const localTree = (page: Page) => page.getByRole("tree", { name: "Pages in this Private Space" });
const workspaces = (page: Page) => page.getByRole("tree", { name: /^Workspaces on / });
const workspaceRow = (page: Page, name: string) => workspaces(page).getByRole("treeitem", { name: new RegExp(`^${name}`) });
const pagesIn = (page: Page, name: string) => page.getByRole("group", { name: `Pages in ${name}` });
const badge = (page: Page) => page.locator(".space-drag-badge");
/** The Private Space header, a drop target (it heads a reorderable sidebar section, ADR-0019 amendment). */
const header = (page: Page) => page.locator('.side-section[data-section="private"] > .sec-drop');

async function shot(page: Page, name: string) {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test.describe("drag and drop between the Private Space and a workspace", () => {
  test.beforeAll(async () => {
    built = await buildAll();
    ref = await startReferenceServer();
  });

  test.afterAll(async () => {
    await ref?.close();
  });

  test.beforeEach(async ({ page, context }) => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "thoth-e2e-xdnd-")));
    vault = join(scratch, "Vault");
    await mkdir(join(vault, "Projects"), { recursive: true });
    await writeFile(join(vault, "Projects", "Plan.md"), "# Plan\n\nSee [[Notes]].\n");
    await writeFile(join(vault, "Projects", "Notes.md"), "# Notes\n\nBack to [[Plan]].\n");
    await writeFile(join(vault, "Diary.md"), DIARY);
    bridge = await startBridge({ dist: built.dist, bridgeDir: built.bridgeDir, host: { binary: built.binary, pickVault: vault, dataDir: join(scratch, "data") } });
    await context.route((url) => !url.href.startsWith(bridge.url), (route) => route.abort());
    await page.setViewportSize({ width: 1180, height: 760 });
    await page.addInitScript(bridge.initScript);
    await page.goto(bridge.url);
    await page.getByRole("button", { name: /choose or create a private space/i }).click();
    await expect(localTree(page)).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    await page.close();
    await bridge.close();
    await rm(scratch, { recursive: true, force: true });
  });

  test("a page dragged onto a workspace: dialog with preview, then the exact text on the server; Alt/Option moves", async ({ page }) => {
    const s = await seedServer();
    await signInWithToken(page, s.token);
    await expect(workspaceRow(page, "Studio")).toBeVisible();

    // Copy: the workspace row lights, the pointer says what a drop would do, and the drop only opens the dialog.
    const copy = await startDrag(page, localTree(page).getByRole("treeitem", { name: "Diary", exact: true }));
    await copy.over(workspaceRow(page, "Studio"), 0.5);
    await expectIndicator(page, ["Studio: inside"]);
    await expect(badge(page)).toHaveText("Copy to Studio…");
    await shot(page, "drag-to-workspace-light");
    await copy.drop();
    const dialog = page.getByRole("dialog", { name: "Copy 1 page to a workspace" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Workspace" })).toHaveValue(new RegExp(s.studio));
    await expect(dialog.getByRole("radio", { name: /^Copy/ })).toBeChecked();
    await expect(dialog.getByRole("region", { name: "Who can see it" })).toContainText("Nothing has left this computer yet.");
    await shot(page, "dialog-to-workspace-light");
    expect(await serverTree(s.token, s.studio)).toEqual([]);
    await dialog.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("1 page was copied to Studio.", { timeout: 20_000 });
    await dialog.locator(".modal-actions").getByRole("button", { name: "Close" }).click();
    const diary = (await serverTree(s.token, s.studio)).find((n) => n.title === "Diary")!;
    // Byte for byte the page, with its identity at the destination (`thoth_id`, ADR-0003; a copy has its own).
    expect(await markdownOf(s.token, s.studio, diary.id)).toBe(`---\nthoth_id: ${diary.id}\n---\n${DIARY}`);
    expect(await readFile(join(vault, "Diary.md"), "utf8")).toContain("Written here, ไทย too.");

    // Move: Alt/Option held at the drop chooses Move in the dialog.
    const notes = localTree(page).getByRole("treeitem", { name: "Notes", exact: true });
    if (!(await notes.isVisible())) await localTree(page).getByRole("treeitem", { name: "Projects" }).click();
    const move = await startDrag(page, notes);
    await page.keyboard.down("Alt");
    await move.over(workspaceRow(page, "Studio"), 0.5);
    await expect(badge(page)).toHaveText("Move to Studio…");
    await move.drop();
    await page.keyboard.up("Alt");
    const moving = page.getByRole("dialog", { name: "Move 1 page to a workspace" });
    await expect(moving.getByRole("radio", { name: /^Move/ })).toBeChecked();
    await moving.getByRole("button", { name: "Move", exact: true }).click();
    await expect(moving.getByRole("status")).toContainText("1 page was moved to Studio.", { timeout: 20_000 });
    await moving.locator(".modal-actions").getByRole("button", { name: "Close" }).click();
    expect(await readdir(join(vault, "Projects"))).toEqual(["Plan.md"]);
    const remote = (await serverTree(s.token, s.studio)).find((n) => n.title === "Notes")!;
    expect(await markdownOf(s.token, s.studio, remote.id)).toContain("Back to [[Plan]].");
  });

  test("a folder dropped on a workspace page travels inside it; a workspace page dropped on the Private Space lands there", async ({ page }) => {
    const s = await seedServer();
    const board = await createPage(s.token, s.studio, "Board", "# Board\n");
    const roadmap = await createPage(s.token, s.studio, "Roadmap", "# Roadmap\n\nFrom the team, ไทย.\n");
    await page.emulateMedia({ colorScheme: "dark" });
    await signInWithToken(page, s.token);
    await workspaceRow(page, "Studio").click();
    await expect(pagesIn(page, "Studio").getByRole("treeitem", { name: "Board" })).toBeVisible();

    // The folder Projects onto the page Board: the parent is chosen in the dialog.
    const folder = await startDrag(page, localTree(page).getByRole("treeitem", { name: "Projects" }));
    await folder.over(pagesIn(page, "Studio").getByRole("treeitem", { name: "Board" }), 0.5);
    await expectIndicator(page, ["Board: inside"]);
    await shot(page, "drag-to-workspace-dark");
    await folder.drop();
    const dialog = page.getByRole("dialog", { name: "Copy 2 pages to a workspace" });
    await expect(dialog.getByRole("combobox", { name: "Put the pages" })).toHaveValue(board);
    await expect(dialog.getByRole("region", { name: "Who can see it" })).toContainText("Nothing has left this computer yet.");
    await shot(page, "dialog-to-workspace-dark");
    await dialog.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("copied to Studio", { timeout: 20_000 });
    await dialog.locator(".modal-actions").getByRole("button", { name: "Close" }).click();
    const items = await serverTree(s.token, s.studio);
    const projects = items.find((n) => n.title === "Projects")!;
    expect(projects.parentId).toBe(board);
    expect(items.filter((n) => n.parentId === projects.id).map((n) => n.title).sort()).toEqual(["Notes", "Plan"]);

    // Roadmap onto the Private Space header: its top level.
    const out = await startDrag(page, pagesIn(page, "Studio").getByRole("treeitem", { name: "Roadmap" }));
    await out.over(header(page), 0.5);
    await expect(header(page)).toHaveAttribute("data-drop", "inside");
    await expect(badge(page)).toHaveText("Copy to Private Space…");
    await shot(page, "drag-to-private-dark");
    await out.drop();
    const back = page.getByRole("dialog", { name: "Copy “Roadmap” to your Private Space" });
    await expect(back.getByRole("textbox", { name: /Folder in your Private Space/ })).toHaveValue("");
    await expect(back.getByRole("region", { name: "Who can see it" })).toContainText("Nothing has been written to your Private Space yet.");
    await shot(page, "dialog-to-private-dark");
    await back.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(back.getByRole("status")).toContainText("copied to your Private Space", { timeout: 20_000 });
    await back.locator(".modal-actions").getByRole("button", { name: "Close" }).click();
    expect(await readFile(join(vault, "Roadmap.md"), "utf8")).toContain("From the team, ไทย.");
    expect((await serverTree(s.token, s.studio)).some((n) => n.id === roadmap)).toBe(true);

    // Roadmap again, onto the folder Projects in light: the folder is the destination.
    await page.emulateMedia({ colorScheme: "light" });
    const into = await startDrag(page, pagesIn(page, "Studio").getByRole("treeitem", { name: "Roadmap" }));
    await into.over(localTree(page).getByRole("treeitem", { name: "Projects" }), 0.5);
    await expectIndicator(page, ["Projects: inside"]);
    await shot(page, "drag-to-private-light");
    await into.drop();
    const again = page.getByRole("dialog", { name: "Copy “Roadmap” to your Private Space" });
    await expect(again.getByRole("textbox", { name: /Folder in your Private Space/ })).toHaveValue("Projects");
    await shot(page, "dialog-to-private-light");
    await again.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(again.getByRole("status")).toContainText("copied to your Private Space", { timeout: 20_000 });
    expect(await readFile(join(vault, "Projects", "Roadmap.md"), "utf8")).toContain("From the team, ไทย.");
  });

  test("refused drops show no indicator and say why; a drag within a tree still only reorders", async ({ page }) => {
    const s = await seedServer();
    await createPage(s.token, s.locked, "Secret", "# Secret\n");
    await signInWithToken(page, s.token);
    await expect(workspaceRow(page, "Gallery")).toBeVisible();

    // A viewer workspace takes no pages.
    const viewer = await startDrag(page, localTree(page).getByRole("treeitem", { name: "Diary", exact: true }));
    await viewer.over(workspaceRow(page, "Gallery"), 0.5);
    await expect(badge(page)).toHaveText("You are a viewer in Gallery.");
    await expectIndicator(page, []);
    await shot(page, "refused-viewer-light");
    await viewer.drop();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // An export-restricted workspace gives none.
    await workspaceRow(page, "Locked").click();
    const restricted = await startDrag(page, pagesIn(page, "Locked").getByRole("treeitem", { name: "Secret" }));
    await restricted.over(header(page), 0.5);
    await expect(badge(page)).toHaveText("Locked does not allow copying or moving its pages out.");
    await expectIndicator(page, []);
    await restricted.drop();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await readdir(vault)).not.toContain("Secret.md");

    // Within the Private Space: a file move, no dialog, no badge.
    const inTree = await startDrag(page, localTree(page).getByRole("treeitem", { name: "Diary", exact: true }));
    await inTree.over(localTree(page).getByRole("treeitem", { name: "Projects" }), 0.5);
    await expectIndicator(page, ["Projects: inside"]);
    await expect(badge(page)).toHaveCount(0);
    await inTree.drop();
    await expect.poll(async () => (await readdir(join(vault, "Projects"))).sort()).toEqual(["Diary.md", "Notes.md", "Plan.md"]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
