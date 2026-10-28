// @vitest-environment jsdom
/**
 * The update notice on the desktop (ADR-0022): a small dialog in the corner when the host says a newer version is out;
 * nothing for the same or an older one; "Skip this version" remembered; "Later"; "Download" and "What's new" through the
 * host; Settings → Updates (the switches and "Check now"); and an entry in the notification list that is never a system
 * notification. The host is a fake that answers like `update.check`; the host's own rules are tested in Rust.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallState, RestartAnswer, UpdateCheck, UpdateSettings, Updates, Links } from "@thoth/platform";
import type { SystemNotification, SystemNotifier } from "@thoth/app-ui/notifications/core.ts";
import { render } from "@testing-library/react";
import { App, DEFAULT_OPTIONS } from "../src/app/App.tsx";
import { NOTIFICATION_PREFS_KEY } from "../src/features/notifications/prefs.ts";
import { setLangPreference } from "../src/strings/index.ts";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";

const DOWNLOADS = "https://thothnotes.com/#download";
const NOTES = "https://thothnotes.com/changes#0.2.0";

function newer(over: Partial<Extract<UpdateCheck, { state: "available" }>["update"]> = {}): UpdateCheck {
  return { state: "available", checkedAt: 1_900_000_000, update: { version: "0.2.0", date: "2026-11-02", downloadUrl: DOWNLOADS, notesUrl: NOTES, skipped: false, ...over } };
}
const CURRENT: UpdateCheck = { state: "current", checkedAt: 1_900_000_000 };

/** Answers like the host's `update.*` commands (the notice and in-app updates), and keeps the calls. */
class FakeUpdates implements Updates {
  checks: { force: boolean }[] = [];
  answer: UpdateCheck = CURRENT;
  notify = true;
  skipped: string | null = null;
  /** In-app updates (ADR-0034): off unless a test says this copy can update itself. */
  canInstall = false;
  install_ = true;
  state: InstallState = { phase: "idle" };
  restartAnswer: RestartAnswer = { state: "restarting" };
  calls: string[] = [];
  listeners = new Set<(s: InstallState) => void>();
  emit(state: InstallState) {
    this.state = state;
    for (const l of this.listeners) l(state);
  }
  async setInstall(on: boolean) {
    this.install_ = on;
    return this.settingsNow();
  }
  async install() {
    this.calls.push("install");
    this.state = { phase: "downloading", received: 0 };
    return this.state;
  }
  async cancel() {
    this.calls.push("cancel");
    return this.state;
  }
  async status() {
    return this.state;
  }
  reopen: string | null = null;
  reopenedWith: (string | undefined)[] = [];
  async takeReopen() {
    const root = this.reopen;
    this.reopen = null;
    return root;
  }
  async restart(options?: { evenIfRunning?: boolean; reopen?: string }) {
    this.reopenedWith.push(options?.reopen);
    this.calls.push(options?.evenIfRunning ? "restart anyway" : "restart");
    return options?.evenIfRunning ? ({ state: "restarting" } as const) : this.restartAnswer;
  }
  async onProgress(listener: (s: InstallState) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  async check(options?: { force?: boolean }): Promise<UpdateCheck> {
    this.checks.push({ force: options?.force === true });
    if (!this.notify) return { state: "off" };
    // As the host does: a skipped version is answered as skipped, even by a check that started before the skip.
    const a = this.answer;
    return a.state === "available" && a.update.version === this.skipped ? { ...a, update: { ...a.update, skipped: true } } : a;
  }
  private settingsNow(): UpdateSettings {
    return { available: true, current: "0.1.3", notify: this.notify, install: this.install_, canInstall: this.canInstall, skipped: this.skipped, lastChecked: null };
  }
  async settings() {
    return this.settingsNow();
  }
  async setNotify(on: boolean) {
    this.notify = on;
    return this.settingsNow();
  }
  async skip(version: string) {
    this.skipped = version;
    return this.settingsNow();
  }
}

class FakeLinks implements Links {
  opened: string[] = [];
  async preview(): Promise<never> {
    throw new Error("no preview");
  }
  async clearPreviews() {}
  async open(url: string) {
    this.opened.push(url);
  }
}

const dirs = tempDirs();
let root: string;
let updates: FakeUpdates;
let links: FakeLinks;
let shown: SystemNotification[];
let notifier: SystemNotifier;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Notes.md": "# Notes\n" });
  updates = new FakeUpdates();
  links = new FakeLinks();
  shown = [];
  notifier = { kind: "system", show: async (n) => (shown.push(n), true) };
  window.dispatchEvent(new Event("focus"));
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  setLangPreference("system");
  await dirs.cleanup();
});

