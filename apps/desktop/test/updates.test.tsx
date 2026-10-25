// @vitest-environment jsdom
/**
 * The update notice on the desktop (ADR-0022): a small dialog in the corner when the host says a newer version is out;
 * nothing for the same or an older one; "Skip this version" remembered; "Later"; "Download" and "What's new" through the
 * host; Settings → General (the switch and "Check now"); and an entry in the notification list that is never a system
 * notification. The host is a fake that answers like `update.check`; the host's own rules are tested in Rust.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateCheck, UpdateSettings, Updates, Links } from "@thoth/platform";
import type { SystemNotification, SystemNotifier } from "@thoth/app-ui/notifications/core.ts";
import { DEFAULT_OPTIONS } from "../src/app/App.tsx";
import { NOTIFICATION_PREFS_KEY } from "../src/features/notifications/prefs.ts";
import { setLangPreference } from "../src/strings/index.ts";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";

const DOWNLOADS = "https://thoth.creaml4tt3.me/#download";
const NOTES = "https://thoth.creaml4tt3.me/changes#0.2.0";

function newer(over: Partial<Extract<UpdateCheck, { state: "available" }>["update"]> = {}): UpdateCheck {
  return { state: "available", checkedAt: 1_900_000_000, update: { version: "0.2.0", date: "2026-11-02", downloadUrl: DOWNLOADS, notesUrl: NOTES, skipped: false, ...over } };
}
const CURRENT: UpdateCheck = { state: "current", checkedAt: 1_900_000_000 };

/** Answers like the host's `update.check` and `update.settings`, and keeps the calls. */
class FakeUpdates implements Updates {
  checks: { force: boolean }[] = [];
  answer: UpdateCheck = CURRENT;
  notify = true;
  skipped: string | null = null;
  async check(options?: { force?: boolean }): Promise<UpdateCheck> {
    this.checks.push({ force: options?.force === true });
    return this.notify ? this.answer : { state: "off" };
  }
  private settingsNow(): UpdateSettings {
    return { available: true, current: "0.1.3", notify: this.notify, skipped: this.skipped, lastChecked: null };
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

  it("waits 10 seconds after the start, then asks every 24 hours while the app is open", async () => {
    expect(DEFAULT_OPTIONS.updateDelayMs).toBe(10_000);
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

describe("Settings → General", () => {
  async function openSettings(app: Harness) {
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    return screen.findByRole("switch", { name: "Tell me when a new version is out" });
  }

  it("has the switch, on by default, and turning it off tells the host", async () => {
    const app = await start();
    const toggle = (await openSettings(app)) as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
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
