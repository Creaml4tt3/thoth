// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { payload, track, type AnalyticsEvent } from "../src/analytics.ts";
import { FakeWebServer } from "./support/fake-web-server.ts";
import { cleanup, editorBox, fakeBrowser, screen, signInThroughUi, waitFor, within } from "./support/render.tsx";

afterEach(() => cleanup());

const ALLOWED: Record<string, readonly string[]> = {
  screen_view: ["screen"],
  sign_in: ["provider"],
  page_open: [],
  page_save: [],
  page_create: [],
  conflict_shown: [],
  conflict_resolved: ["choice"],
  search: [],
};

describe("track()", () => {
  it("does nothing without the site's analytics layer, and never throws", () => {
    expect(() => track({ name: "page_open" }, {})).not.toThrow();
    expect(() => track({ name: "page_open" }, { thothAnalytics: { track: () => { throw new Error("blocked"); } } })).not.toThrow();
  });

  it("sends only known keys with allowed values", () => {
    const sent: unknown[] = [];
    const sink = { thothAnalytics: { track: (name: string, params: Record<string, string>) => void sent.push([name, params]) } };
    track({ name: "screen_view", params: { screen: "/app/page" } }, sink);
    track({ name: "sign_in", params: { provider: "github" } }, sink);
    track({ name: "conflict_resolved", params: { choice: "both" } }, sink);
    // Smuggled values are dropped, whatever the caller's types said.
    track({ name: "screen_view", params: { screen: "/app/page/ws_123/0193" } } as unknown as AnalyticsEvent, sink);
    track({ name: "sign_in", params: { provider: "ada@example.org" } }, sink);
    track({ name: "search", params: { query: "secret plans" } } as unknown as AnalyticsEvent, sink);
    track({ name: "page_save", params: { title: "Roadmap", pageId: "0193" } } as unknown as AnalyticsEvent, sink);
    expect(sent).toEqual([
      ["screen_view", { screen: "/app/page" }],
      ["sign_in", { provider: "github" }],
      ["conflict_resolved", { choice: "both" }],
      ["screen_view", {}],
      ["sign_in", {}],
      ["search", {}],
      ["page_save", {}],
    ]);
  });

  it("payload() never returns a key outside the allow-list", () => {
    const events: AnalyticsEvent[] = [
      { name: "screen_view", params: { screen: "/app" } },
      { name: "sign_in", params: { provider: "google" } },
      { name: "page_open" },
      { name: "page_save" },
      { name: "page_create" },
      { name: "conflict_shown" },
      { name: "conflict_resolved", params: { choice: "mine" } },
      { name: "search" },
    ];
    for (const event of events) for (const key of Object.keys(payload(event))) expect(ALLOWED[event.name]).toContain(key);
  });
});

describe("what a whole session sends", () => {
  it("contains no page title, page or workspace id, search text, name or email", async () => {
    const server = new FakeWebServer();
    const ws = server.workspace("Ada Lovelace's workspace");
    const page = server.servers.writeAsOther(ws, { title: "Secret roadmap", markdown: "# Secret roadmap\n\nQuarterly zebra goals.\n" });
    const browser = fakeBrowser(server, { autosaveMs: 30 });
    await signInThroughUi(browser, "GitHub");

    // Open, edit, save, create, search, conflict, resolve.
    await browser.user.click(await screen.findByRole("treeitem", { name: "Secret roadmap" }));
    const box = await editorBox();
    await waitFor(() => expect(box.textContent).toContain("Quarterly"));
    box.focus();
    await browser.user.keyboard("x");
    await waitFor(() => expect(browser.events.some((e) => e.name === "page_save")).toBe(true));
    server.servers.writeAsOther(ws, { id: page.id, title: "Secret roadmap", markdown: "# Secret roadmap\n\nZebra notes changed by Grace.\n" });
    await browser.user.keyboard("y{Control>}s{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "This page changed on the server" });
    await browser.user.click(within(dialog).getByRole("button", { name: /Keep theirs/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await browser.user.click(screen.getByRole("button", { name: "New page in Ada Lovelace's workspace" }));
    await waitFor(() => expect(browser.events.some((e) => e.name === "page_create")).toBe(true));
    await browser.user.click(screen.getByRole("button", { name: "Search" }));
    await browser.user.type(within(await screen.findByRole("dialog", { name: "Search" })).getByRole("combobox"), "zebra");
    await screen.findByRole("option", { name: /Secret roadmap/ });

    const names = browser.events.map((e) => e.name);
    for (const expected of ["screen_view", "sign_in", "page_open", "page_save", "conflict_shown", "conflict_resolved", "page_create", "search"]) expect(names).toContain(expected);
    expect(browser.events.find((e) => e.name === "sign_in")!.params).toEqual({ provider: "github" });
    expect(browser.events.find((e) => e.name === "conflict_resolved")!.params).toEqual({ choice: "theirs" });
    for (const event of browser.events) for (const key of Object.keys(event.params)) expect(ALLOWED[event.name]).toContain(key);

    const everything = JSON.stringify(browser.events);
    const created = [...ws.pages.values()].map((p) => p.id);
    for (const secret of ["Secret roadmap", "roadmap", "zebra", "Quarterly", "Ada", "Lovelace", "example.org", "@", ws.id, ...created]) expect(everything).not.toContain(secret);
  });
});
