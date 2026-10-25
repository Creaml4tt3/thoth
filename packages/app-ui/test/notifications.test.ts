import { describe, expect, it, vi } from "vitest";
import { en, th } from "../src/strings/index.ts";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  MAX_NOTIFICATIONS,
  NOTIFICATION_KINDS,
  REPEAT_MS,
  createNotificationCenter,
  describeNotification,
  notificationTarget,
  type NotificationCenterOptions,
  type NotificationEvent,
  type NotificationKind,
  type NotificationSettings,
  type SystemNotification,
} from "../src/notifications/core.ts";

/** One event of every kind, as the desktop and web sources produce them. */
const EVENTS = {
  agentReview: { kind: "agentReview", runId: "r1", agent: "Claude Code", pages: ["Plan", "Ideas"] },
  agentFinished: { kind: "agentFinished", runId: "r2", agent: "Claude Code", pages: ["Plan"] },
  agentFailed: { kind: "agentFailed", runId: "r3", agent: "Codex", pages: ["Plan"], reason: "notSignedIn" },
  agentLimit: { kind: "agentLimit", runId: "r4", agent: "Claude Code", pages: ["Plan"], limit: "budget", review: true },
  transferDone: { kind: "transferDone", transferId: "t1", mode: "copy", pages: ["Plan", "Ideas"], where: "Studio", open: { kind: "workspacePage", server: "s", workspace: "w", page: "p" } },
  transferFailed: { kind: "transferFailed", transferId: "t2", mode: "move", pages: ["Plan"], where: "Studio", open: { kind: "page", path: "Notes/Plan.md" } },
  importDone: { kind: "importDone", jobId: "j1", folder: "Imported/Notion", pages: 12 },
  importFailed: { kind: "importFailed", jobId: "j2", folder: "Imported/Obsidian", pages: 3 },
  saveConflict: { kind: "saveConflict", page: "Alpha", open: { kind: "page", path: "Alpha.md" } },
  update: { kind: "update", version: "0.2.0" },
} satisfies { [K in NotificationKind]: NotificationEvent & { kind: K } };

function center(options: Partial<NotificationCenterOptions> = {}) {
  let now = 1_000_000;
  const shown: SystemNotification[] = [];
  const notifier = { kind: "system" as const, show: vi.fn(async (n: SystemNotification) => (shown.push(n), true)) };
  const c = createNotificationCenter({ strings: () => en.notifications, notifier, now: () => now, background: () => true, ...options });
  return { c, shown, notifier, tick: (ms: number) => (now += ms) };
}

