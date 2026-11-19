// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesQuery } from "../src/ui/SettingsLayout.tsx";
import { Select } from "../src/ui/Select.tsx";

let SettingsLayout: typeof import("../src/ui/SettingsLayout.tsx").SettingsLayout;
beforeEach(async () => {
  // A fresh module each test: the chosen section is remembered for the session (a module variable).
  vi.resetModules();
  ({ SettingsLayout } = await import("../src/ui/SettingsLayout.tsx"));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Fixture({ extra = false, initial, request }: { extra?: boolean; initial?: string; request?: object }) {
  const sections = [
    { id: "s-a", label: "Alpha", icon: "gear" as const },
    { id: "s-b", label: "Beta", icon: "gear" as const },
    { id: "s-c", label: "Gamma", icon: "gear" as const },
  ];
  return (
    <SettingsLayout sections={sections} initial={initial} request={request}>
      <h1>Settings</h1>
      {["s-a", "s-b"].map((id) => (
        <section key={id} aria-labelledby={id}>
          <h2 id={id}>{id}</h2>
        </section>
      ))}
      {extra && (
        <section aria-labelledby="s-c">
          <h2 id="s-c">s-c</h2>
        </section>
      )}
    </SettingsLayout>
  );
}

describe("SettingsLayout", () => {
  const tabs = () => within(screen.getByRole("tablist", { name: "Settings sections" })).getAllByRole("tab");
  const shownPanels = () => [...document.querySelectorAll<HTMLElement>(".settings > section")].filter((el) => !el.hidden).map((el) => el.querySelector("h2")!.id);

  it("lists only the sections on the page, as tabs", async () => {
    const { rerender } = render(<Fixture />);
    expect(tabs().map((t) => t.textContent)).toEqual(["Alpha", "Beta"]);
    rerender(<Fixture extra />);
    expect(await within(screen.getByRole("tablist")).findByRole("tab", { name: "Gamma" })).toBeTruthy();
  });

  it("shows only the chosen section", () => {
    render(<Fixture extra />);
    expect(shownPanels()).toEqual(["s-a"]);
    expect(document.getElementById("s-b")!.closest("section")!.hidden).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Gamma" }));
    expect(shownPanels()).toEqual(["s-c"]);
    expect(document.getElementById("s-a")!.closest("section")!.hidden).toBe(true);
  });

  it("the list is a vertical tablist, each section a tabpanel labelled by its tab", () => {
    render(<Fixture />);
    const list = screen.getByRole("tablist");
    expect(list.getAttribute("aria-orientation")).toBe("vertical");
    expect(tabs().map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1]);
    for (const tab of tabs()) {
      const panel = document.getElementById(tab.getAttribute("aria-controls")!)!;
      expect(panel.getAttribute("role")).toBe("tabpanel");
      expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
    }
    expect(screen.getByRole("tabpanel", { name: "Alpha" })).toBeTruthy();
  });

  it("arrow keys move between tabs and choose them; Home and End go to the ends", () => {
    render(<Fixture extra />);
    const [a, b, c] = tabs();
    a!.focus();
    fireEvent.keyDown(a!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(b);
    expect(shownPanels()).toEqual(["s-b"]);
    fireEvent.keyDown(b!, { key: "End" });
    expect(document.activeElement).toBe(c);
    expect(shownPanels()).toEqual(["s-c"]);
    fireEvent.keyDown(c!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c!, { key: "Home" });
    expect(document.activeElement).toBe(a);
    expect(shownPanels()).toEqual(["s-a"]);
  });

  it("initial opens that section, even when it appears late", async () => {
    const sections = [
      { id: "s-a", label: "Alpha", icon: "gear" as const },
      { id: "s-late", label: "Servers", icon: "gear" as const },
    ];
    const Page = ({ late }: { late: boolean }) => (
      <SettingsLayout sections={sections} initial="s-late">
        <section aria-labelledby="s-a">
          <h2 id="s-a">Alpha</h2>
        </section>
        {late && (
          <section aria-labelledby="s-late">
            <h2 id="s-late">Servers</h2>
          </section>
        )}
      </SettingsLayout>
    );
    const { rerender } = render(<Page late={false} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    rerender(<Page late />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(shownPanels()).toEqual(["s-late"]);
    expect(screen.getByRole("tab", { name: "Servers" }).getAttribute("aria-selected")).toBe("true");
  });

  it("a deep link opens its section once: the person's later choice stays when the tab comes back", () => {
    const request = {};
    const { unmount } = render(<Fixture initial="s-b" request={request} />);
    expect(shownPanels()).toEqual(["s-b"]);
    fireEvent.click(screen.getByRole("tab", { name: "Alpha" }));
    unmount();
    const again = render(<Fixture initial="s-b" request={request} />);
    expect(shownPanels()).toEqual(["s-a"]);
    again.unmount();
    render(<Fixture initial="s-b" request={{}} />); // asked again
    expect(shownPanels()).toEqual(["s-b"]);
  });

  it("the last chosen section is remembered for the session", () => {
    const { unmount } = render(<Fixture />);
    fireEvent.click(screen.getByRole("tab", { name: "Beta" }));
    unmount();
    render(<Fixture />);
    expect(shownPanels()).toEqual(["s-b"]);
  });

  describe("search", () => {
    function Page() {
      return (
        <SettingsLayout sections={[{ id: "s-look", label: "Appearance", icon: "gear" as const }, { id: "s-ed", label: "Editor", icon: "gear" as const }, { id: "s-up", label: "Updates", icon: "gear" as const }]}>
          <section aria-labelledby="s-look">
            <h2 id="s-look">Appearance</h2>
            <label className="field">
              <span>Theme</span>
              <select aria-label="Theme">
                <option>Light</option>
                <option>Dark</option>
              </select>
            </label>
            <label className="field">
              <span>Language</span>
              <select aria-label="Language">
                <option>English</option>
              </select>
            </label>
          </section>
          <section aria-labelledby="s-ed">
            <h2 id="s-ed">Editor</h2>
            <p>Both modes edit the same file.</p>
            <div className="set-sub">
              <h3>Link previews</h3>
              <p>Cards for links on their own line.</p>
            </div>
          </section>
          <section aria-labelledby="s-up">
            <h2 id="s-up">Updates</h2>
            <p>Tell me when a new version is out</p>
          </section>
        </SettingsLayout>
      );
    }
    const box = () => screen.getByRole("searchbox", { name: "Search settings" });
    const shown = () => [...document.querySelectorAll("section")].filter((el) => !el.hidden).map((el) => el.querySelector("h2")!.id);
    const links = () => within(screen.getByRole("tablist", { name: "Settings sections" })).getAllByRole("tab").map((a) => a.textContent);

    it("matches every word in any order, ignoring case and accents", () => {
      expect(matchesQuery("Tell me when a new version is out", "VERSION new")).toBe(true);
      expect(matchesQuery("Thème", "theme")).toBe(true);
      expect(matchesQuery("Link previews", "preview card")).toBe(false);
      expect(matchesQuery("ภาษา", "ภาษา")).toBe(true);
    });

    it("keeps a section whose heading matches whole, and only the matching parts of the others", () => {
      render(<Page />);
      fireEvent.change(box(), { target: { value: "dark" } });
      expect(shown()).toEqual(["s-look"]);
      const theme = screen.getByRole("combobox", { name: "Theme", hidden: true }).closest("label")!;
      const language = screen.getByRole("combobox", { name: "Language", hidden: true }).closest("label")!;
      expect([theme.hidden, language.hidden]).toEqual([false, true]);
      expect(links()).toEqual(["Appearance"]);
      fireEvent.change(box(), { target: { value: "editor" } });
      expect(shown()).toEqual(["s-ed"]);
      expect(screen.getByText("Link previews").closest<HTMLElement>(".set-sub")!.hidden).toBe(false);
    });

    it("finds a Thoth Select by the label of any of its options, not only the chosen one", () => {
      render(
        <SettingsLayout sections={[{ id: "s-x", label: "Look", icon: "gear" as const }, { id: "s-y", label: "Other", icon: "gear" as const }]}>
          <section aria-labelledby="s-x">
            <h2 id="s-x">Look</h2>
            <div className="field">
              <Select aria-label="Colour scheme" value="a" onChange={() => undefined} options={[{ value: "a", label: "Paper" }, { value: "b", label: "Ink" }]} />
            </div>
            <p>Unrelated</p>
          </section>
          <section aria-labelledby="s-y">
            <h2 id="s-y">Other</h2>
          </section>
        </SettingsLayout>,
      );
      fireEvent.change(box(), { target: { value: "ink" } });
      expect(shown()).toEqual(["s-x"]);
      expect(screen.getByText("Unrelated").hidden).toBe(true);
    });

    it("finds a sub-section by its own heading and says how many sections matched", () => {
      render(<Page />);
      fireEvent.change(box(), { target: { value: "link previews" } });
      expect(shown()).toEqual(["s-ed"]);
      expect(screen.getByText("Both modes edit the same file.").hidden).toBe(true);
      expect(screen.getByRole("status").textContent).toBe("1 section found");
    });

    it("says when nothing matches, and Escape brings the chosen section back", () => {
      render(<Page />);
      fireEvent.change(box(), { target: { value: "zzz" } });
      expect(shown()).toEqual([]);
      expect(screen.getByText(/No setting matches “zzz”/)).toBeTruthy();
      fireEvent.keyDown(box(), { key: "Escape" });
      expect((box() as HTMLInputElement).value).toBe("");
      expect(shown()).toEqual(["s-look"]);
      expect([...document.querySelectorAll(".settings > section > [hidden]")]).toEqual([]);
      expect(links()).toEqual(["Appearance", "Editor", "Updates"]);
    });

    it("search shows matches from every section, and clearing returns to the chosen one", () => {
      render(<Page />);
      fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
      expect(shown()).toEqual(["s-ed"]);
      fireEvent.change(box(), { target: { value: "version" } });
      expect(shown()).toEqual(["s-up"]);
      expect(screen.getByText("Tell me when a new version is out").hidden).toBe(false);
      fireEvent.keyDown(box(), { key: "Escape" });
      expect(shown()).toEqual(["s-ed"]);
    });

    it("choosing a section while searching clears the search and opens it", () => {
      render(<Page />);
      fireEvent.change(box(), { target: { value: "version" } });
      fireEvent.click(screen.getByRole("tab", { name: "Updates" }));
      expect((box() as HTMLInputElement).value).toBe("");
      expect(shown()).toEqual(["s-up"]);
    });
  });
});
