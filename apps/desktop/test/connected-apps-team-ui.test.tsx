// @vitest-environment jsdom
/**
 * Team memory in the desktop app (ADR-0052 rule 8), against a fake host and a fake workspace server: Settings shares a
 * workspace's Team memory with apps (and an owner turns its review off), an agent's memory reaches the server from the
 * window, and the bell's entry opens the review, where Apply settles it on the server.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeServers } from "../../../tests/helpers/fake-servers.ts";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { FakeConnectedApps } from "./support/connected-apps.ts";

const dirs = tempDirs();
let root: string;
let apps: FakeConnectedApps;
let servers: FakeServers;
let server: string;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await writeFile(join(root, "Plan.md"), "# Plan\n");
  apps = new FakeConnectedApps();
  apps.state = { ...apps.state, enabled: true, listening: true, apps: [{ name: "Claude Code", allowed: true, decidedAt: "2026-11-02T08:00:00Z", propose: null }] };
  servers = new FakeServers();
  server = servers.connect({ url: "https://team.example", name: "Team", capabilities: ["page-kind", "team-memory"] });
});

afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

async function open(): Promise<Harness> {
  const app = await openApp(root, {}, createNodePlatform({ vault: root, servers, connectedApps: apps }));
  await screen.findByRole("tree");
  return app;
}

const bell = () => screen.getByRole("button", { name: /^Notifications/ });

describe("Team memory (ADR-0052 rule 8)", () => {
  it("shares a workspace's Team memory with apps from Settings; its owner turns review off", async () => {
    const ws = servers.addWorkspace(server, { name: "Studio", role: "owner" });
    servers.addWorkspace(server, { name: "Readers", role: "viewer" });
    const app = await open();
    await app.user.click(screen.getAllByRole("button", { name: "Settings" })[0]!);
    const section = within(await screen.findByTestId("connected-apps-settings"));
    const studio = within(await section.findByRole("listitem", { name: "Studio" }));
    await app.user.click(studio.getByRole("checkbox", { name: /Studio/ }));
    await waitFor(() => expect(apps.calls).toContainEqual(["configure", { workspaces: [{ server, workspace: ws.id, name: "Studio" }] }]));
    const review = await studio.findByRole("switch", { name: "Agents' memories need review" });
    expect((review as HTMLInputElement).checked).toBe(true);
    await app.user.click(review);
    await waitFor(() => expect(ws.memoryReview).toBe(false));
    // A viewer's workspace is listed (they may recall), without the switch.
    expect(within(section.getByRole("listitem", { name: "Readers" })).queryByRole("switch")).toBeNull();
  });

  it("sends an agent's memory to the server, then the bell opens its review and Apply settles it", async () => {
    const ws = servers.addWorkspace(server, { name: "Studio", role: "editor" });
    const app = await open();
    apps.request({ id: "r1", owner: "main", root: `workspace:${server}/${ws.id}`, space: "Studio", tool: "team_remember", args: { server, workspace: ws.id, op: "remember", text: "Standups are at ten.", kind: "work", certainty: "inferred", app: "Claude Code" } });
    await waitFor(() => expect(apps.answers.find((a) => a.id === "r1")?.answer).toEqual({ result: { status: "pending", proposal: "mem_1", title: "Standups are at ten." } }));

    await waitFor(() => expect(bell().getAttribute("aria-label")).toMatch(/unread/));
    await app.user.click(bell());
    await app.user.click(await screen.findByRole("button", { name: /1 team memory to review/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "Team memories" }));
    const item = within(await dialog.findByRole("listitem", { name: "Standups are at ten." }));
    expect(item.getByText(/Studio · Claude Code for Me/)).toBeTruthy();
    await app.user.click(item.getByRole("button", { name: "Apply" }));
    expect(await dialog.findByText("Saved “Standups are at ten.” in Team memory.")).toBeTruthy();
    expect(ws.memoryProposals?.[0]?.["status"]).toBe("applied");
  });
});
