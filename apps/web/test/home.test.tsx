// @vitest-environment jsdom
// Home in the web client (ADR-0029): a new tab shows it, the brand row and the tab bar's button open it as one tab, and
// the recent workspace pages are kept in this browser per account, by id.
import { afterEach, describe, expect, it } from "vitest";
import { FakeWebServer } from "./support/fake-web-server.ts";
import { cleanup, fakeBrowser, screen, signInThroughUi, waitFor, within } from "./support/render.tsx";

afterEach(() => cleanup());

const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);
const current = () => screen.queryAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const row = (name: string) => screen.findByRole("treeitem", { name });
const titles = (name: "Recent" | "Favorites") => [...(within(screen.getByTestId("home")).queryByRole("list", { name })?.querySelectorAll(".home-row-title") ?? [])].map((el) => el.textContent);

async function signedIn() {
  const server = new FakeWebServer();
  const ws = server.workspace("Notes");
  for (const title of ["Alpha", "Beta"]) server.servers.writeAsOther(ws, { title, markdown: `# ${title}\n` });
  const browser = fakeBrowser(server);
  await signInThroughUi(browser);
  return browser;
}

describe("Home on the web", () => {
  it("is what a new tab shows, lists the pages opened last with their workspace, and opens one in a new tab on Ctrl+click", async () => {
    const browser = await signedIn();
    expect(within(screen.getByTestId("home")).getByRole("heading", { level: 1, name: "Welcome back" })).toBeTruthy();
    expect(screen.getByTestId("home").textContent).toContain("Pages you open show here.");
    await browser.user.click(await row("Alpha"));
    await waitFor(() => expect(current()).toBe("Alpha"));
    await browser.user.click(await row("Beta"));
    await waitFor(() => expect(current()).toBe("Beta"));

    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    await browser.user.click(within(sidebar).getByRole("button", { name: "Thoth home" }));
    await waitFor(() => expect(tabNames()).toEqual(["Beta", "Home"]));
    await waitFor(() => expect(titles("Recent")).toEqual(["Beta", "Alpha"]));
    expect(within(screen.getByTestId("home")).getByRole("button", { name: /^Alpha/ }).textContent).toContain("Notes");
    await browser.user.keyboard("{Control>}");
    await browser.user.click(within(screen.getByTestId("home")).getByRole("button", { name: /^Alpha/ }));
    await browser.user.keyboard("{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Beta", "Home", "Alpha"]));

    // One Home tab: the tab bar's button goes to it.
    await browser.user.click(screen.getByRole("button", { name: "Home" }));
    await waitFor(() => expect(current()).toBe("Home"));
    expect(tabNames()).toEqual(["Beta", "Home", "Alpha"]);

    // Kept per account, by id, with no title.
    const stored = [...browser.local.entries()].find(([key]) => key.startsWith("thoth.web.recent."));
    expect(stored?.[0]).toMatch(/^thoth\.web\.recent\..+/);
    expect(stored?.[1]).toContain('"k":"ws"');
    expect(stored?.[1]).not.toContain("Alpha");
  });

  // The desktop's Home is its Private Space picker (ADR-0029, amendment of 2026-10-28); the web keeps the Home tab.
  it("keeps its Home tab: the palette's Go home opens it, under the name Home", async () => {
    const browser = await signedIn();
    await browser.user.click(await row("Alpha"));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    await browser.user.keyboard("{Control>}k{/Control}");
    await browser.user.keyboard(">go home");
    await browser.user.keyboard("{Enter}");
    await waitFor(() => expect(current()).toBe("Home"));
    expect(tabNames()).toEqual(["Alpha", "Home"]);
    expect(screen.getByRole("button", { name: "Home" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Private Spaces/ })).toBeNull();
  });
});
