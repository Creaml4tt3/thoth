// @vitest-environment jsdom
// The web client's sidebar: the drag handle keeps only a width in localStorage; icon buttons are named with the web client's keys.
import { afterEach, describe, expect, it } from "vitest";
import { FakeWebServer } from "./support/fake-web-server.ts";
import { SIDEBAR_HIDDEN_KEY, SIDEBAR_KEY, loadSidebarWidth, saveSidebarWidth } from "../src/sidebar-store.ts";
import { cleanup, fakeBrowser, open, screen, signInThroughUi, waitFor, within } from "./support/render.tsx";

afterEach(() => cleanup());

async function signedIn(local = new Map<string, string>()) {
  const server = new FakeWebServer();
  const ws = server.workspace("Notes");
  server.servers.writeAsOther(ws, { title: "Alpha", markdown: "# Alpha\n" });
  const browser = fakeBrowser(server, { local });
  await signInThroughUi(browser);
  return browser;
}
const handle = () => screen.getByRole("separator", { name: "Resize sidebar" });

describe("web sidebar", () => {
  it("has the drag handle at the default width and stores only a number", async () => {
    const browser = await signedIn();
    expect(handle().getAttribute("aria-valuenow")).toBe("260");
    handle().focus();
    await browser.user.keyboard("{ArrowRight}");
    await waitFor(() => expect(handle().getAttribute("aria-valuenow")).toBe("276"));
    expect(browser.local.get(SIDEBAR_KEY)).toBe("276");
    // Nothing else about the account or the pages is in that value.
    expect(browser.local.get(SIDEBAR_KEY)).toMatch(/^\d+$/);
  });

  it("restores the width after a reload", async () => {
    await signedIn(new Map([[SIDEBAR_KEY, "350"]]));
    expect(handle().getAttribute("aria-valuenow")).toBe("350");
  });

  it("reads and writes the width defensively", () => {
    const map = new Map<string, string>();
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    saveSidebarWidth(store, 300);
    expect(loadSidebarWidth(store)).toBe(300);
    saveSidebarWidth(store, null);
    expect(map.has(SIDEBAR_KEY)).toBe(false);
    expect(loadSidebarWidth(null)).toBeNull();
    map.set(SIDEBAR_KEY, "lots");
    expect(loadSidebarWidth(store)).toBeNull();
  });

  it("the workspace's add buttons and Sign out are icon buttons with names", async () => {
    await signedIn();
    for (const name of [/^New page in Notes$/, /^New folder in Notes$/, /^Sign out$/]) {
      const button = await screen.findByRole("button", { name });
      expect(button.textContent).toBe("");
      expect(button.getAttribute("data-tip")).toMatch(name);
    }
  });
});

describe("hiding the web sidebar", () => {
  it("Hide sidebar and Ctrl+\\ take it out of the page's tab order and accessibility tree, and it is kept in this browser", async () => {
    const browser = await signedIn();
    const aside = document.querySelector<HTMLElement>("aside.sidebar")!;
    await browser.user.click(within(screen.getByRole("complementary", { name: "Sidebar" })).getByRole("button", { name: "Hide sidebar" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull());
    expect(aside.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("separator", { name: "Resize sidebar" })).toBeNull();
    const show = screen.getByRole("button", { name: "Show sidebar" });
    expect(document.activeElement).toBe(show);
    expect(browser.local.get(SIDEBAR_HIDDEN_KEY)).toBe("1");
    await browser.user.keyboard("{Control>}\\{/Control}");
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Sidebar" })).toBeTruthy());
    expect(browser.local.has(SIDEBAR_HIDDEN_KEY)).toBe(false);
    expect(handle()).toBeTruthy();
  });

  it("comes back hidden after a reload", async () => {
    const browser = await signedIn();
    await browser.user.keyboard("{Control>}\\{/Control}");
    await waitFor(() => expect(browser.local.get(SIDEBAR_HIDDEN_KEY)).toBe("1"));
    cleanup();
    open(browser);
    expect(await screen.findByRole("button", { name: "Show sidebar" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();
  });
});
