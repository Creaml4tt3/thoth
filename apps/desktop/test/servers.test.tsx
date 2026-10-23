// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppOptions } from "../src/app/context.ts";
import { describeLimits } from "../src/features/servers/ServersSettings.tsx";
import { titleFromMarkdown } from "../src/features/servers/workspace-store.ts";
import { nestWorkspaceTree } from "../src/features/servers/tree.ts";
import { caretAtEnd, cleanup, editorBox, openApp, paragraph, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { FakeServers, type FakeServerConfig, type FakeWorkspace } from "./support/fake-servers.ts";
import { ALPHA, seed } from "./support/fixtures.ts";

const dirs = tempDirs();
let root: string;

const LOCAL: FakeServerConfig = { url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada", email: "ada@example.com" } };
const TRIAL: FakeServerConfig = {
  url: "https://trial.example.com",
  name: "Thoth trial",
  providers: [
    { id: "google", name: "Google" },
    { id: "github", name: "GitHub" },
  ],
  limits: { maxPagesPerWorkspace: 200, maxMembersPerWorkspace: 5, maxWorkspaceAttachmentBytes: 50 * 1024 * 1024, idempotencyWindowSeconds: 86400 },
  account: { id: "usr_me", displayName: "Ada" },
};

const PLAN = "# Plan\n\nFirst line here.\n";

beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA });
});
afterEach(async () => {
  cleanup();
  setVisibility("visible");
  await dirs.cleanup();
});

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function start(setup: (servers: FakeServers) => void = () => undefined, options: Partial<AppOptions> = {}) {
  const servers = new FakeServers();
  setup(servers);
  const app = await openApp(root, options, createNodePlatform({ vault: root, servers }));
  await screen.findByRole("tree", { name: "Pages in this Private Space" });
  return { app, servers };
}

async function openServersSettings(app: Harness) {
  await app.user.click(screen.getByRole("button", { name: "Settings" }));
  return screen.findByRole("region", { name: "Servers" });
}

const card = (name: string) => screen.getByRole("article", { name });

/** A signed-in server with one workspace holding "Plan". */
async function withWorkspace(options: Partial<AppOptions> = {}, role: "owner" | "editor" | "viewer" = "editor", config: FakeServerConfig = LOCAL) {
  let ws!: FakeWorkspace;
  let server!: string;
  const ctx = await start((servers) => {
    server = servers.connect(config);
    ws = servers.addWorkspace(server, { name: "Design", role });
    servers.writeAsOther(ws, { title: "Plan", markdown: PLAN });
  }, options);
  return { ...ctx, ws, server };
}

async function expandWorkspace(app: Harness, name = "Design") {
  const list = await screen.findByRole("tree", { name: /^Workspaces on / });
  await app.user.click(within(list).getByRole("treeitem", { name: new RegExp(`^${name}`) }));
  return within(list).findByRole("group", { name: `Pages in ${name}` });
}

async function openPlan(app: Harness) {
  const pages = await expandWorkspace(app);
  await app.user.click(await within(pages).findByRole("treeitem", { name: "Plan" }));
  const box = await editorBox();
  await waitFor(() => expect(box.textContent).toContain("First line here."));
  return box;
}

async function type(app: Harness, box: HTMLElement, text: string) {
  box.focus();
  caretAtEnd(paragraph(box, "First line here."));
  await app.user.keyboard(text);
}

