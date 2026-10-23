// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { FakeWebServer, SERVER } from "./support/fake-web-server.ts";
import { cleanup, editorBox, fakeBrowser, open, screen, signInThroughUi, waitFor, within } from "./support/render.tsx";

afterEach(() => cleanup());

const TOKEN = /thoth_(at|rt)_/;

/** Everything a script on the page could read: storage, the DOM (cookies are the server's HttpOnly business). */
function readable(browser: ReturnType<typeof fakeBrowser>): string {
  return JSON.stringify([...browser.session], null, 0) + JSON.stringify([...browser.local]) + document.documentElement.outerHTML + browser.location.pathname + browser.location.search;
}

describe("sign-in", () => {
  it("shows a button per provider from capabilities, the demo caution and the limits", async () => {
    const browser = fakeBrowser();
    open(browser);
    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
    expect(screen.getByText(/A free demo for trying Thoth/)).toBeTruthy();
    expect(screen.getByText("200 pages per workspace")).toBeTruthy();
    expect(screen.getByText("1 workspace per account")).toBeTruthy();
    // Not signed in yet: no protocol request carried a token.
    expect(browser.server.requests.filter((r) => r.url.includes("/api/v1/") && !r.url.endsWith("/capabilities"))).toHaveLength(0);
  });

  it("redirects to the authorization endpoint with PKCE S256, state and the provider; the verifier stays in sessionStorage only", async () => {
    const browser = fakeBrowser();
    open(browser);
    await browser.user.click(await screen.findByRole("button", { name: "Sign in with GitHub" }));
    await waitFor(() => expect(browser.navigations).toHaveLength(1));
    const url = new URL(browser.navigations[0]!);
    expect(`${url.origin}${url.pathname}`).toBe(`${SERVER}/auth/authorize`);
    const q = url.searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ response_type: "code", client_id: "thoth-web", redirect_uri: "https://thoth.test/app/callback", code_challenge_method: "S256", provider: "github" });
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")!.length).toBeGreaterThanOrEqual(32);
    const pending = JSON.parse([...browser.session.values()][0]!) as { state: string; verifier: string };
    expect(pending.state).toBe(q.get("state"));
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect([...browser.local.keys()].some((k) => /signin|verifier|state/.test(k))).toBe(false);
  });

  it("completes on /app/callback: checks state and iss, exchanges the code with credentials, clears the URL and sessionStorage", async () => {
    const browser = fakeBrowser();
    browser.server.workspace("Ada Lovelace's workspace");
    await signInThroughUi(browser);
    const exchange = browser.server.requests.find((r) => r.url.endsWith("/auth/token") && r.body.includes("authorization_code"))!;
    expect(exchange.credentials).toBe("include");
    expect(new URLSearchParams(exchange.body).get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(browser.location.pathname).toBe("/app/");
    expect(browser.location.search).toBe("");
    expect(browser.session.size).toBe(0);
    expect(screen.getByText("Signed in as Ada Lovelace")).toBeTruthy();
    // The access token is used only as a bearer header, and is nowhere a script could find it.
    const apiCall = browser.server.requests.find((r) => r.url.endsWith("/api/v1/workspaces"))!;
    expect(apiCall.headers["authorization"]).toMatch(/^Bearer thoth_at_/);
    expect(apiCall.credentials).toBe("omit");
    expect(readable(browser)).not.toMatch(TOKEN);
  });

  it.each([
    ["a wrong state", { state: "not-the-state" }, /did not start here/],
    ["a missing iss", { iss: null }, /did not start here/],
    ["an iss from another server", { iss: "https://evil.example" }, /did not start here/],
    ["access_denied", { code: null, error: "access_denied" }, /cancelled, or the server is not accepting new accounts/],
  ])("refuses %s and does not exchange a code", async (_name, override, message) => {
    const browser = fakeBrowser();
    const first = open(browser);
    await browser.user.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    await waitFor(() => expect(browser.navigations).toHaveLength(1));
    const back = new URL(browser.server.callbackUrl(browser.navigations[0]!, override as Record<string, string | null>));
    first.unmount();
    browser.location.pathname = back.pathname;
    browser.location.search = back.search;
    open(browser);
    expect((await screen.findByRole("alert")).textContent).toMatch(message);
    expect(browser.server.requests.some((r) => r.url.endsWith("/auth/token") && r.body.includes("authorization_code"))).toBe(false);
    expect(browser.location.search).toBe("");
    expect(browser.session.size).toBe(0);
  });

  it("a callback can be used once: reloading it does not sign in again", async () => {
    const browser = fakeBrowser();
    const first = open(browser);
    await browser.user.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    await waitFor(() => expect(browser.navigations).toHaveLength(1));
    const back = new URL(browser.server.callbackUrl(browser.navigations[0]!));
    first.unmount();
    browser.location.pathname = back.pathname;
    browser.location.search = back.search;
    const second = open(browser);
    await screen.findByRole("button", { name: "Sign out" });
    second.unmount();
    browser.server.cookie = null; // a different browser, or a cleared cookie
    browser.location.pathname = back.pathname;
    browser.location.search = back.search;
    open(browser);
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not start here/);
  });
});