describe("notification center: entries", () => {
  it("turns every kind of event into an unread entry, newest first, with a title and a line about it", () => {
    const { c } = center();
    for (const kind of NOTIFICATION_KINDS) c.push(EVENTS[kind]);
    const { entries, unread } = c.getState();
    expect(unread).toBe(NOTIFICATION_KINDS.length);
    expect(entries.map((e) => e.event.kind)).toEqual([...NOTIFICATION_KINDS].reverse());
    const text = Object.fromEntries(entries.map((e) => [e.event.kind, describeNotification(e.event, en.notifications)]));
    expect(text).toEqual({
      agentReview: { title: "Changes ready for review", body: "Claude Code · Plan and 1 more page" },
      agentFinished: { title: "The agent finished without changing anything", body: "Claude Code · Plan" },
      agentFailed: { title: "The run failed: Codex is not signed in", body: "Codex · Plan" },
      agentLimit: { title: "The run stopped at its spending limit", body: "Claude Code · Plan · its work so far can be reviewed" },
      transferDone: { title: "Copied to Studio", body: "Plan and 1 more page" },
      transferFailed: { title: "The move to Studio did not finish", body: "Plan" },
      importDone: { title: "Import complete", body: "12 pages in Imported/Notion" },
      importFailed: { title: "Import finished with errors", body: "3 pages in Imported/Obsidian" },
      saveConflict: { title: "Alpha changed elsewhere while you were editing it", body: "Choose which version to keep." },
      update: { title: "Thoth 0.2.0 is out", body: "Open to download it, read what is new, or skip it." },
    });
  });

  it("names the Private Space when a transfer comes back from a workspace", () => {
    expect(describeNotification({ ...EVENTS.transferDone, where: null }, en.notifications).title).toBe("Copied to the Private Space");
  });

  it("has Thai text for every kind", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const thai = describeNotification(EVENTS[kind], th.notifications);
      const english = describeNotification(EVENTS[kind], en.notifications);
      expect(thai.title).not.toBe(english.title);
      expect(thai.title.length).toBeGreaterThan(0);
    }
  });

  it("tracks unread: one entry, all, and clearing", () => {
    const { c } = center();
    const first = c.push(EVENTS.importDone);
    c.push(EVENTS.saveConflict);
    expect(c.getState().unread).toBe(2);
    c.markRead(first.id);
    expect(c.getState().unread).toBe(1);
    expect(c.getState().entries.find((e) => e.id === first.id)!.read).toBe(true);
    c.markAllRead();
    expect(c.getState().unread).toBe(0);
    c.clear();
    expect(c.getState()).toMatchObject({ entries: [], unread: 0 });
  });

  it("tells subscribers about every change", () => {
    const { c } = center();
    const listener = vi.fn();
    const stop = c.subscribe(listener);
    c.push(EVENTS.importDone);
    c.markAllRead();
    c.clear();
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
    c.push(EVENTS.importDone);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("merges a repeat of the same thing into one entry: quietly when it comes soon, as new when it comes later", () => {
    const { c, notifier, tick } = center();
    const first = c.push(EVENTS.saveConflict);
    c.markRead(first.id);
    tick(1000);
    const again = c.push({ ...EVENTS.saveConflict });
    expect(again.id).toBe(first.id);
    expect(c.getState().entries).toHaveLength(1);
    // Soon after: no second announcement or system notification, and it stays read.
    expect(c.getState().unread).toBe(0);
    expect(notifier.show).toHaveBeenCalledTimes(1);
    expect(c.getState().entries[0]!.repeats).toBe(2);

    // The same page in another place is another thing.
    c.push({ ...EVENTS.saveConflict, open: { kind: "page", path: "Other/Alpha.md" } });
    expect(c.getState().entries).toHaveLength(2);

    // Later: the entry comes back to the top, unread, and says so again.
    tick(REPEAT_MS + 1);
    c.push({ ...EVENTS.saveConflict });
    expect(c.getState().entries).toHaveLength(2);
    expect(c.getState().entries[0]!.id).toBe(first.id);
    expect(c.getState().entries[0]!.read).toBe(false);
    expect(notifier.show).toHaveBeenCalledTimes(3);
  });

  it("points at the entry last added, not at a quiet repeat", () => {
    const { c, tick } = center();
    const first = c.push(EVENTS.agentReview);
    expect(c.getState().latest).toEqual({ id: first.id, seq: 1 });
    tick(10);
    c.push(EVENTS.agentReview);
    expect(c.getState().latest).toEqual({ id: first.id, seq: 1 });
    const second = c.push(EVENTS.importDone);
    expect(c.getState().latest).toEqual({ id: second.id, seq: 2 });
    c.clear();
    expect(c.getState().latest).toEqual({ id: second.id, seq: 2 });
  });

  it("keeps a run's later outcome as its own entry (review, then finished are two things)", () => {
    const { c } = center();
    c.push(EVENTS.agentReview);
    c.push({ ...EVENTS.agentFinished, runId: "r1" });
    expect(c.getState().entries).toHaveLength(2);
  });

  it("keeps at most the newest entries", () => {
    const { c } = center();
    for (let i = 0; i < MAX_NOTIFICATIONS + 5; i++) c.push({ ...EVENTS.importDone, jobId: `j${i}` });
    const { entries, unread } = c.getState();
    expect(entries).toHaveLength(MAX_NOTIFICATIONS);
    expect(unread).toBe(MAX_NOTIFICATIONS);
    expect((entries[0]!.event as { jobId: string }).jobId).toBe(`j${MAX_NOTIFICATIONS + 4}`);
    expect((entries.at(-1)!.event as { jobId: string }).jobId).toBe("j5");
  });

  it("announces new entries politely, except those another part of the app announces (agent runs: the mascot)", () => {
    const { c } = center({ announcedElsewhere: (e) => e.kind.startsWith("agent") });
    c.push(EVENTS.importDone);
    expect(c.getState().announcement).toMatchObject({ text: "Import complete. 12 pages in Imported/Notion" });
    const seq = c.getState().announcement!.seq;
    c.push(EVENTS.agentReview);
    expect(c.getState().announcement!.seq).toBe(seq);
    c.push(EVENTS.saveConflict);
    expect(c.getState().announcement).toMatchObject({ text: "Alpha changed elsewhere while you were editing it. Choose which version to keep.", seq: seq + 1 });
  });
});