/** Short timers instead of 10 s and 24 h; a long interval unless the test wants more checks. */
async function start(options: { intervalMs?: number; withLinks?: boolean } = {}): Promise<Harness> {
  const platform = createNodePlatform({ vault: root, updates, ...(options.withLinks === false ? {} : { links }) });
  const app = await openApp(root, { notifier, updateDelayMs: 10, updateIntervalMs: options.intervalMs ?? 3_600_000 }, platform);
  await screen.findByRole("tree");
  return app;
}

const popup = () => screen.queryByRole("dialog", { name: /^Thoth .* is out$/ });
const findPopup = () => screen.findByRole("dialog", { name: "Thoth 0.2.0 is out" });
const bell = () => screen.getByRole("button", { name: /^Notifications/ });

describe("the popup", () => {
  it("tells of a newer version in a small dialog that takes no focus", async () => {
    updates.answer = newer();
    await start();
    const dialog = await findPopup();
    expect(updates.checks).toEqual([{ force: false }]);
    expect(within(dialog).getByText(/Released 2026-11-02\./)).toBeTruthy();
    for (const name of ["Download", "What's new", "Later", "Skip this version"]) expect(within(dialog).getByRole("button", { name })).toBeTruthy();
    // Not modal over typing: nothing in it has the focus, and the page behind it is not inert.
    expect(dialog.contains(document.activeElement)).toBe(false);
    expect(dialog.getAttribute("aria-modal")).not.toBe("true");
    // Said politely, since the dialog does not take the focus.
    expect(screen.getByTestId("update-live").textContent).toBe("A new version of Thoth, 0.2.0, is out.");
  });

  it("says nothing for the same version, an older one, a notice that is off, or a failed check", async () => {
    for (const answer of [CURRENT, { state: "off" }, { state: "unavailable" }, { state: "failed", checkedAt: 1 }, { state: "waiting", checkedAt: 1 }] as UpdateCheck[]) {
      updates = new FakeUpdates();
      updates.answer = answer;
      await start();
      await waitFor(() => expect(updates.checks).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 30));
      expect(popup()).toBeNull();
      expect(bell().getAttribute("aria-label")).toBe("Notifications");
      cleanup();
    }
  });

  it("asks right after the app opens, then every 24 hours while it is open", async () => {
    expect(DEFAULT_OPTIONS.updateDelayMs).toBe(2_000);
    expect(DEFAULT_OPTIONS.updateIntervalMs).toBe(24 * 60 * 60 * 1000);
    await start({ intervalMs: 40 });
    await waitFor(() => expect(updates.checks.length).toBeGreaterThanOrEqual(3));
    expect(updates.checks.every((c) => !c.force)).toBe(true);
  });

  it("does not ask at all where the host has no update notice (a platform without it)", async () => {
    const app = await openApp(root, { notifier, updateDelayMs: 5 }, createNodePlatform({ vault: root }));
    await screen.findByRole("tree");
    await new Promise((r) => setTimeout(r, 30));
    expect(popup()).toBeNull();
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByRole("switch", { name: "Tell me when a new version is out" })).toBeNull();
  });

  it("Download opens the downloads page through the host, and What's new the release notes", async () => {
    updates.answer = newer();
    const app = await start();
    await app.user.click(within(await findPopup()).getByRole("button", { name: "What's new" }));
    expect(links.opened).toEqual([NOTES]);
    // The notes are a look, not a decision: the popup stays.
    await app.user.click(within(await findPopup()).getByRole("button", { name: "Download" }));
    expect(links.opened).toEqual([NOTES, DOWNLOADS]);
    await waitFor(() => expect(popup()).toBeNull());
    expect(updates.skipped).toBeNull();
  });

  it("has no What's new when latest.json has no notes link", async () => {
    updates.answer = { state: "available", checkedAt: 1, update: { version: "0.2.0", downloadUrl: DOWNLOADS, skipped: false } };
    await start();
    const dialog = await findPopup();
    expect(within(dialog).queryByRole("button", { name: "What's new" })).toBeNull();
    expect(within(dialog).queryByText(/Released/)).toBeNull();
  });

  it("Later closes it without skipping, and it comes back at the next check", async () => {
    updates.answer = newer();
    const app = await start({ intervalMs: 200 });
    await app.user.click(within(await findPopup()).getByRole("button", { name: "Later" }));
    expect(popup()).toBeNull();
    expect(updates.skipped).toBeNull();
    await waitFor(() => expect(updates.checks.length).toBeGreaterThanOrEqual(2));
    await findPopup();
  });

  it("Esc closes it when the focus is on the page, and not while typing", async () => {
    updates.answer = newer();
    const app = await start();
    await findPopup();
    await app.user.click(screen.getByRole("treeitem", { name: "Notes" }));
    const box = await screen.findByRole("textbox", { name: /page content/i });
    box.focus();
    await app.user.keyboard("{Escape}");
    expect(popup()).not.toBeNull();
    (document.activeElement as HTMLElement).blur();
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(popup()).toBeNull());
    expect(updates.skipped).toBeNull();
  });

  it("Esc closes it from inside the dialog too", async () => {
    updates.answer = newer();
    const app = await start();
    const dialog = await findPopup();
    within(dialog).getByRole("button", { name: "Later" }).focus();
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(popup()).toBeNull());
  });

  it("Skip this version is remembered, so the next check of it says nothing, and a newer version is offered again", async () => {
    updates.answer = newer();
    const app = await start({ intervalMs: 60 });
    await app.user.click(within(await findPopup()).getByRole("button", { name: "Skip this version" }));
    expect(updates.skipped).toBe("0.2.0");
    expect(popup()).toBeNull();
    // The host now answers as it does for a skipped version.
    updates.answer = newer({ skipped: true });
    const seen = updates.checks.length;
    await waitFor(() => expect(updates.checks.length).toBeGreaterThanOrEqual(seen + 2));
    expect(popup()).toBeNull();
    updates.answer = newer({ version: "0.2.1", skipped: false });
    await screen.findByRole("dialog", { name: "Thoth 0.2.1 is out" });
  });
});

