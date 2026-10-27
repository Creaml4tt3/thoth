// @vitest-environment jsdom
/**
 * The web client's notifications (ADR-0018): the bell and its list only. Its one event is a save conflict (no agents,
 * imports or transfers on the web), and nothing is shown outside the browser tab or kept in its storage.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeWebServer } from "./support/fake-web-server.ts";
import { cleanup, editorBox, fakeBrowser, screen, signInThroughUi, waitFor, within } from "./support/render.tsx";
import { caretAtEnd } from "./support/caret.ts";

afterEach(() => cleanup());

const bell = () => screen.getByRole("button", { name: /^Notifications/ });

describe("web notifications", () => {
  it("a save conflict is an entry under the bell that opens the page; nothing is shown by the system or kept", async () => {
    const notify = vi.fn();
    vi.stubGlobal("Notification", Object.assign(notify, { permission: "granted", requestPermission: vi.fn() }));
    const server = new FakeWebServer();
    const ws = server.workspace("Team");
    const page = server.servers.writeAsOther(ws, { title: "Roadmap", markdown: "# Roadmap\n\nQuarterly goals.\n" });
    server.servers.writeAsOther(ws, { title: "Other", markdown: "# Other\n" });
    const browser = fakeBrowser(server, { autosaveMs: 30 });
    await signInThroughUi(browser, "GitHub");

    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    expect(within(sidebar).getByRole("button", { name: "Notifications" })).toBe(bell());

    await browser.user.click(await screen.findByRole("treeitem", { name: "Roadmap" }));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("Quarterly"));
    box.focus();
    caretAtEnd([...box.querySelectorAll("p")].find((p) => p.textContent === "Quarterly goals.")!);
    await browser.user.keyboard("x");
    await waitFor(() => expect(browser.events.some((e) => e.name === "page_save")).toBe(true));
    server.servers.writeAsOther(ws, { id: page.id, title: "Roadmap", markdown: "# Roadmap\n\nSECRET notes changed by Grace.\n" });
    await browser.user.keyboard("y{Control>}s{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "This page changed on the server" });
    await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 1 unread"));
    expect(screen.getByTestId("notification-live").textContent).toBe("Roadmap changed elsewhere while you were editing it. Choose which version to keep.");
    await browser.user.click(within(dialog).getByRole("button", { name: /Keep theirs/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await browser.user.click(await screen.findByRole("treeitem", { name: "Other" }));
    await browser.user.click(bell());
    const list = screen.getByRole("dialog", { name: "Notifications" });
    expect(list.textContent).not.toContain("SECRET");
    await browser.user.click(within(list).getByRole("button", { name: /Roadmap changed elsewhere/ }));
    await waitFor(() => expect(screen.getByRole("tab", { selected: true }).textContent).toContain("Roadmap"));
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
    // In a new tab: Other, the page on screen, stays open beside it.
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Other", "Roadmap"]);

    // The browser's own notifications are never used, and the list is not kept in the browser's storage.
    expect(notify).not.toHaveBeenCalled();
    for (const value of browser.local.values()) expect(value).not.toContain("Roadmap changed");
    for (const value of browser.session.values()) expect(value).not.toContain("Roadmap changed");
    vi.unstubAllGlobals();
  });

  it("opens from the palette, and Esc returns focus to the bell", async () => {
    const server = new FakeWebServer();
    server.workspace("Team");
    const browser = fakeBrowser(server);
    await signInThroughUi(browser, "GitHub");
    await screen.findByRole("tree");
    await browser.user.keyboard("{Control>}k{/Control}");
    await browser.user.keyboard(">notif");
    await browser.user.keyboard("{Enter}");
    const list = await screen.findByRole("dialog", { name: "Notifications" });
    expect(list.textContent).toContain("Nothing yet.");
    await browser.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(document.activeElement).toBe(bell());
  });
});
