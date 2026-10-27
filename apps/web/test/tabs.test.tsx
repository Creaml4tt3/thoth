// @vitest-environment jsdom
// Tabs in the web client (ADR-0016 rule 5, Phase 3b AC 7), with the browser's own keys left alone (rule 7).
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { FakeWebServer } from "./support/fake-web-server.ts";
import { TABS_KEY } from "../src/tabs-store.ts";
import { caretAtEnd } from "./support/caret.ts";
import { cleanup, editorBox, fakeBrowser, open, screen, signInThroughUi, waitFor, within, type FakeBrowser } from "./support/render.tsx";

afterEach(() => cleanup());

const tabs = () => screen.queryAllByRole("tab");
const tabNames = () => tabs().map((t) => t.textContent);
const current = () => tabs().find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const paragraph = (box: HTMLElement, text: string): HTMLElement => {
  const found = [...box.querySelectorAll("p")].find((p) => p.textContent === text);
  if (!found) throw new Error(`No paragraph "${text}"`);
  return found;
};
const row = (name: string) => screen.findByRole("treeitem", { name });

async function signedIn(titles: string[] = ["Alpha", "Beta", "Gamma"], options: Parameters<typeof fakeBrowser>[1] = {}) {
  const server = new FakeWebServer();
  const ws = server.workspace("Notes");
  for (const title of titles) server.servers.writeAsOther(ws, { title, markdown: `# ${title}\n\nBody of ${title}.\n` });
  const browser = fakeBrowser(server, options);
  await signInThroughUi(browser);
  return Object.assign(browser, { ws });
}

async function ctrlClick(browser: FakeBrowser, name: string) {
  await browser.user.keyboard("{Control>}");
  await browser.user.click(await row(name));
  await browser.user.keyboard("{/Control}");
}

describe("opening pages in tabs", () => {
  it("starts with one empty tab; a click opens a page in the current tab", async () => {
    const browser = await signedIn();
    expect(tabNames()).toEqual(["New tab"]);
    await browser.user.click(await row("Alpha"));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha"]));
    await browser.user.click(await row("Beta"));
    await waitFor(() => expect(tabNames()).toEqual(["Beta"]));
    await editorBox();
  });

  it("Cmd/Ctrl+click and middle-click open new tabs; Cmd/Ctrl+Enter too", async () => {
    const browser = await signedIn();
    await browser.user.click(await row("Alpha"));
    await ctrlClick(browser, "Beta");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));
    expect(current()).toBe("Beta");
    fireEvent(await row("Gamma"), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta", "Gamma"]));
    (await row("Alpha")).focus();
    await browser.user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta", "Gamma", "Alpha"]));
  });

  it("uses Alt-based keys because the browser keeps Cmd/Ctrl+T, W and 1–9 and Ctrl+Tab", async () => {
    const browser = await signedIn();
    await browser.user.click(await row("Alpha"));
    await ctrlClick(browser, "Beta");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));

    // The browser's keys do nothing here: they belong to the browser.
    await browser.user.keyboard("{Control>}t{/Control}");
    await browser.user.keyboard("{Control>}w{/Control}");
    await browser.user.keyboard("{Control>}1{/Control}");
    await browser.user.keyboard("{Control>}{Tab}{/Control}");
    expect(tabNames()).toEqual(["Alpha", "Beta"]);
    expect(current()).toBe("Beta");

    await browser.user.keyboard("{Alt>}1{/Alt}");
    await waitFor(() => expect(current()).toBe("Alpha"));
    await browser.user.keyboard("{Alt>}{PageDown}{/Alt}");
    await waitFor(() => expect(current()).toBe("Beta"));
    await browser.user.keyboard("{Alt>}{PageUp}{/Alt}");
    await waitFor(() => expect(current()).toBe("Alpha"));
    await browser.user.keyboard("{Alt>}t{/Alt}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "New tab", "Beta"]));
    await browser.user.keyboard("{Alt>}w{/Alt}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta"]));
  });

  it("Settings opens as a tab, from Alt+Comma, with the theme and language controls", async () => {
    const browser = await signedIn();
    await browser.user.click(await row("Alpha"));
    await browser.user.keyboard("{Alt>}[Comma]{/Alt}");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Settings"]));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("combobox", { name: "Theme" })).toBeTruthy();
    expect(within(panel).getByRole("combobox", { name: "Language" })).toBeTruthy();
    const nav = within(panel).getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Appearance", "Keyboard", "Account"]);
    await browser.user.keyboard("{Alt>}[Comma]{/Alt}");
    expect(tabNames()).toEqual(["Alpha", "Settings"]);
  });

  it("writes the edit before switching tabs", async () => {
    const browser = await signedIn();
    await browser.user.click(await row("Alpha"));
    await ctrlClick(browser, "Beta");
    await browser.user.keyboard("{Alt>}1{/Alt}");
    await waitFor(() => expect(current()).toBe("Alpha"));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("Body of Alpha."));
    box.focus();
    caretAtEnd(paragraph(box, "Body of Alpha."));
    await browser.user.keyboard(" More words.");
    const saved = () => browser.server.servers.page(browser.ws, "Alpha").markdown;
    await browser.user.keyboard("{Alt>}2{/Alt}");
    await waitFor(() => expect(current()).toBe("Beta"));
    await waitFor(() => expect(saved()).toContain("More words."));
  });
});