describe("the notification list", () => {
  it("gets an entry for the new version, which opens the popup again, and no system notification", async () => {
    updates.answer = newer();
    const app = await start();
    await findPopup();
    window.dispatchEvent(new Event("blur"));
    await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Notifications, 1 unread"));
    await app.user.click(bell());
    const list = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(list).getByText("Thoth 0.2.0 is out")).toBeTruthy();
    expect(shown).toEqual([]);

    // Later, then the entry brings it back.
    await app.user.keyboard("{Escape}");
    await app.user.click(within(await findPopup()).getByRole("button", { name: "Later" }));
    await app.user.click(bell());
    await app.user.click(within(screen.getByRole("dialog", { name: "Notifications" })).getByRole("button", { name: /Thoth 0\.2\.0 is out/ }));
    await findPopup();
    expect(shown).toEqual([]);
  });

  it("is switchable in Settings → Notifications: off, the popup still comes but the list has no entry", async () => {
    localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify({ system: true, kinds: { update: false } }));
    updates.answer = newer();
    const app = await start();
    await findPopup();
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const box = await screen.findByRole("checkbox", { name: "Add a new version to the list under the bell" });
    expect((box as HTMLInputElement).checked).toBe(false);
    await app.user.click(box);
    expect(JSON.parse(localStorage.getItem(NOTIFICATION_PREFS_KEY)!).kinds.update).toBe(true);
    // It does not depend on the switch for system notifications.
    expect((box as HTMLInputElement).disabled).toBe(false);
  });
});

