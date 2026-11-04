// @vitest-environment jsdom
// The Connections panel (ADR-0050): its three parts, mentions looked for only when asked, one click to link a
// mention (then the row leaves, the outcome is said and focus moves on), no Link button for viewers, and the Home
// Today card.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Connections, type ConnectionsSource, type MentionRow } from "../src/connections/Connections.tsx";
import { findMentions } from "../src/connections/mentions.ts";
import { HomeView } from "../src/home/HomeView.tsx";
import { StringsContext, th } from "../src/strings/index.ts";

afterEach(cleanup);

const row = (ref: string, title: string, text: string): MentionRow => ({ page: { ref, title }, mention: findMentions(text, "Atlas")[0]! });

function source(overrides: Partial<ConnectionsSource> = {}): ConnectionsSource & { mentions: ReturnType<typeof vi.fn> } {
  const mentions = vi.fn(async () => ({ rows: [row("Notes.md", "Notes", "We use Atlas daily."), row("Plan.md", "Plan", "Ship Atlas soon.")], capped: false }));
  return {
    title: "Atlas",
    tick: 0,
    links: async () => [{ ref: "Roadmap.md", title: "Roadmap", detail: "Roadmap.md" }],
    backlinks: async () => [{ ref: "Index.md", title: "Index" }],
    mentions,
    link: vi.fn(async () => "linked" as const),
    open: vi.fn(),
    ...overrides,
  } as ConnectionsSource & { mentions: ReturnType<typeof vi.fn> };
}

describe("Connections", () => {
  it("lists links and backlinks under their headings, and opens a page on click", async () => {
    const src = source();
    const user = userEvent.setup();
    render(<Connections source={src} />);
    const region = screen.getByRole("region", { name: "Connections" });
    expect(await within(region).findByRole("heading", { name: "Links from this page (1)" })).toBeTruthy();
    expect(await within(region).findByRole("heading", { name: "Backlinks (1)" })).toBeTruthy();
    await user.click(within(region).getByRole("button", { name: /^Index/ }));
    expect(src.open).toHaveBeenCalledWith("Index.md", undefined);
  });

  it("looks for mentions only when the part is opened, and links one with a click", async () => {
    const src = source();
    const user = userEvent.setup();
    render(<Connections source={src} />);
    const toggle = screen.getByRole("button", { name: /Unlinked mentions/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(src.mentions).not.toHaveBeenCalled();

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const first = await screen.findByRole("button", { name: "Link the mention in Notes" });
    // The words around the mention, the title marked.
    expect(screen.getByRole("button", { name: /^Notes/ }).querySelector("mark")?.textContent).toBe("Atlas");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("2 unlinked mentions."));

    await user.click(first);
    expect(src.link).toHaveBeenCalledWith(expect.objectContaining({ page: { ref: "Notes.md", title: "Notes" } }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Link the mention in Notes" })).toBeNull());
    expect(screen.getByRole("status").textContent).toBe("Linked in Notes.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Link the mention in Plan" })));
  });

  it("says when the page changed or the mention is gone, and keeps the row", async () => {
    const user = userEvent.setup();
    render(<Connections source={source({ link: async () => "changed" })} />);
    await user.click(screen.getByRole("button", { name: /Unlinked mentions/ }));
    await user.click(await screen.findByRole("button", { name: "Link the mention in Notes" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Notes changed; nothing was written. Try again."));
    expect(screen.getByRole("button", { name: "Link the mention in Notes" })).toBeTruthy();
  });

  it("shows no Link button to a viewer, no Backlinks where they cannot be listed, and refuses very short titles", async () => {
    const user = userEvent.setup();
    const { link: _link, ...viewer } = source({ backlinks: () => null });
    const { unmount } = render(<Connections source={viewer} />);
    await user.click(screen.getByRole("button", { name: /Unlinked mentions/ }));
    await screen.findByRole("button", { name: /^Notes/ });
    expect(screen.queryByRole("button", { name: /^Link the mention/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Backlinks/ })).toBeNull();
    unmount();

    const src = source({ title: "AI" });
    render(<Connections source={src} />);
    await user.click(screen.getByRole("button", { name: /Unlinked mentions/ }));
    expect(screen.getByText("This page's title is too short to look for.")).toBeTruthy();
    expect(src.mentions).not.toHaveBeenCalled();
  });

  it("shows which alias a mention matched (ADR-0051 rule 12)", async () => {
    const user = userEvent.setup();
    const byAlias: MentionRow = { page: { ref: "Trip.md", title: "Trip" }, mention: findMentions("Flew to BKK.", ["Bangkok Office", "BKK"])[0]! };
    render(<Connections source={source({ title: "Bangkok Office", aliases: ["BKK"], mentions: vi.fn(async () => ({ rows: [byAlias], capped: false })) })} />);
    await user.click(screen.getByRole("button", { name: /Unlinked mentions/ }));
    const row = await screen.findByRole("button", { name: /^Trip/ });
    expect(row.querySelector("mark")?.textContent).toBe("BKK");
    expect(row.textContent).toContain("Alias: BKK");
  });

  it("looks for a short title's mentions when an alias is long enough", async () => {
    const user = userEvent.setup();
    const src = source({ title: "AI", aliases: ["Artificial intelligence"] });
    render(<Connections source={src} />);
    await user.click(screen.getByRole("button", { name: /Unlinked mentions/ }));
    await waitFor(() => expect(src.mentions).toHaveBeenCalled());
  });

  it("speaks Thai", async () => {
    render(
      <StringsContext.Provider value={th}>
        <Connections source={source()} />
      </StringsContext.Provider>,
    );
    expect(screen.getByRole("region", { name: "การเชื่อมโยง" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /ถูกพูดถึงแต่ยังไม่มีลิงก์/ })).toBeTruthy();
  });
});

describe("Home's Today card", () => {
  it("names the date and what a click does, and opens (in a new tab with Cmd/Ctrl)", async () => {
    const open = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<HomeView recent={[]} favorites={[]} today={{ date: "Wednesday, November 4, 2026", exists: false, open }} />);
    const card = screen.getByRole("button", { name: /Wednesday, November 4, 2026.*Start today's page/ });
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
    await user.click(card);
    expect(open).toHaveBeenCalledWith({ newTab: false });
    card.focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(open).toHaveBeenLastCalledWith({ newTab: true });

    rerender(<HomeView recent={[]} favorites={[]} today={{ date: "Wednesday, November 4, 2026", exists: true, error: "disk full", open }} />);
    expect(screen.getByRole("button", { name: /Open today's page/ })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("disk full");
  });

  it("is absent where there is no Today (the web client)", () => {
    render(<HomeView recent={[]} favorites={[]} />);
    expect(screen.queryByRole("heading", { name: "Today" })).toBeNull();
  });
});
