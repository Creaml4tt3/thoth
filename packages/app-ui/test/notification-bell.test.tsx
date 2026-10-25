// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "../src/strings/index.ts";
import { createNotificationCenter, type NotificationCenter, type NotificationTarget } from "../src/notifications/core.ts";
import { NotificationBell } from "../src/notifications/NotificationBell.tsx";

afterEach(cleanup);

function Harness({ center, onOpen }: { center: NotificationCenter; onOpen(target: NotificationTarget): void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="shell">
      <button type="button">Before</button>
      <NotificationBell center={center} open={open} onOpenChange={setOpen} onOpenTarget={onOpen} />
      <button type="button">After</button>
    </div>
  );
}

function setup() {
  const center = createNotificationCenter({ strings: () => en.notifications, now: () => Date.UTC(2026, 9, 25, 9, 30) });
  const onOpen = vi.fn();
  const user = userEvent.setup();
  render(<Harness center={center} onOpen={onOpen} />);
  return { center, onOpen, user };
}

const bell = () => screen.getByRole("button", { name: /^Notifications/ });
const panel = () => screen.getByRole("dialog", { name: "Notifications" });

describe("the notification bell", () => {
  it("says how many are unread in its name and badge", () => {
    const { center } = setup();
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
    expect(bell().getAttribute("aria-haspopup")).toBe("dialog");
    expect(bell().getAttribute("aria-expanded")).toBe("false");
    act(() => {
      center.push({ kind: "importDone", jobId: "j1", folder: "Imported", pages: 2 });
      center.push({ kind: "saveConflict", page: "Alpha", open: { kind: "page", path: "Alpha.md" } });
    });
    expect(bell().getAttribute("aria-label")).toBe("Notifications, 2 unread");
    expect(screen.getByTestId("notification-badge").textContent).toBe("2");
    expect(screen.getByTestId("notification-badge").getAttribute("aria-hidden")).toBe("true");
  });

  it("opens a list from the keyboard, moves with the arrows, and Esc closes it and returns focus to the bell", async () => {
    const { center, user } = setup();
    act(() => {
      center.push({ kind: "importDone", jobId: "j1", folder: "Imported", pages: 2 });
      center.push({ kind: "saveConflict", page: "Alpha", open: { kind: "page", path: "Alpha.md" } });
    });
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(bell());
    await user.keyboard("{Enter}");
    expect(bell().getAttribute("aria-expanded")).toBe("true");
    const items = within(panel()).getAllByRole("button", { name: /Unread/ });
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining("Alpha changed elsewhere while you were editing it"), expect.stringContaining("Import complete")]);
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    expect(document.activeElement).toBe(bell());
  });

  it("opens what an entry is about, marks it read and closes", async () => {
    const { center, onOpen, user } = setup();
    act(() => void center.push({ kind: "saveConflict", page: "Alpha", open: { kind: "page", path: "Alpha.md" } }));
    await user.click(bell());
    await user.click(within(panel()).getByRole("button", { name: /Alpha changed elsewhere/ }));
    expect(onOpen).toHaveBeenCalledWith({ kind: "page", path: "Alpha.md" });
    expect(center.getState().unread).toBe(0);
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
  });

  it("marks all read and clears", async () => {
    const { center, user } = setup();
    act(() => {
      center.push({ kind: "importDone", jobId: "j1", folder: "Imported", pages: 2 });
      center.push({ kind: "importFailed", jobId: "j2", folder: "Imported 2", pages: 1 });
    });
    await user.click(bell());
    await user.click(within(panel()).getByRole("button", { name: "Mark all read" }));
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
    expect(within(panel()).queryAllByRole("button", { name: /Unread/ })).toEqual([]);
    expect(within(panel()).getByRole("button", { name: "Mark all read" })).toHaveProperty("disabled", true);
    await user.click(within(panel()).getByRole("button", { name: "Clear" }));
    expect(panel().textContent).toContain("Nothing yet.");
    // Focus stays in the list (on the list itself) rather than falling to the page.
    expect(panel().contains(document.activeElement)).toBe(true);
  });

  it("closes on a click elsewhere, and when focus leaves it", async () => {
    const { user } = setup();
    await user.click(bell());
    expect(panel()).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Before" }));
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
    await user.click(bell());
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
  });

  it("says new entries politely", () => {
    const { center } = setup();
    const live = screen.getByTestId("notification-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("");
    act(() => void center.push({ kind: "importDone", jobId: "j1", folder: "Imported", pages: 2 }));
    expect(live.textContent).toBe("Import complete. 2 pages in Imported");
  });

  it("shows the time of each entry", async () => {
    const { center, user } = setup();
    act(() => void center.push({ kind: "importDone", jobId: "j1", folder: "Imported", pages: 2 }));
    await user.click(bell());
    const time = panel().querySelector("time")!;
    expect(time.getAttribute("datetime")).toBe("2026-10-25T09:30:00.000Z");
    expect(time.textContent).toBe(new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(Date.UTC(2026, 9, 25, 9, 30)));
  });
});
