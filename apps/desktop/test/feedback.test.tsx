// @vitest-environment jsdom
// Send feedback in the desktop app (ADR-0033): Settings → Help and feedback, and the palette command.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppOptions } from "../src/app/context.ts";
import { FakeServers, type FakeServerConfig } from "../../../tests/helpers/fake-servers.ts";
import { ALPHA, seed } from "./support/fixtures.ts";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";

const dirs = tempDirs();
let root: string;
beforeEach(async () => {
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA });
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

const TEAM: FakeServerConfig = { url: "https://team.example.com", name: "Team server", capabilities: ["search", "feedback"], account: { id: "usr_me", displayName: "Ada" } };
const OLD: FakeServerConfig = { url: "https://old.example.com", name: "Old server", capabilities: ["search"] };
const DEMO: FakeServerConfig = { url: "https://demo.example.com", name: "Demo", capabilities: ["feedback"] };

async function start(setup: (servers: FakeServers) => void, options: Partial<AppOptions> = {}) {
  const servers = new FakeServers();
  setup(servers);
  const app = await openApp(root, options, createNodePlatform({ vault: root, servers }));
  await screen.findByRole("tree", { name: "Pages in this Private Space" });
  return { app, servers };
}

async function openFromSettings(app: Harness) {
  await app.user.click(screen.getByRole("button", { name: "Settings" }));
  const nav = await screen.findByRole("navigation", { name: /settings/i });
  await waitFor(() => expect(within(nav).getByRole("link", { name: "Help and feedback" })).toBeTruthy());
  const section = screen.getByRole("region", { name: "Help and feedback" });
  await app.user.click(within(section).getByRole("button", { name: "Send feedback…" }));
  return screen.findByRole("dialog", { name: "Send feedback" });
}

describe("Send feedback (ADR-0033)", () => {
  it("goes to the first signed-in server that takes feedback, with the details the dialog shows", async () => {
    const { app, servers } = await start((s) => {
      s.connect(OLD);
      s.connect(TEAM);
    });
    const dialog = await openFromSettings(app);
    await within(dialog).findByText("Sent to Team server.");
    await app.user.click(within(dialog).getByRole("radio", { name: "A question" }));
    await app.user.type(within(dialog).getByRole("textbox", { name: "Your message" }), "How do I export?");
    expect(within(dialog).getByText("client: desktop")).toBeTruthy();
    await app.user.click(within(dialog).getByRole("button", { name: "Send" }));
    await within(dialog).findByText("Thank you. Your message was sent.");
    expect(servers.feedback).toHaveLength(1);
    const [sent] = servers.feedback;
    expect(sent!.server).toBe(servers.calls.find((c) => c.path === "/api/v1/feedback")!.server);
    expect(sent!.body).toMatchObject({ kind: "question", message: "How do I export?", context: { client: "desktop", language: "en" } });
    // Nothing about the Private Space rides along.
    expect(JSON.stringify(sent!.body)).not.toMatch(/Alpha/);
  });

  it("prefers the demo server once it is added, even signed out, from the palette too", async () => {
    const { app, servers } = await start(
      (s) => {
        s.connect(TEAM);
        s.connect(DEMO, { signedIn: false });
      },
      { starterServer: { url: DEMO.url, name: "Demo", caution: "A demo." } },
    );
    await app.user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "Search" });
    await app.user.keyboard("> send feedback");
    await app.user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Send feedback" });
    await within(dialog).findByText("Sent to Demo.");
    await app.user.type(within(dialog).getByRole("textbox", { name: "Your message" }), "Hello");
    await app.user.click(within(dialog).getByRole("button", { name: "Send" }));
    await within(dialog).findByText("Thank you. Your message was sent.");
    expect(servers.feedback.map((f) => servers.info(f.server)?.url)).toEqual([DEMO.url]);
  });

  it("with no server that takes feedback, says so and shows the address to copy; no server is contacted for it", async () => {
    const { app, servers } = await start((s) => s.connect(OLD));
    const dialog = await openFromSettings(app);
    await within(dialog).findByText(/No server here can take feedback right now/);
    expect(within(dialog).queryByRole("button", { name: "Send" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Copy address" })).toBeTruthy();
    expect(servers.calls.some((c) => c.path === "/api/v1/feedback")).toBe(false);
  });
});
