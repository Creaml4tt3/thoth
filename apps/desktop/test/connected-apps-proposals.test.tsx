// @vitest-environment jsdom
/**
 * Proposed changes from connected apps (ADR-0048) in the desktop app, against a fake host: the bell's entry, the
 * review (app, when, page, diff), Apply with compare-and-swap, Decline, "Apply all from <app>", a page that changed
 * meanwhile (conflicted: nothing written, the diff against the page as it is now, "Apply anyway"), a new page that
 * never replaces a file, the question before an app's first proposal and the per-app switch in Settings.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { axeViolations } from "../../../tests/helpers/axe.ts";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { FakeConnectedApps } from "./support/connected-apps.ts";

const PLAN = "# Plan\n\nThe budget is small.\n";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

const dirs = tempDirs();
let root: string;
let apps: FakeConnectedApps;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  apps = new FakeConnectedApps();
  apps.state = { ...apps.state, enabled: true, listening: true, apps: [{ name: "Claude", allowed: true, decidedAt: "2026-11-02T08:00:00Z", propose: true }] };
  await writeFile(join(root, "Plan.md"), PLAN);
});

afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

async function open(): Promise<{ app: Harness; shown: string }> {
  const app = await openApp(root, {}, createNodePlatform({ vault: root, connectedApps: apps }));
  await screen.findByRole("tree");
  apps.state.spaces = [app.platform.connections[0]!.root];
  return { app, shown: app.platform.connections[0]!.root };
}

let next = 0;
const id = () => `prop_${(next++).toString(16).padStart(32, "0")}`;

function proposeEdit(shown: string, after: string, extra: { app?: string; before?: string } = {}) {
  const before = extra.before ?? PLAN;
  const made = id();
  apps.propose({ id: made, app: extra.app ?? "Claude", kind: "edit", root: shown, space: "Notes", path: "Plan.md", baseHash: hash(before), before, after });
  return made;
}

function proposeCreate(shown: string, path: string, after: string) {
  const made = id();
  apps.propose({ id: made, app: "Claude", kind: "create", root: shown, space: "Notes", path, baseHash: null, before: null, after });
  return made;
}

const bell = () => screen.getByRole("button", { name: /^Notifications/ });

async function review(app: Harness) {
  await waitFor(() => expect(bell().getAttribute("aria-label")).toMatch(/unread/));
  await app.user.click(bell());
  await app.user.click(await screen.findByRole("button", { name: /proposed changes? to review/ }));
  return within(await screen.findByRole("dialog", { name: "Proposed changes" }));
}

const item = (dialog: ReturnType<typeof within>, path: string) => within(dialog.getByRole("listitem", { name: `Proposed change to ${path}` }));
const onDisk = (path: string) => readFile(join(root, path), "utf8");

describe("Proposed changes, under the bell", () => {
  it("are counted on the bell and reviewed with the app, the time, the page and a diff; Apply writes the page", async () => {
    const { app, shown } = await open();
    const made = proposeEdit(shown, "# Plan\n\nThe budget is large.\n");
    // Another Private Space's proposal is not this window's to review.
    apps.propose({ id: id(), app: "Claude", kind: "create", root: "/elsewhere", space: "Other", path: "X.md", baseHash: null, before: null, after: "x" });
    await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 1 unread"));
    expect(screen.getByTestId("notification-badge").textContent).toBe("1");

    const dialog = await review(app);
    expect(dialog.getByRole("region", { name: "From “Claude”" })).toBeTruthy();
    const plan = await waitFor(() => item(dialog, "Plan.md"));
    expect(plan.getByText("Change")).toBeTruthy();
    expect(plan.getByText(/^Claude ·/)).toBeTruthy();
    expect(plan.getByRole("group", { name: /Plan\.md/ }).textContent).toContain("The budget is large.");
    expect(dialog.queryByRole("listitem", { name: "Proposed change to X.md" })).toBeNull();
    expect(await axeViolations(screen.getByRole("dialog", { name: "Proposed changes" }))).toEqual([]);
    expect(await onDisk("Plan.md")).toBe(PLAN);

    await app.user.click(plan.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(apps.calls).toContainEqual(["settle", made, "applied"]));
    expect(await onDisk("Plan.md")).toBe("# Plan\n\nThe budget is large.\n");
    expect(dialog.getByRole("status").textContent).toBe("Applied to Plan.md.");
    expect(dialog.getByText("No proposed changes wait for review.")).toBeTruthy();
  });

  it("Decline writes nothing", async () => {
    const { app, shown } = await open();
    const made = proposeEdit(shown, "# Plan\n\nGone.\n");
    const dialog = await review(app);
    await app.user.click((await waitFor(() => item(dialog, "Plan.md"))).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(apps.calls).toContainEqual(["settle", made, "declined"]));
    expect(await onDisk("Plan.md")).toBe(PLAN);
    await waitFor(() => expect(dialog.queryByRole("listitem")).toBeNull());
  });

  it("Apply all from an app applies each one, checked on its own", async () => {
    const { app, shown } = await open();
    const edit = proposeEdit(shown, `${PLAN}\n- one more\n`);
    const created = proposeCreate(shown, "Notes/Summary.md", "# Summary\n");
    const dialog = await review(app);
    await waitFor(() => expect(dialog.getAllByRole("listitem")).toHaveLength(2));
    expect(await axeViolations(screen.getByRole("dialog", { name: "Proposed changes" }))).toEqual([]);
    await app.user.click(dialog.getByRole("button", { name: "Apply all from Claude" }));
    await waitFor(() => expect(apps.calls.filter((c) => c[0] === "settle")).toEqual([["settle", edit, "applied"], ["settle", created, "applied"]]));
    expect(await onDisk("Plan.md")).toBe(`${PLAN}\n- one more\n`);
    expect(await onDisk("Notes/Summary.md")).toBe("# Summary\n");
  });

  it("a page that changed since is not written: it is conflicted, shown against the page as it is now, and applied only on purpose", async () => {
    const { app, shown } = await open();
    const made = proposeEdit(shown, "# Plan\n\nThe budget is large.\n");
    const dialog = await review(app);
    const plan = await waitFor(() => item(dialog, "Plan.md"));
    // Someone edits the page before the user applies the proposal.
    const edited = "# Plan\n\nThe budget is medium, says Bo.\n";
    await writeFile(join(root, "Plan.md"), edited);
    await app.user.click(plan.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(apps.calls).toContainEqual(["settle", made, "conflicted"]));
    expect(await onDisk("Plan.md")).toBe(edited);
    const conflicted = item(dialog, "Plan.md");
    expect(conflicted.getByRole("note").textContent).toMatch(/changed after the app proposed this/);
    // The diff is now against Bo's version.
    await waitFor(() => expect(conflicted.getByRole("group", { name: /Plan\.md/ }).textContent).toContain("says Bo"));
    expect(await axeViolations(screen.getByRole("dialog", { name: "Proposed changes" }))).toEqual([]);

    await app.user.click(conflicted.getByRole("button", { name: "Apply anyway" }));
    await waitFor(() => expect(apps.calls).toContainEqual(["settle", made, "applied"]));
    expect(await onDisk("Plan.md")).toBe("# Plan\n\nThe budget is large.\n");
  });

  it("a new page never replaces a file that is there now: it can only be declined", async () => {
    const { app, shown } = await open();
    const made = proposeCreate(shown, "Ideas.md", "# Ideas from Claude\n");
    await writeFile(join(root, "Ideas.md"), "# My ideas\n");
    const dialog = await review(app);
    await app.user.click((await waitFor(() => item(dialog, "Ideas.md"))).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(apps.calls).toContainEqual(["settle", made, "conflicted"]));
    expect(await onDisk("Ideas.md")).toBe("# My ideas\n");
    const ideas = item(dialog, "Ideas.md");
    expect(ideas.getByRole("note").textContent).toMatch(/cannot be made/);
    expect(ideas.queryByRole("button", { name: /Apply/ })).toBeNull();
    await app.user.click(ideas.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(apps.calls).toContainEqual(["settle", made, "declined"]));
  });
});

describe("Letting an app propose", () => {
  it("is asked once, when an allowed app first proposes; focus starts on Don’t allow", async () => {
    await open();
    apps.wantsToPropose("Claude");
    const dialog = await screen.findByRole("dialog", { name: "Let “Claude” propose changes?" });
    expect(within(dialog).getByText(/Nothing is written until you apply it/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Don’t allow"));
    expect(await axeViolations(dialog)).toEqual([]);
    within(dialog).getByRole("button", { name: "Allow proposals" }).click();
    await waitFor(() => expect(apps.calls).toContainEqual(["mayPropose", "Claude", true]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Settings → Connected apps has the per-app switch, off until turned on", async () => {
    apps.state.apps = [{ name: "Claude", allowed: true, decidedAt: "2026-11-02T08:00:00Z", propose: null }];
    const { app } = await open();
    await app.user.click(screen.getAllByRole("button", { name: "Settings" })[0]!);
    const section = within(await screen.findByTestId("connected-apps-settings"));
    const claude = within(section.getByRole("listitem", { name: "Claude" }));
    const toggle = claude.getByRole("switch", { name: "May propose changes" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await app.user.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(apps.calls).toContainEqual(["mayPropose", "Claude", true]);
    expect(section.getByText(/nothing is written until you apply it/)).toBeTruthy();
  });
});