describe("session", () => {
  it("a returning visitor is signed in silently from the cookie", async () => {
    const browser = fakeBrowser();
    browser.server.workspace("Notes");
    browser.server.giveCookie();
    open(browser);
    expect(await screen.findByRole("tree", { name: "Workspaces" })).toBeTruthy();
    const refresh = browser.server.requests.find((r) => r.url.endsWith("/auth/token"))!;
    expect(refresh.credentials).toBe("include");
    expect(new URLSearchParams(refresh.body).has("refresh_token")).toBe(false);
  });

  it("without a cookie the sign-in page shows, with no error", async () => {
    const browser = fakeBrowser();
    open(browser);
    await screen.findByRole("button", { name: "Sign in with Google" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refreshes one at a time: concurrent 401s share one refresh", async () => {
    const browser = fakeBrowser();
    const ws = browser.server.workspace("Notes");
    browser.server.servers.writeAsOther(ws, { title: "A", markdown: "# A\n" });
    browser.server.giveCookie();
    open(browser);
    await screen.findByRole("tree", { name: "Workspaces" });
    const before = browser.server.refreshCalls;
    browser.server.expireAccess();
    browser.server.tokenDelayMs = 30;
    // Opening a page: several requests meet the 401 while one refresh is in flight.
    await browser.user.click(await screen.findByRole("treeitem", { name: "A" }));
    await editorBox();
    expect(browser.server.refreshCalls - before).toBe(1);
  });

  it("an outage during the silent refresh is not a sign-out: it says so and offers to try again", async () => {
    const browser = fakeBrowser();
    browser.server.workspace("Notes");
    browser.server.giveCookie();
    browser.server.networkDownFor = 1;
    open(browser);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not reach the Thoth server/);
    expect(browser.server.cookie).not.toBeNull();
  });

  it("sign out calls revoke with the cookie and returns to the sign-in page", async () => {
    const browser = fakeBrowser();
    browser.server.workspace("Notes");
    await signInThroughUi(browser);
    expect(browser.server.liveSessions()).toBe(1);
    await browser.user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeTruthy();
    const revoke = browser.server.requests.find((r) => r.url.endsWith("/auth/revoke"))!;
    expect(revoke.credentials).toBe("include");
    expect(Object.fromEntries(new URLSearchParams(revoke.body))).toEqual({ client_id: "thoth-web" });
    expect(browser.server.liveSessions()).toBe(0);
    expect(browser.server.cookie).toBeNull();
  });
});

describe("workspaces", () => {
  async function signedIn(setup: (s: FakeWebServer) => void = () => undefined, options: Parameters<typeof fakeBrowser>[1] = {}) {
    const server = new FakeWebServer();
    setup(server);
    const browser = fakeBrowser(server, options);
    await signInThroughUi(browser);
    return browser;
  }

  it("a new account finds its one workspace open, creates a page, edits it in Blocks and Plain, and it autosaves", async () => {
    const browser = await signedIn((s) => s.workspace("Ada Lovelace's workspace"), { autosaveMs: 40 });
    const tree = screen.getByRole("tree", { name: "Workspaces" });
    const pages = await within(tree).findByRole("group", { name: "Pages in Ada Lovelace's workspace" });
    expect(within(pages).getByText("No pages yet.")).toBeTruthy();

    await browser.user.click(within(tree).getByRole("button", { name: "New page in Ada Lovelace's workspace" }));
    const box = await editorBox();
    const put = browser.server.requests.find((r) => r.method === "PUT")!;
    expect(put.headers["if-none-match"]).toBe("*");
    expect(within(pages).getByRole("treeitem", { name: "Untitled" })).toBeTruthy();

    box.focus();
    await browser.user.keyboard("# Plan");
    const ws = browser.server.servers.workspaces.get(browser.server.handle)![0]!;
    await waitFor(() => expect([...ws.pages.values()][0]!.markdown.trim()).toBe("# Plan"));
    await waitFor(() => expect(screen.getByRole("status", { name: "" }).textContent).toBe("Saved"));

    await browser.user.click(screen.getByRole("button", { name: "Plain" }));
    const plain = await editorBox();
    expect(plain.closest("[data-editor-mode]")!.getAttribute("data-editor-mode")).toBe("plain");
    expect(plain.textContent).toContain("Plan");
    plain.focus();
    await browser.user.keyboard("{Control>}{End}{/Control}{Enter}{Enter}Written in Plain.");
    await waitFor(() => expect([...ws.pages.values()][0]!.markdown).toContain("Written in Plain."));
    expect([...ws.pages.values()][0]!.title).toBe("Plan");
    expect(readable(browser)).not.toMatch(TOKEN);
  });

  it("viewers get no New page", async () => {
    await signedIn((s) => s.workspace("Shared", "viewer"));
    const tree = screen.getByRole("tree", { name: "Workspaces" });
    expect(within(tree).queryByRole("button", { name: /New page/ })).toBeNull();
  });

  it("a stale save shows the conflict dialog, and Keep both saves my version as a new page", async () => {
    const browser = await signedIn((s) => {
      const ws = s.workspace("Team", "editor");
      s.servers.writeAsOther(ws, { title: "Plan", markdown: "# Plan\n\nFirst line.\n" });
    });
    const ws = browser.server.servers.workspaces.get(browser.server.handle)![0]!;
    // The only workspace is open already.
    await browser.user.click(await screen.findByRole("treeitem", { name: "Plan" }));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("First line."));

    browser.server.servers.writeAsOther(ws, { id: browser.server.servers.page(ws, "Plan").id, title: "Plan", markdown: "# Plan\n\nRewritten elsewhere.\n" });
    box.focus();
    const { caretAtEnd } = await import("./support/caret.ts");
    caretAtEnd([...box.querySelectorAll("p")].find((p) => p.textContent === "First line.")!);
    await browser.user.keyboard(" Mine.");
    await browser.user.keyboard("{Control>}s{/Control}");

    const dialog = await screen.findByRole("dialog", { name: "This page changed on the server" });
    expect(within(dialog).getByText("Rewritten elsewhere.")).toBeTruthy();
    await browser.user.click(within(dialog).getByRole("button", { name: /Keep both/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(browser.server.servers.page(ws, "Plan").markdown).toBe("# Plan\n\nRewritten elsewhere.\n");
    expect(browser.server.servers.page(ws, "Plan (conflict copy)").markdown).toContain("First line. Mine.");
    expect(browser.events.map((e) => e.name)).toEqual(expect.arrayContaining(["conflict_shown", "conflict_resolved"]));
    expect(browser.events.find((e) => e.name === "conflict_resolved")!.params).toEqual({ choice: "both" });
  });

  it("search lists matching pages across workspaces and opens one; analytics gets `search` without the text", async () => {
    const browser = await signedIn((s) => {
      const ws = s.workspace("Team");
      s.servers.writeAsOther(ws, { title: "Roadmap", markdown: "# Roadmap\n\nQuarterly goals.\n" });
      s.servers.writeAsOther(ws, { title: "Other", markdown: "# Other\n" });
    });
    await browser.user.click(screen.getByRole("button", { name: "Search" }));
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    await browser.user.type(within(dialog).getByRole("combobox"), "quarterly");
    const option = await within(dialog).findByRole("option", { name: /Roadmap/ });
    await browser.user.click(option);
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("Quarterly goals."));
    const searches = browser.events.filter((e) => e.name === "search");
    expect(searches).toEqual([{ name: "search", params: {} }]);
    expect(JSON.stringify(browser.events)).not.toMatch(/quarterly|Roadmap/i);
  });

  it("polls the change feed while visible and shows pages others create", async () => {
    const browser = await signedIn((s) => s.workspace("Team"), { pollMs: 30 });
    const ws = browser.server.servers.workspaces.get(browser.server.handle)![0]!;
    await screen.findByRole("group", { name: "Pages in Team" });
    browser.server.servers.writeAsOther(ws, { title: "From a colleague", markdown: "# Hi\n" });
    expect(await screen.findByRole("treeitem", { name: "From a colleague" })).toBeTruthy();
  });

  it("a session that ends keeps the open page and says so", async () => {
    const browser = await signedIn((s) => {
      const ws = s.workspace("Team");
      s.servers.writeAsOther(ws, { title: "Plan", markdown: "# Plan\n\nText.\n" });
    });
    await browser.user.click(await screen.findByRole("treeitem", { name: "Plan" }));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("Text."));
    browser.server.revokeAll();
    box.focus();
    await browser.user.keyboard("{Control>}s{/Control}");
    // Nothing changed, so nothing is sent; an edit is what meets the 401.
    await browser.user.keyboard("x{Control>}s{/Control}");
    expect((await screen.findByText(/You were signed out/)).textContent).toBeTruthy();
    expect(await editorBox()).toBe(box);
  });
});

describe("English and Thai", () => {
  it("follows the browser's language, has a switch, and remembers the choice", async () => {
    const browser = fakeBrowser(new FakeWebServer(), { languages: ["th-TH", "en"] });
    open(browser);
    expect(await screen.findByRole("button", { name: "เข้าสู่ระบบด้วย Google" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("th");
    await browser.user.selectOptions(screen.getByRole("combobox", { name: "ภาษา" }), "en");
    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
    expect(browser.local.get("thoth.web.lang")).toBe("en");
  });

  it("the editor's own menus and the conflict dialog are in Thai too", async () => {
    const server = new FakeWebServer();
    server.workspace("งานของฉัน");
    const browser = fakeBrowser(server, { languages: ["th"] });
    const view = open(browser);
    await browser.user.click(await screen.findByRole("button", { name: "เข้าสู่ระบบด้วย Google" }));
    await waitFor(() => expect(browser.navigations).toHaveLength(1));
    const back = new URL(server.callbackUrl(browser.navigations[0]!));
    view.unmount();
    browser.location.pathname = back.pathname;
    browser.location.search = back.search;
    open(browser);
    const tree = await screen.findByRole("tree", { name: "เวิร์กสเปซ" });
    await browser.user.click(within(tree).getByRole("button", { name: "หน้าใหม่ใน งานของฉัน" }));
    const box = await editorBox();
    expect(screen.getByRole("group", { name: "โหมดแก้ไข" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "บล็อก" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ข้อความล้วน" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "ตำแหน่งของหน้า" }).textContent).toContain("เวิร์กสเปซ · งานของฉัน");
    expect(document.querySelector('[role="listbox"][aria-label="แทรกบล็อก"]')).not.toBeNull();
    // The `/` menu offers Thai block names, and English words still find them.
    box.focus();
    await browser.user.keyboard("/heading");
    const menu = document.querySelector<HTMLElement>('[role="listbox"][aria-label="แทรกบล็อก"]')!;
    await waitFor(() => expect(menu.hidden).toBe(false));
    expect([...menu.querySelectorAll('[role="option"]')].map((o) => o.querySelector(".slash-option-title")?.textContent)).toEqual(["หัวข้อ 1", "หัวข้อ 2", "หัวข้อ 3"]);
    await browser.user.keyboard("{Escape}");

    // The conflict dialog.
    const ws = server.servers.workspaces.get(server.handle)![0]!;
    const page = [...ws.pages.values()][0]!;
    server.servers.writeAsOther(ws, { id: page.id, title: "อื่น", markdown: "เปลี่ยนจากที่อื่น\n" });
    await browser.user.keyboard("{Control>}s{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "หน้านี้ถูกเปลี่ยนบนเซิร์ฟเวอร์" });
    expect(within(dialog).getByRole("button", { name: /เก็บไว้ทั้งคู่/ })).toBeTruthy();
  });
});