describe("reordering tabs (ADR-0019: reorder only on the web)", () => {
  it("Alt+Shift+Right moves the focused tab, the order survives a reload, and there is no new window", async () => {
    const browser = await signedIn();
    await browser.user.click(await row("Alpha"));
    await ctrlClick(browser, "Beta");
    await ctrlClick(browser, "Gamma");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Beta", "Gamma"]));
    tabs()[0]!.focus();
    await browser.user.keyboard("{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}");
    await waitFor(() => expect(tabNames()).toEqual(["Beta", "Alpha", "Gamma"]));
    expect(current()).toBe("Gamma");

    fireEvent.contextMenu(screen.getByRole("tab", { name: "Alpha" }), { clientX: 10, clientY: 10 });
    expect(screen.getByRole("menuitem", { name: /^Move tab left/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Move tab to new window" })).toBeNull();
    await browser.user.keyboard("{Escape}");

    cleanup();
    // A reload: same storage, same server, the cookie signs the visitor in again.
    const again = fakeBrowser(browser.server, { local: browser.local });
    again.server.giveCookie();
    open(again);
    await waitFor(() => expect(tabNames()).toEqual(["Beta", "Alpha", "Gamma"]));
  });
});

describe("restoring tabs in the same browser", () => {
  it("keeps ids only in localStorage: no page title, no text, no sign-in data", async () => {
    const browser = await signedIn();
    await browser.user.click(await row("Alpha"));
    await ctrlClick(browser, "Beta");
    await waitFor(() => expect(JSON.parse(browser.local.get(TABS_KEY) ?? "null")?.panes?.[0]?.tabs).toHaveLength(2));
    const stored = browser.local.get(TABS_KEY)!;
    expect(Object.keys(JSON.parse(stored))).toEqual(["v", "active", "ratio", "panes"]);
    expect(Object.keys(JSON.parse(stored).panes[0])).toEqual(["active", "tabs"]);
    expect(stored).not.toMatch(/Alpha|Beta|Gamma|Notes|Body of/);
    // Word boundaries: a random page id ("…a41adabc…") must not look like the name.
    expect(stored).not.toMatch(/thoth_(at|rt|pat)_|token|email|\bAda\b/i);
    for (const tab of JSON.parse(stored).panes[0].tabs as Record<string, string>[]) expect(Object.keys(tab).sort()).toEqual(["k", "page", "server", "workspace"]);
    expect(JSON.parse(stored).panes[0].active).toBe(1);
    // Nothing else in storage changed because of the tabs, and the session storage holds none of it.
    expect([...browser.session.keys()]).toEqual([]);
  });

  it("brings the tabs back after a reload, and their titles come from the workspace, not from storage", async () => {
    const first = await signedIn();
    await first.user.click(await row("Alpha"));
    await ctrlClick(first, "Gamma");
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Gamma"]));
    cleanup();

    // A reload: same storage, same server, the cookie signs the visitor in again.
    const second = fakeBrowser(first.server, { local: first.local });
    second.server.giveCookie();
    open(second);
    await waitFor(() => expect(tabNames()).toEqual(["Alpha", "Gamma"]));
    expect(current()).toBe("Gamma");
    expect(await screen.findByRole("heading", { level: 1, name: "Gamma" })).toBeTruthy();
  });

  it("starts with one empty tab when the stored text is unreadable or from another client", async () => {
    for (const bad of [
      "{oops",
      JSON.stringify({ v: 1, active: 0, tabs: [{ k: "page", path: "A.md" }] }),
      JSON.stringify({ v: 1, active: 0, tabs: [{ k: "ws", server: "elsewhere", workspace: "w", page: "p" }] }),
      // A desktop assistant session: the web client has no assistant.
      JSON.stringify({ v: 1, active: 0, tabs: [{ k: "run", run: "019e1a2b-3c4d-7e5f-8a6b-7c8d9e0f1a2b" }] }),
    ]) {
      const server = new FakeWebServer();
      server.workspace("Notes");
      const browser = fakeBrowser(server, { local: new Map([[TABS_KEY, bad]]) });
      await signInThroughUi(browser);
      expect(tabNames()).toEqual(["New tab"]);
      cleanup();
    }
  });

  it("shows a clear state, not a blank page, when the current tab's page no longer exists", async () => {
    const server = new FakeWebServer();
    const ws = server.workspace("Notes");
    server.servers.writeAsOther(ws, { title: "Alpha", markdown: "# Alpha\n" });
    const browser = fakeBrowser(server, { local: new Map([[TABS_KEY, JSON.stringify({ v: 1, active: 0, tabs: [{ k: "ws", server: "trial", workspace: ws.id, page: "pg_missing" }] })]]) });
    await signInThroughUi(browser);
    await waitFor(() => expect(screen.getByRole("tabpanel").textContent).toMatch(/not found|no longer|missing|gone/i));
    expect(tabs()).toHaveLength(1);
  });

  it("forgets the tabs when the visitor signs out", async () => {
    const browser = await signedIn();
    await browser.user.click(await row("Alpha"));
    await waitFor(() => expect(browser.local.get(TABS_KEY)).toContain('"k":"ws"'));
    await browser.user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("button", { name: "Sign in with Google" });
    expect(browser.local.get(TABS_KEY) ?? "").toBe("");
  });
});