describe("notification center: system notifications", () => {
  it("shows one only while the window is in the background", async () => {
    let background = false;
    const { c, shown } = center({ background: () => background });
    c.push(EVENTS.importDone);
    expect(shown).toEqual([]);
    background = true;
    c.push(EVENTS.saveConflict);
    await vi.waitFor(() => expect(shown).toEqual([{ title: "Alpha changed elsewhere while you were editing it", body: "Choose which version to keep." }]));
    // The in-app list has both.
    expect(c.getState().entries).toHaveLength(2);
  });

  it("follows the switches: off for all, and off per kind", async () => {
    let settings: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, kinds: { ...DEFAULT_NOTIFICATION_SETTINGS.kinds, importDone: false } };
    const { c, notifier } = center({ settings: () => settings });
    c.push(EVENTS.importDone);
    c.push(EVENTS.transferDone);
    expect(notifier.show).toHaveBeenCalledTimes(1);
    expect(notifier.show.mock.calls[0]![0].title).toBe("Copied to Studio");
    settings = { ...settings, system: false };
    c.push(EVENTS.saveConflict);
    expect(notifier.show).toHaveBeenCalledTimes(1);
    // Switched off or not, every event is in the list.
    expect(c.getState().entries).toHaveLength(3);
  });

  it("tells a new version in the list only, never as a system notification (ADR-0022)", () => {
    const { c, notifier } = center({ background: () => true });
    const entry = c.push(EVENTS.update);
    expect(c.getState().entries).toHaveLength(1);
    expect(entry.event).toEqual({ kind: "update", version: "0.2.0" });
    expect(notifier.show).not.toHaveBeenCalled();
    // The entry opens the popup again (its own kind of target), and a repeat of the same version joins it.
    expect(notificationTarget(entry.event)).toEqual({ kind: "update" });
    c.push({ kind: "update", version: "0.2.0" });
    expect(c.getState().entries).toHaveLength(1);
    c.push({ kind: "update", version: "0.3.0" });
    expect(c.getState().entries).toHaveLength(2);
  });

  it("is on by default, for every kind", () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS.system).toBe(true);
    for (const kind of NOTIFICATION_KINDS) expect(DEFAULT_NOTIFICATION_SETTINGS.kinds[kind]).toBe(true);
  });

  it("never fails the app when the system refuses", async () => {
    const notifier = { kind: "system" as const, show: vi.fn(async () => Promise.reject(new Error("denied"))) };
    const { c } = center({ notifier });
    expect(() => c.push(EVENTS.importDone)).not.toThrow();
    await vi.waitFor(() => expect(notifier.show).toHaveBeenCalled());
  });
});