describe("Settings → Updates", () => {
  async function openSettings(app: Harness) {
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    return screen.findByRole("switch", { name: "Tell me when a new version is out" });
  }

  it("has the switch, on by default, and turning it off tells the host", async () => {
    const app = await start();
    const toggle = (await openSettings(app)) as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(screen.getByRole("heading", { name: "Updates" })).toBeTruthy();
    expect(screen.getByText("You have Thoth 0.1.3.")).toBeTruthy();
    await app.user.click(toggle);
    await waitFor(() => expect(updates.notify).toBe(false));
    expect(toggle.checked).toBe(false);
    // Off means no check, not even "Check now".
    expect((screen.getByRole("button", { name: "Check now" }) as HTMLButtonElement).disabled).toBe(true);
    await app.user.click(toggle);
    await waitFor(() => expect(updates.notify).toBe(true));
    expect((screen.getByRole("button", { name: "Check now" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the switch as it is in the host", async () => {
    updates.notify = false;
    const app = await start();
    const toggle = (await openSettings(app)) as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(updates.checks).toHaveLength(1);
  });

  it("Check now asks at once, skipping the wait, and says what it found", async () => {
    const app = await start();
    await openSettings(app);
    await waitFor(() => expect(updates.checks).toHaveLength(1));
    await app.user.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(screen.getByTestId("update-check-status").textContent).toBe("You have the newest version."));
    expect(updates.checks.at(-1)).toEqual({ force: true });

    updates.answer = { state: "failed", checkedAt: 1 };
    await app.user.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(screen.getByTestId("update-check-status").textContent).toBe("Could not check. Try again later."));

    updates.answer = newer();
    await app.user.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(screen.getByTestId("update-check-status").textContent).toBe("Thoth 0.2.0 is out."));
    await findPopup();
  });

  it("Check now shows a version that was skipped, because the person asked", async () => {
    updates.skipped = "0.2.0";
    updates.answer = newer({ skipped: true });
    const app = await start();
    await waitFor(() => expect(updates.checks).toHaveLength(1));
    expect(popup()).toBeNull();
    await openSettings(app);
    await app.user.click(screen.getByRole("button", { name: "Check now" }));
    await findPopup();
  });
});

describe("in Thai", () => {
  it("has the popup and the setting", async () => {
    setLangPreference("th");
    updates.answer = newer();
    const app = await start();
    const dialog = await screen.findByRole("dialog", { name: "Thoth 0.2.0 ออกแล้ว" });
    for (const name of ["ดาวน์โหลด", "มีอะไรใหม่", "ไว้ทีหลัง", "ข้ามเวอร์ชันนี้"]) expect(within(dialog).getByRole("button", { name })).toBeTruthy();
    await app.user.click(screen.getByRole("button", { name: "การตั้งค่า" }));
    expect(await screen.findByRole("switch", { name: "แจ้งฉันเมื่อมีเวอร์ชันใหม่" })).toBeTruthy();
  });
});

describe("in-app updates (ADR-0034)", () => {
  const inApp = (over: Partial<Extract<UpdateCheck, { state: "available" }>["update"]> = {}) => newer({ inApp: true, ...over });
  const live = () => screen.getByTestId("update-live").textContent;

  it("Update takes the place of Download, downloads only when clicked, and shows progress with Cancel", async () => {
    updates.canInstall = true;
    updates.answer = inApp();
    const app = await start();
    const dialog = await findPopup();
    expect(within(dialog).queryByRole("button", { name: "Download" })).toBeNull();
    expect(within(dialog).getByText(/checks that Thoth signed it/)).toBeTruthy();
    expect(updates.calls).toEqual([]);
    await app.user.click(within(dialog).getByRole("button", { name: "Update" }));
    expect(updates.calls).toEqual(["install"]);
    const updating = await screen.findByRole("dialog", { name: "Updating to Thoth 0.2.0" });
    updates.emit({ phase: "downloading", received: 3_670_016, total: 14_680_064 });
    await waitFor(() => expect(within(updating).getByText("25% (3.5 MB of 14.0 MB)")).toBeTruthy());
    const bar = within(updating).getByRole("progressbar", { name: "Download progress" }) as HTMLProgressElement;
    expect([bar.value, bar.max]).toEqual([3_670_016, 14_680_064]);
    // Milestones only: a quarter is said, the chunks between are not.
    expect(live()).toBe("Downloading Thoth 0.2.0: 25%");
    updates.emit({ phase: "downloading", received: 4_000_000, total: 14_680_064 });
    await waitFor(() => expect(within(updating).getByText(/^27%/)).toBeTruthy());
    expect(live()).toBe("Downloading Thoth 0.2.0: 25%");
    await app.user.click(within(updating).getByRole("button", { name: "Cancel" }));
    expect(updates.calls).toEqual(["install", "cancel"]);
    updates.emit({ phase: "failed", reason: "cancelled" });
    const failed = await screen.findByRole("dialog", { name: "Thoth 0.2.0 was not installed" });
    expect(within(failed).getByText("The update was cancelled. Nothing was installed.")).toBeTruthy();
    await app.user.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(updates.calls).toEqual(["install", "cancel", "install"]);
  });

  it("asks before restarting: Restart now or Later, and Restart now writes the edits first", async () => {
    updates.canInstall = true;
    updates.answer = inApp();
    const app = await start();
    await app.user.click(within(await findPopup()).getByRole("button", { name: "Update" }));
    updates.emit({ phase: "ready", version: "0.2.0", installed: true });
    const ready = await screen.findByRole("dialog", { name: "Thoth 0.2.0 is ready" });
    expect(live()).toBe("Thoth 0.2.0 is ready. Restart to use it.");
    expect(within(ready).getByText(/Restart Thoth to use it/)).toBeTruthy();
    // Later keeps it for later; the list's entry brings it back in the same state.
    await app.user.click(within(ready).getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("dialog", { name: "Thoth 0.2.0 is ready" })).toBeNull();
    expect(updates.calls).toEqual(["install"]);
    await app.user.click(bell());
    await app.user.click(within(screen.getByRole("dialog", { name: "Notifications" })).getByRole("button", { name: /Thoth 0\.2\.0 is out/ }));
    const again = await screen.findByRole("dialog", { name: "Thoth 0.2.0 is ready" });
    await app.user.click(within(again).getByRole("button", { name: "Restart now" }));
    await waitFor(() => expect(updates.calls).toEqual(["install", "restart"]));
    await screen.findByText("Restarting…", { selector: ".update-install p" });
    expect(updates.reopenedWith).toEqual([root]);
  });

  it("after the restart, the main window opens the Private Space that was open", async () => {
    updates.reopen = root;
    const platform = createNodePlatform({ vault: root, updates, links });
    // No click on the picker: the app opens it by itself.
    render(<App platform={platform} options={{ ...DEFAULT_OPTIONS, notifier, updateDelayMs: 3_600_000 }} />);
    await screen.findByRole("tree");
    expect(updates.reopen).toBeNull();
  });

  it("says when an assistant is working, and lets the person restart anyway", async () => {
    updates.canInstall = true;
    updates.answer = inApp();
    updates.restartAnswer = { state: "busy", runs: 1 };
    const app = await start();
    await app.user.click(within(await findPopup()).getByRole("button", { name: "Update" }));
    updates.emit({ phase: "ready", version: "0.2.0", installed: false });
    const ready = await screen.findByRole("dialog", { name: "Thoth 0.2.0 is ready" });
    expect(within(ready).getByText(/installs when Thoth restarts/)).toBeTruthy();
    await app.user.click(within(ready).getByRole("button", { name: "Restart now" }));
    await waitFor(() => expect(within(ready).getByText("An assistant is still working. Restarting stops it.")).toBeTruthy());
    await app.user.click(within(ready).getByRole("button", { name: "Restart anyway" }));
    expect(updates.calls).toEqual(["install", "restart", "restart anyway"]);
  });

  it("each failure says what happened and keeps the Download button", async () => {
    updates.canInstall = true;
    updates.answer = inApp();
    const app = await start();
    await app.user.click(within(await findPopup()).getByRole("button", { name: "Update" }));
    const said: Record<string, RegExp> = { offline: /Check your connection/, verify: /could not be verified as signed by Thoth/, disk: /not enough space/, failed: /could not be installed/ };
    for (const reason of ["offline", "verify", "disk", "failed"] as const) {
      updates.emit({ phase: "failed", reason });
      const failed = await screen.findByRole("dialog", { name: "Thoth 0.2.0 was not installed" });
      await waitFor(() => expect(within(failed).getByText(said[reason]!)).toBeTruthy());
      expect(within(failed).getByRole("button", { name: "Download" })).toBeTruthy();
      // A bad signature is not worth trying again.
      expect(within(failed).queryByRole("button", { name: "Try again" }) === null).toBe(reason === "verify");
      updates.emit({ phase: "downloading", received: 0 });
    }
    updates.emit({ phase: "failed", reason: "verify" });
    await app.user.click(within(await screen.findByRole("dialog", { name: "Thoth 0.2.0 was not installed" })).getByRole("button", { name: "Download" }));
    expect(links.opened).toEqual([DOWNLOADS]);
  });

  it("with the switch off, or where the host cannot update, the popup keeps Download", async () => {
    updates.answer = newer({ inApp: false });
    const app = await start();
    const dialog = await findPopup();
    expect(within(dialog).getByRole("button", { name: "Download" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Update" })).toBeNull();
    await app.user.click(within(dialog).getByRole("button", { name: "Download" }));
    expect(links.opened).toEqual([DOWNLOADS]);
    expect(updates.calls).toEqual([]);
  });

  it("Settings shows the switch only where this copy can update itself, and it tells the host", async () => {
    const app = await start();
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("switch", { name: "Tell me when a new version is out" });
    expect(screen.queryByRole("switch", { name: "Download and install updates in the app" })).toBeNull();
    cleanup();

    updates.canInstall = true;
    const again = await start();
    await again.user.click(screen.getByRole("button", { name: "Settings" }));
    const toggle = (await screen.findByRole("switch", { name: "Download and install updates in the app" })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await again.user.click(toggle);
    await waitFor(() => expect(updates.install_).toBe(false));
    expect(toggle.checked).toBe(false);
  });

  it("Settings follows the update too", async () => {
    updates.canInstall = true;
    updates.answer = inApp();
    const app = await start();
    await findPopup();
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const general = await screen.findByRole("region", { name: "Updates" });
    await app.user.click(within(general).getByRole("button", { name: "Check now" }));
    await app.user.click(await within(general).findByRole("button", { name: "Update" }));
    updates.emit({ phase: "downloading", received: 1_048_576, total: 2_097_152 });
    await waitFor(() => expect(within(general).getByRole("progressbar", { name: "Download progress" })).toBeTruthy());
    updates.emit({ phase: "ready", version: "0.2.0", installed: true });
    await app.user.click(await within(general).findByRole("button", { name: "Restart now" }));
    await waitFor(() => expect(updates.calls).toEqual(["install", "restart"]));
  });

  it("in Thai", async () => {
    setLangPreference("th");
    updates.canInstall = true;
    updates.answer = inApp();
    const app = await start();
    const dialog = await screen.findByRole("dialog", { name: "Thoth 0.2.0 ออกแล้ว" });
    await app.user.click(within(dialog).getByRole("button", { name: "อัปเดต" }));
    updates.emit({ phase: "ready", version: "0.2.0", installed: true });
    const ready = await screen.findByRole("dialog", { name: "Thoth 0.2.0 พร้อมแล้ว" });
    expect(within(ready).getByRole("button", { name: "รีสตาร์ตเดี๋ยวนี้" })).toBeTruthy();
    await app.user.click(screen.getByRole("button", { name: "การตั้งค่า" }));
    expect(await screen.findByRole("switch", { name: "ดาวน์โหลดและติดตั้งอัปเดตในแอป" })).toBeTruthy();
  });
});