describe("Settings → Servers: add", () => {
  it("explains an unreachable address, a non-Thoth server, and a refused address", async () => {
    const { app } = await start((s) => s.define({ url: "https://not-thoth.example.com", notThoth: true }));
    const region = await openServersSettings(app);
    const field = within(region).getByRole("textbox", { name: "Server address" });
    const add = within(region).getByRole("button", { name: "Add server" });

    await app.user.click(add);
    expect((await within(region).findByRole("alert")).textContent).toMatch(/enter the server's address/i);

    await app.user.type(field, "https://nowhere.example.com");
    await app.user.click(add);
    await waitFor(() => expect(within(region).getByRole("alert").textContent).toMatch(/could not reach a thoth server.*nothing answered/i));

    await app.user.clear(field);
    await app.user.type(field, "https://not-thoth.example.com");
    await app.user.click(add);
    await waitFor(() => expect(within(region).getByRole("alert").textContent).toMatch(/not a Thoth server/));

    await app.user.clear(field);
    await app.user.type(field, "http://intranet.example.com");
    await app.user.click(add);
    await waitFor(() => expect(within(region).getByRole("alert").textContent).toMatch(/cannot be used.*https/i));
    expect(within(region).queryAllByRole("article")).toHaveLength(0);
  });

  it("adds a server and shows its name, address, account line and limits in plain words", async () => {
    const { app } = await start((s) => s.define(TRIAL));
    const region = await openServersSettings(app);
    await app.user.type(within(region).getByRole("textbox", { name: "Server address" }), "https://trial.example.com");
    await app.user.click(within(region).getByRole("button", { name: "Add server" }));
    const trial = await within(region).findByRole("article", { name: "Thoth trial" });
    expect(within(trial).getByText("https://trial.example.com")).toBeTruthy();
    expect(within(trial).getByTestId("server-account").textContent).toBe("Not signed in.");
    const limits = within(trial).getAllByRole("listitem").map((li) => li.textContent);
    expect(limits).toEqual(["200 pages per workspace", "5 members per workspace", "50 MB of attachments per workspace"]);
    expect(within(trial).getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
    expect(within(trial).getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
    expect((within(region).getByRole("textbox", { name: "Server address" }) as HTMLInputElement).value).toBe("");
  });
});

describe("Settings → Servers: the starter server", () => {
  const STARTER = { url: "https://trial.example.com", name: "Thoth demo server", caution: "A free demo for trying Thoth, with limits." };

  it("is suggested with its caution, contacted only when added, then shown as a normal server with the caution", async () => {
    const { app, servers } = await start((s) => s.define(TRIAL), { starterServer: STARTER });
    const region = await openServersSettings(app);
    const suggestion = within(region).getByRole("group", { name: "Thoth demo server" });
    expect(within(suggestion).getByText("https://trial.example.com")).toBeTruthy();
    expect(within(suggestion).getByText(STARTER.caution)).toBeTruthy();
    // A suggestion only: the server is not known to the host until the user adds it.
    expect(await servers.list()).toEqual([]);

    await app.user.click(within(suggestion).getByRole("button", { name: "Add Thoth demo server" }));
    const trial = await within(region).findByRole("article", { name: "Thoth trial" });
    expect(within(trial).getByText(STARTER.caution)).toBeTruthy();
    expect(within(trial).getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
    expect(within(region).queryByRole("group", { name: "Thoth demo server" })).toBeNull();
  });

  it("is not suggested once added, and other servers carry no caution", async () => {
    const { app } = await start((s) => {
      s.connect(TRIAL, { signedIn: false });
      s.connect(LOCAL);
    }, { starterServer: STARTER });
    const region = await openServersSettings(app);
    expect(within(region).queryByRole("group", { name: "Thoth demo server" })).toBeNull();
    expect(within(card("Thoth trial")).getByText(STARTER.caution)).toBeTruthy();
    expect(within(card("Team server")).queryByText(STARTER.caution)).toBeNull();
  });

  it("explains a failure to reach it", async () => {
    const { app } = await start(() => undefined, { starterServer: STARTER });
    const region = await openServersSettings(app);
    await app.user.click(within(region).getByRole("button", { name: "Add Thoth demo server" }));
    await waitFor(() => expect(within(region).getByRole("alert").textContent).toMatch(/could not reach a thoth server/i));
    expect(within(region).queryAllByRole("article")).toHaveLength(0);
  });

  it("is not suggested when the app has none", async () => {
    const { app } = await start();
    const region = await openServersSettings(app);
    expect(within(region).queryByRole("group")).toBeNull();
  });
});

describe("Settings → Servers: sign in", () => {
  it("waits for the browser with a Cancel button, then shows the account", async () => {
    let id = "";
    const { app, servers } = await start((s) => {
      id = s.connect(TRIAL, { signedIn: false });
      s.signInMode = "manual";
    });
    await openServersSettings(app);
    await app.user.click(within(card("Thoth trial")).getByRole("button", { name: "Sign in with GitHub" }));
    const waiting = await within(card("Thoth trial")).findByRole("status");
    expect(waiting.textContent).toMatch(/finish signing in with GitHub in your browser/i);
    expect(within(card("Thoth trial")).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(within(card("Thoth trial")).queryByRole("button", { name: /sign in with/i })).toBeNull();

    servers.finishSignIn(id);
    await waitFor(() => expect(within(card("Thoth trial")).getByTestId("server-account").textContent).toBe("Signed in as Ada."));
    expect(within(card("Thoth trial")).getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("Cancel stops waiting without reporting an error", async () => {
    let id = "";
    const { app, servers } = await start((s) => {
      id = s.connect(TRIAL, { signedIn: false });
      s.signInMode = "manual";
    });
    await openServersSettings(app);
    await app.user.click(within(card("Thoth trial")).getByRole("button", { name: "Sign in with Google" }));
    await app.user.click(await within(card("Thoth trial")).findByRole("button", { name: "Cancel" }));
    await within(card("Thoth trial")).findByRole("button", { name: "Sign in with Google" });
    expect(servers.waiting(id)).toBe(false);
    expect(within(card("Thoth trial")).queryByRole("alert")).toBeNull();
    expect(within(card("Thoth trial")).getByTestId("server-account").textContent).toBe("Not signed in.");
  });

  it("shows why a browser sign-in failed", async () => {
    let id = "";
    const { app, servers } = await start((s) => {
      id = s.connect(TRIAL, { signedIn: false });
      s.signInMode = "manual";
    });
    await openServersSettings(app);
    await app.user.click(within(card("Thoth trial")).getByRole("button", { name: "Sign in with Google" }));
    await within(card("Thoth trial")).findByRole("button", { name: "Cancel" });
    servers.failSignIn(id, "The sign-in timed out after 5 minutes.");
    expect((await within(card("Thoth trial")).findByRole("alert")).textContent).toBe("The sign-in timed out after 5 minutes.");
    expect(within(card("Thoth trial")).getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
  });

  it("signs in with a personal access token sent once, from a password field that is cleared", async () => {
    const { app, servers } = await start((s) => s.connect(LOCAL, { signedIn: false }));
    await openServersSettings(app);
    const team = card("Team server");
    expect(within(team).queryByRole("button", { name: /sign in with (google|github)/i })).toBeNull();
    await app.user.click(within(team).getByRole("button", { name: "Use a personal access token" }));
    const field = within(team).getByLabelText(/personal access token/i) as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("off");

    await app.user.type(field, "thoth_pat_wrong");
    await app.user.click(within(team).getByRole("button", { name: "Sign in with token" }));
    expect((await within(team).findByRole("alert")).textContent).toMatch(/did not accept that token/);
    expect(field.value).toBe("");

    await app.user.type(field, "thoth_pat_good{Enter}");
    await waitFor(() => expect(within(team).getByTestId("server-account").textContent).toBe("Signed in as Ada (ada@example.com) with a personal access token."));
    expect(servers.tokensReceived).toEqual(["thoth_pat_wrong", "thoth_pat_good"]);
    expect(within(team).queryByLabelText(/personal access token/i)).toBeNull();
    // The token is nowhere in the page or in the webview's storage.
    expect(document.body.innerHTML).not.toContain("thoth_pat_good");
    expect(JSON.stringify({ ...localStorage })).not.toContain("thoth_pat_good");
  });
});

describe("Settings → Servers: sign out and remove", () => {
  it("signs out, then removes the server only after confirmation", async () => {
    const { app, servers, server } = await withWorkspace();
    await screen.findByRole("tree", { name: "Workspaces on Team server" });
    await openServersSettings(app);
    await app.user.click(within(card("Team server")).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(within(card("Team server")).getByTestId("server-account").textContent).toBe("Not signed in."));
    expect(servers.info(server)?.auth).toBe("signed-out");
    expect(screen.queryByRole("tree", { name: "Workspaces on Team server" })).toBeNull();

    await app.user.click(within(card("Team server")).getByRole("button", { name: "Remove" }));
    const confirm = screen.getByRole("dialog", { name: "Remove Team server?" });
    await app.user.click(within(confirm).getByRole("button", { name: "Keep it" }));
    expect(screen.getByRole("article", { name: "Team server" })).toBeTruthy();

    await app.user.click(within(card("Team server")).getByRole("button", { name: "Remove" }));
    await app.user.click(within(screen.getByRole("dialog", { name: "Remove Team server?" })).getByRole("button", { name: "Remove server" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Team server" })).toBeNull());
    expect(servers.info(server)).toBeUndefined();
    expect(screen.queryByRole("region", { name: "Server Team server" })).toBeNull();
  });
});

describe("sidebar", () => {
  it("lists a signed-in server's workspaces under the Private Space, with the Workspace badge", async () => {
    await start((s) => {
      const id = s.connect(LOCAL);
      s.addWorkspace(id, { name: "Design" });
      s.addWorkspace(id, { name: "Research", role: "viewer" });
    });
    const section = screen.getByRole("region", { name: "Server Team server" });
    const list = await within(section).findByRole("tree", { name: "Workspaces on Team server" });
    const items = within(list).getAllByRole("treeitem");
    expect(items.map((i) => i.textContent)).toEqual(["›DesignWorkspace", "›ResearchWorkspace"]);
    expect(within(items[0]!).getByText("Workspace").className).toContain("badge-workspace");
    // The Private Space keeps its Local badge and comes first.
    const nav = screen.getByRole("navigation", { name: "Pages" });
    expect(nav.querySelector(".badge-private")).toBeNull();
    expect(document.querySelector(".sidebar .badge-private")?.textContent).toBe("Local");
  });

  it("a signed-out server shows Sign in, which opens Settings → Servers", async () => {
    const { app } = await start((s) => s.connect(LOCAL, { signedIn: false }));
    const section = screen.getByRole("region", { name: "Server Team server" });
    expect(within(section).queryByRole("tree")).toBeNull();
    await app.user.click(within(section).getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("region", { name: "Servers" })).toBeTruthy();
    expect(within(card("Team server")).getByRole("button", { name: "Use a personal access token" })).toBeTruthy();
  });

  it("expands a workspace to its page tree (nested pages included)", async () => {
    const { app, servers, ws } = await withWorkspace();
    const child = servers.writeAsOther(ws, { title: "Milestones", markdown: "# Milestones\n", parentId: servers.page(ws, "Plan").id });
    expect(child.parentId).not.toBeNull();
    const pages = await expandWorkspace(app);
    const plan = await within(pages).findByRole("treeitem", { name: "Plan" });
    expect(plan.getAttribute("aria-expanded")).toBe("false");
    await app.user.click(plan);
    expect(await within(pages).findByRole("treeitem", { name: "Milestones" })).toBeTruthy();
  });
});

describe("workspace pages", () => {
  it("opens a page in the same editor, with a Workspace breadcrumb, and autosaves with If-Match", async () => {
    const { app, servers, ws } = await withWorkspace({ autosaveMs: 60 });
    const box = await openPlan(app);
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByText("Workspace · Design")).toBeTruthy();
    expect(within(crumbs).getByText("Plan").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("group", { name: "Editor mode" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /backlinks/i })).toBeNull();

    const before = servers.page(ws, "Plan").revisions.at(-1)!.id;
    await type(app, box, " More.");
    await waitFor(() => expect(servers.page(ws, "Plan").markdown).toBe("# Plan\n\nFirst line here. More.\n"), { timeout: 3000 });
    const put = servers.calls.find((c) => c.method === "PUT")!;
    expect(put.headers).toMatchObject({ "if-match": `"${before}"`, "content-type": "application/json" });
    expect(servers.page(ws, "Plan").title).toBe("Plan");
    await waitFor(() => expect(screen.getByRole("status", { name: "" }).textContent).toBe("Saved"));
  });

  it("a stale save (412) opens the conflict dialog; Keep both creates a conflict copy in the workspace", async () => {
    const { app, servers, ws } = await withWorkspace();
    const box = await openPlan(app);
    servers.writeAsOther(ws, { id: servers.page(ws, "Plan").id, title: "Plan", markdown: "# Plan\n\nFirst line rewritten by Grace.\n" });
    await type(app, box, " Mine.");
    await app.user.keyboard("{Meta>}s{/Meta}");
    const dialog = await screen.findByRole("dialog", { name: "This page changed on the server" });
    expect(within(dialog).getByText("On the server")).toBeTruthy();
    expect(dialog.textContent).toContain("First line rewritten by Grace.");
    expect(dialog.textContent).toContain("First line here. Mine.");
    // Nothing was overwritten on the server.
    expect(servers.page(ws, "Plan").markdown).toBe("# Plan\n\nFirst line rewritten by Grace.\n");

    await app.user.click(within(dialog).getByRole("button", { name: /keep both/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const copy = servers.page(ws, "Plan (conflict copy)");
    expect(copy.markdown).toBe("# Plan\n\nFirst line here. Mine.\n");
    expect(copy.parentId).toBe(servers.page(ws, "Plan").parentId);
    await waitFor(() => expect(box.textContent).toContain("First line rewritten by Grace."));
    const note = screen.getByText(/your version was saved as/i);
    expect(note.textContent).toContain("Plan (conflict copy)");
    // The copy shows in the tree at once and opens from the notice.
    const pages = screen.getByRole("group", { name: "Pages in Design" });
    expect(within(pages).getByRole("treeitem", { name: "Plan (conflict copy)" })).toBeTruthy();
    await app.user.click(within(note.closest("p")!).getByRole("button", { name: "Open it" }));
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText("Plan (conflict copy)")).toBeTruthy());
  });

  it("a viewer sees the page read-only and nothing is ever written", async () => {
    const { app, servers } = await withWorkspace({ autosaveMs: 30 }, "viewer");
    const box = await openPlan(app);
    expect(screen.getByRole("note").textContent).toBe("You are a viewer in Design, so this page is read-only.");
    expect(box.getAttribute("contenteditable")).toBe("false");
    await app.user.keyboard("{Meta>}s{/Meta}");
    await new Promise((r) => setTimeout(r, 80));
    expect(servers.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("a quota error is shown in plain words", async () => {
    const { app, servers, ws } = await withWorkspace({}, "editor", { ...LOCAL, limits: { maxPagesPerWorkspace: 1 } });
    const box = await openPlan(app);
    servers.writeAsOther(ws, { id: servers.page(ws, "Plan").id, title: "Plan", markdown: "# Plan\n\nTheirs.\n" });
    await type(app, box, " Mine.");
    await app.user.keyboard("{Meta>}s{/Meta}");
    const dialog = await screen.findByRole("dialog", { name: "This page changed on the server" });
    await app.user.click(within(dialog).getByRole("button", { name: /keep both/i }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("This workspace is limited to 1 pages (1 in use); delete pages to make room.");
    // Still open, so the user can choose Keep mine or Keep theirs instead.
    expect(within(dialog).getByRole("button", { name: /keep mine/i })).toBeTruthy();
  });

  it("a 401 after a failed refresh marks the server signed out and offers Sign in", async () => {
    const { app, servers, server, ws } = await withWorkspace();
    const box = await openPlan(app);
    servers.expire(server);
    await type(app, box, " Later.");
    await app.user.keyboard("{Meta>}s{/Meta}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/signed out of this server/i);
    // The edit is still on screen.
    expect(box.textContent).toContain("First line here. Later.");
    const section = screen.getByRole("region", { name: "Server Team server" });
    expect(within(section).getByRole("button", { name: "Sign in" })).toBeTruthy();
    // Sign in over the page (leaving would drop the unsaved edit), then Retry saves it.
    await app.user.click(within(alert).getByRole("button", { name: "Sign in" }));
    const dialog = screen.getByRole("dialog", { name: "Sign in to Team server" });
    expect(within(dialog).queryByRole("button", { name: "Remove" })).toBeNull();
    await app.user.click(within(dialog).getByRole("button", { name: "Use a personal access token" }));
    await app.user.type(within(dialog).getByLabelText(/personal access token/i), "thoth_pat_good{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(servers.page(ws, "Plan").markdown).toBe("# Plan\n\nFirst line here. Later.\n"));
    expect(box.textContent).toContain("First line here. Later.");
  });
});

describe("change-feed polling", () => {
  it("updates the tree and reloads an open page without local edits", async () => {
    const { app, servers, ws } = await withWorkspace({ pollMs: 30 });
    const box = await openPlan(app);
    servers.writeAsOther(ws, { title: "Retro", markdown: "# Retro\n" });
    servers.writeAsOther(ws, { id: servers.page(ws, "Plan").id, title: "Plan", markdown: "# Plan\n\nUpdated elsewhere.\n" });
    const pages = screen.getByRole("group", { name: "Pages in Design" });
    expect(await within(pages).findByRole("treeitem", { name: "Retro" })).toBeTruthy();
    await waitFor(() => expect(box.textContent).toContain("Updated elsewhere."));
    expect(screen.queryByRole("dialog")).toBeNull();

    servers.deleteAsOther(ws, servers.page(ws, "Retro").id);
    await waitFor(() => expect(within(pages).queryByRole("treeitem", { name: "Retro" })).toBeNull());
  });

  it("with local edits, a remote change waits for the next save, which meets the conflict", async () => {
    const { app, servers, ws } = await withWorkspace({ pollMs: 30 });
    const box = await openPlan(app);
    await type(app, box, " Draft.");
    servers.writeAsOther(ws, { id: servers.page(ws, "Plan").id, title: "Plan", markdown: "# Plan\n\nTheirs.\n" });
    const changesBefore = servers.calls.filter((c) => c.path.endsWith("/changes")).length;
    await waitFor(() => expect(servers.calls.filter((c) => c.path.endsWith("/changes")).length).toBeGreaterThan(changesBefore + 1));
    expect(box.textContent).toContain("First line here. Draft.");
    expect(screen.queryByRole("dialog")).toBeNull();
    await app.user.keyboard("{Meta>}s{/Meta}");
    expect(await screen.findByRole("dialog", { name: "This page changed on the server" })).toBeTruthy();
  });

  it("stops while the window is hidden and resumes when it is visible", async () => {
    const { app, servers, ws } = await withWorkspace({ pollMs: 20 });
    await expandWorkspace(app);
    const polls = () => servers.calls.filter((c) => c.path.endsWith("/changes")).length;
    await waitFor(() => expect(polls()).toBeGreaterThan(0));
    setVisibility("hidden");
    await new Promise((r) => setTimeout(r, 40)); // let an in-flight poll finish
    const frozen = polls();
    servers.writeAsOther(ws, { title: "While away", markdown: "# While away\n" });
    await new Promise((r) => setTimeout(r, 150));
    expect(polls()).toBe(frozen);
    expect(screen.queryByRole("treeitem", { name: "While away" })).toBeNull();

    setVisibility("visible");
    expect(await screen.findByRole("treeitem", { name: "While away" })).toBeTruthy();
  });

  it("polls only expanded workspaces", async () => {
    const { servers } = await withWorkspace({ pollMs: 20 });
    await screen.findByRole("tree", { name: "Workspaces on Team server" });
    await new Promise((r) => setTimeout(r, 100));
    expect(servers.calls.filter((c) => c.path.endsWith("/changes"))).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("derives a workspace page title from frontmatter, then the first heading", () => {
    expect(titleFromMarkdown("---\ntitle: \"Roadmap\"\n---\n# Other\n", "x")).toBe("Roadmap");
    expect(titleFromMarkdown("intro\n\n## Not this\n\n# Plan B ##\n", "x")).toBe("Plan B");
    expect(titleFromMarkdown("no heading", "Fallback")).toBe("Fallback");
  });

  it("describes limits in plain words and skips protocol tuning", () => {
    expect(describeLimits({ maxPagesPerWorkspace: 1, maxWorkspacesPerAccount: 3, revisionRetentionDays: 30, idempotencyWindowSeconds: 86400, maxMarkdownBytes: 1024 * 1024, x: 2 })).toEqual([
      "1 page per workspace",
      "3 workspaces per account",
      "Old versions of a page are kept for 30 days",
      "1 MB per page",
      "x: 2",
    ]);
  });

  it("nests the tree, keeps orphans at the top and survives a cycle", () => {
    const T = "2026-10-23T10:00:00Z";
    const n = (id: string, parentId: string | null, title: string) => ({ id, parentId, title, revisionId: "r", updatedAt: T });
    const tree = nestWorkspaceTree([n("b", "a", "B"), n("a", null, "A"), n("o", "missing", "Orphan"), n("x", "y", "X"), n("y", "x", "Y")]);
    expect(tree.map((t) => t.title)).toEqual(["A", "Orphan"]);
    expect(tree[0]!.children.map((t) => t.title)).toEqual(["B"]);
  });
});