describe("notification center: what a notification may say", () => {
  it("keeps only the fields of its kind: no page text, task or agent output travels with an event", async () => {
    const { c, shown } = center();
    const leaky = { ...EVENTS.agentFailed, prompt: "SECRET task", output: "SECRET output", text: "SECRET page text" } as unknown as NotificationEvent;
    const entry = c.push(leaky);
    expect(JSON.stringify(entry)).not.toContain("SECRET");
    expect(JSON.stringify(c.getState())).not.toContain("SECRET");
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(JSON.stringify(shown)).not.toContain("SECRET");
  });

  it("writes titles and names on one short line", () => {
    const { c } = center();
    const long = `First line\nsecond\tline ${"x".repeat(200)}\u0007`;
    const entry = c.push({ kind: "saveConflict", page: long, open: { kind: "page", path: "Long.md" } });
    const page = (entry.event as { page: string }).page;
    expect(page).not.toMatch(/[\n\t\u0007]/);
    expect(page.startsWith("First line second line x")).toBe(true);
    expect([...page].length).toBeLessThanOrEqual(80);
    expect(page.endsWith("…")).toBe(true);
    // At most three page titles are kept; the rest is a count.
    const many = c.push({ ...EVENTS.transferDone, transferId: "t9", pages: ["A", "B", "C", "D", "E"] });
    expect(many.event).toMatchObject({ pages: ["A", "B", "C"], more: 2 });
    expect(describeNotification(many.event, en.notifications).body).toBe("A and 4 more pages");
  });

  it("gives every kind a fixed text around titles and names only", () => {
    // With empty names, nothing is left but the fixed words of each kind.
    for (const kind of NOTIFICATION_KINDS) {
      const { title, body } = describeNotification(EVENTS[kind], en.notifications);
      expect(`${title} ${body}`.length).toBeLessThan(160);
    }
  });
});

describe("system notifier through the notification plugin", () => {
  function plugin(granted: boolean, answer: string = "granted") {
    return {
      isPermissionGranted: vi.fn(async () => granted),
      requestPermission: vi.fn(async () => {
        granted = answer === "granted";
        return answer;
      }),
      sendNotification: vi.fn(),
    };
  }

  it("loads nothing and asks nothing until the first notification would be shown, then asks once", async () => {
    const { createPluginNotifier } = await import("../src/notifications/core.ts");
    const api = plugin(false);
    const load = vi.fn(async () => api);
    const notifier = createPluginNotifier(load);
    expect(load).not.toHaveBeenCalled();
    expect(await notifier.show({ title: "T", body: "B" })).toBe(true);
    expect(api.requestPermission).toHaveBeenCalledTimes(1);
    expect(api.sendNotification).toHaveBeenCalledWith({ title: "T", body: "B" });
    expect(await notifier.show({ title: "T2", body: "B2" })).toBe(true);
    expect(api.requestPermission).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not ask again after a refusal, and shows nothing", async () => {
    const { createPluginNotifier } = await import("../src/notifications/core.ts");
    const api = plugin(false, "denied");
    const notifier = createPluginNotifier(async () => api);
    expect(await notifier.show({ title: "T", body: "B" })).toBe(false);
    expect(await notifier.show({ title: "T", body: "B" })).toBe(false);
    expect(api.requestPermission).toHaveBeenCalledTimes(1);
    expect(api.sendNotification).not.toHaveBeenCalled();
  });

  it("does not ask when the permission is already there", async () => {
    const { createPluginNotifier } = await import("../src/notifications/core.ts");
    const api = plugin(true);
    const notifier = createPluginNotifier(async () => api);
    expect(await notifier.show({ title: "T", body: "B" })).toBe(true);
    expect(api.requestPermission).not.toHaveBeenCalled();
  });

  it("reports false when the plugin cannot be loaded", async () => {
    const { createPluginNotifier } = await import("../src/notifications/core.ts");
    const notifier = createPluginNotifier(async () => Promise.reject(new Error("no plugin")));
    expect(await notifier.show({ title: "T", body: "B" })).toBe(false);
  });

  it("the web's notifier shows nothing", async () => {
    const { NO_SYSTEM_NOTIFIER } = await import("../src/notifications/core.ts");
    expect(NO_SYSTEM_NOTIFIER.kind).toBe("none");
    expect(await NO_SYSTEM_NOTIFIER.show({ title: "T", body: "B" })).toBe(false);
  });
});
