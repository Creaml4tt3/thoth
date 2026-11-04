// @vitest-environment jsdom
// The Timeline view (ADR-0051 rules 14, 16, 17): day headings, rows that open pages, Edited / Dated and tag toggles
// (pressed state), the polite count after a filter change, a workspace without `page-tags`, and Thai dates.
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StringsContext, th } from "../src/strings/index.ts";
import { TimelineView, type TimelineSource } from "../src/timeline/TimelineView.tsx";
import type { TimelineItem } from "../src/timeline/timeline.ts";

afterEach(cleanup);

const now = new Date(2026, 10, 5, 15);
const at = (d: number, h: number) => new Date(2026, 10, d, h).getTime();
const items: TimelineItem[] = [
  { id: "Plan.md", title: "Plan", folder: "Work", tags: ["work", "plan"], editedMs: at(5, 9) },
  { id: "Notes.md", title: "Notes", tags: ["work"], editedMs: at(4, 9) },
  { id: "Trip.md", title: "Trip", folder: "Home", tags: ["home"], editedMs: at(1, 9), date: "2026-12-24" },
];
const source = (extra: Partial<TimelineSource> = {}): TimelineSource => ({ id: "private", label: "Private Space", items, tags: true, open: vi.fn(), ...extra });
const days = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

describe("TimelineView", () => {
  it("groups rows under day headings, newest first, and opens a page (Cmd/Ctrl+click in a new tab)", async () => {
    const src = source();
    const user = userEvent.setup();
    render(<TimelineView sources={[src]} now={now} />);
    expect(screen.getByRole("heading", { level: 1, name: "Timeline" })).toBeTruthy();
    expect(days()).toEqual(["Today", "Yesterday", "Sunday, November 1, 2026"]);
    const today = screen.getByRole("list", { name: "Today" });
    const row = within(today).getByRole("button", { name: /Plan/ });
    expect(row.textContent).toContain("#work #plan");
    expect(row.textContent).toContain("Work");
    await user.click(row);
    expect(src.open).toHaveBeenCalledWith(items[0], { newTab: false });
    await user.keyboard("{Control>}");
    await user.click(within(screen.getByRole("list", { name: "Yesterday" })).getByRole("button", { name: /Notes/ }));
    await user.keyboard("{/Control}");
    expect(src.open).toHaveBeenLastCalledWith(items[1], { newTab: true });
  });

  it("filters by every selected tag, says the count politely, and clears", async () => {
    const user = userEvent.setup();
    render(<TimelineView sources={[source()]} now={now} />);
    const group = screen.getByRole("group", { name: "Filter by tag" });
    const work = within(group).getByRole("button", { name: "#work" });
    expect(work.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe(""); // nothing said before a change
    await user.click(work);
    expect(work.getAttribute("aria-pressed")).toBe("true");
    expect(days()).toEqual(["Today", "Yesterday"]);
    expect(screen.getByRole("status").textContent).toBe("2 pages shown");
    await user.click(within(group).getByRole("button", { name: "#plan" }));
    expect(screen.getByRole("status").textContent).toBe("1 page shown");
    await user.click(within(group).getByRole("button", { name: "#home" }));
    expect(screen.getByText("No page has all the selected tags.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("0 pages shown");
    await user.click(within(group).getByRole("button", { name: "Clear tags" }));
    expect(days()).toHaveLength(3);
  });

  it("Dated puts a page under the date it names, without a time", async () => {
    const user = userEvent.setup();
    render(<TimelineView sources={[source()]} now={now} />);
    const modes = screen.getByRole("group", { name: "Show pages by" });
    expect(within(modes).getByRole("button", { name: "Edited" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(within(modes).getByRole("button", { name: "Dated" }));
    expect(within(modes).getByRole("button", { name: "Dated" }).getAttribute("aria-pressed")).toBe("true");
    expect(days()[0]).toBe("Thursday, December 24, 2026");
    expect(screen.getByRole("list", { name: "Thursday, December 24, 2026" }).textContent).not.toMatch(/\d:\d\d/);
  });

  it("a workspace without page-tags: Edited only, no tag filter, and a note saying why", () => {
    render(<TimelineView sources={[source({ id: "w", label: "Team", tags: false })]} now={now} />);
    expect(screen.queryByRole("group", { name: "Show pages by" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Filter by tag" })).toBeNull();
    expect(screen.getByText(/doesn't share tags or dates/)).toBeTruthy();
    expect(days()).toEqual(["Today", "Yesterday", "Sunday, November 1, 2026"]);
  });

  it("switches spaces, loading the one chosen; says loading and empty", async () => {
    const load = vi.fn();
    const user = userEvent.setup();
    render(<TimelineView sources={[source(), source({ id: "w", label: "Team", items: null, load })]} now={now} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Space" }), "w");
    expect(load).toHaveBeenCalled();
    expect(screen.getByText("Loading pages…")).toBeTruthy();
    cleanup();
    render(<TimelineView sources={[source({ items: [] })]} now={now} />);
    expect(screen.getByText("No pages yet.")).toBeTruthy();
  });

  it("speaks Thai, with Buddhist-era dates", () => {
    render(
      <StringsContext value={th}>
        <TimelineView sources={[source()]} now={now} />
      </StringsContext>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "ไทม์ไลน์" })).toBeTruthy();
    expect(days().slice(0, 2)).toEqual(["วันนี้", "เมื่อวาน"]);
    expect(days()[2]).toContain("2569");
    expect(within(screen.getByRole("group", { name: "แสดงหน้าตาม" })).getByRole("button", { name: "แก้ไขล่าสุด" })).toBeTruthy();
  });
});
