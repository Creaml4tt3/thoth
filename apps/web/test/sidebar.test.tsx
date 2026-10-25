// @vitest-environment jsdom
// The web client's sidebar: the drag handle keeps only a width in localStorage; icon buttons are named with the web client's keys.
import { afterEach, describe, expect, it } from "vitest";
import { FakeWebServer } from "./support/fake-web-server.ts";
import { SIDEBAR_KEY, loadSidebarWidth, saveSidebarWidth } from "../src/sidebar-store.ts";
import { cleanup, fakeBrowser, screen, signInThroughUi, waitFor } from "./support/render.tsx";

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
