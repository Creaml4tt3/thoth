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

describe("Save diagnostics (ADR-0040)", () => {
  async function saving(log: string[], answer = true) {
    const platform = createNodePlatform({ vault: root });
    const saved: { name: string; text: string }[] = [];
    platform.saveFile = async (name, bytes) => {
      saved.push({ name, text: new TextDecoder().decode(bytes) });
      return answer;
    };
    Object.assign(platform, { diagnostics: { report: async () => undefined, collect: async () => ({ version: "0.3.0", os: "macos", arch: "aarch64", log }), enabled: async () => true, setEnabled: async (on: boolean) => on } });
    const app = await openApp(root, {}, platform);
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const section = await screen.findByRole("region", { name: "Help and feedback" });
    await app.user.click(within(section).getByRole("button", { name: "Save diagnostics…" }));
    return { section, saved };
  }

  it("save_diagnostics_writes_markdown", async () => {
    const lines = ["2026-10-30T10:00:00Z INFO thoth: started", "a line with ``` inside"];
    const { section, saved } = await saving(lines);
    await waitFor(() => expect(within(section).getByRole("status").textContent).toBe("Saved."));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe("thoth-diagnostics.md");
    const text = saved[0]!.text;
    expect(text).toMatch(/^# Thoth diagnostics\n/);
    for (const field of ["Version: 0.3.0", "OS: macos", "Arch: aarch64"]) expect(text).toContain(field);
    expect(text).toMatch(/Date: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/);
    // A fence longer than any backtick run in the lines, so no line can close it.
    expect(text).toContain(`\`\`\`\`\n${lines.join("\n")}\n\`\`\`\`\n`);
  });

  it("with no log yet, says so instead of an empty block; a cancelled save says not saved", async () => {
    const { section, saved } = await saving([], false);
    await waitFor(() => expect(within(section).getByRole("status").textContent).toBe("Not saved."));
    expect(saved[0]!.text).toContain("No log yet.");
    expect(saved[0]!.text).not.toContain("```");
  });

  it("the log switch shows the host's choice and turns it off", async () => {
    const platform = createNodePlatform({ vault: root });
    const calls: boolean[] = [];
    Object.assign(platform, {
      diagnostics: { report: async () => undefined, collect: async () => ({ version: "0.3.0", os: "macos", arch: "aarch64", log: [] }), enabled: async () => true, setEnabled: async (on: boolean) => (calls.push(on), on) },
    });
    const app = await openApp(root, {}, platform);
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const section = await screen.findByRole("region", { name: "Help and feedback" });
    const toggle = (await within(section).findByRole("switch", { name: "Keep an app log on this computer" })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await app.user.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(calls).toEqual([false]);
  });

  it("is not offered without a host log", async () => {
    const { app } = await start(() => undefined);
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const section = await screen.findByRole("region", { name: "Help and feedback" });
    expect(within(section).queryByRole("button", { name: "Save diagnostics…" })).toBeNull();
  });

  it("the dialog offers the log box, off, and adds the arch to the os in the details", async () => {
    const platform = createNodePlatform({ vault: root, servers: new FakeServers() });
    platform.servers.connect(TEAM);
    Object.assign(platform, { diagnostics: { report: async () => undefined, collect: async () => ({ version: "0.3.0", os: "macos", arch: "aarch64", log: [] }), enabled: async () => true, setEnabled: async (on: boolean) => on } });
    const app = await openApp(root, {}, platform);
    await screen.findByRole("tree", { name: "Pages in this Private Space" });
    const dialog = await openFromSettings(app);
    // In `os`, not a key of its own: an older server's strict context would refuse `arch` (ADR-0040).
    await within(dialog).findByText(/^os: (macOS|Windows|Linux) \(aarch64\)$/);
    expect(within(dialog).queryByText(/^arch:/)).toBeNull();
    expect((within(dialog).getByRole("checkbox", { name: "Include recent app log" }) as HTMLInputElement).checked).toBe(false);
  });
});
