// @vitest-environment jsdom
// The sidebar's sections (ADR-0019 amendment): the Private Space and each workspace server, reordered by keyboard, by
// the section's menu and by a pointer drag with a live preview, folded and unfolded, and kept per Private Space.
import { act, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { ALPHA, seed } from "./support/fixtures.ts";
import { FakeServers, type FakeServerConfig } from "../../../tests/helpers/fake-servers.ts";
import { loadSidebarLayout, saveSectionOrder, sidebarKey } from "../src/app/sidebar-store.ts";

const dirs = tempDirs();
let root: string;
let server: string;

const TEAM: FakeServerConfig = { url: "http://127.0.0.1:8080", name: "Team server", tokens: ["thoth_pat_good"], account: { id: "usr_me", displayName: "Ada" } };
const HEIGHT = 100;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA, "Beta.md": "# Beta\n" });
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  await dirs.cleanup();
});

async function start(): Promise<Harness> {
  const servers = new FakeServers();
  server = servers.connect(TEAM);
  const app = await openApp(root, {}, createNodePlatform({ vault: root, servers }));
  await screen.findByRole("tree", { name: "Pages in this Private Space" });
  await screen.findByRole("region", { name: "Server Team server" });
  return app;
}

const privateName = () => root.split("/").pop()!;
const sectionNames = () => [...document.querySelectorAll<HTMLElement>(".side-section")].map((el) => el.getAttribute("aria-label"));
const region = (name: string | RegExp) => screen.getByRole("region", { name });
const privateRegion = () => region(/^Private Space /);
const grip = (section: HTMLElement) => within(section).getByRole("button", { name: /^Section options: / });
const said = () => document.querySelector("[data-sections-said]")?.textContent;

/** Each section is 100px high, one under the other in DOM order, moved by its transform; the sidebar's list is 800px. */
function layout(): void {
  const shiftOf = (el: HTMLElement) => Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0);
  const box = (top: number, height: number) => ({ x: 0, y: top, left: 0, top, width: 260, height, right: 260, bottom: top + height, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("side-section")) return box([...document.querySelectorAll(".side-section")].indexOf(this) * HEIGHT + shiftOf(this), HEIGHT);
    if (this.classList.contains("tree-wrap")) return box(0, 800);
    return box(0, 0);
  });
}

describe("sidebar sections", () => {
  it("are the Private Space, then each server, each a named region with a grip that names it", async () => {
    await start();
    expect(sectionNames()).toEqual([`Private Space ${privateName()}`, "Server Team server"]);
    expect(grip(privateRegion()).getAttribute("aria-keyshortcuts")).toContain("Alt+Shift+ArrowDown");
    expect(grip(region("Server Team server")).getAttribute("aria-label")).toBe("Section options: Team server");
  });

  it("Alt+Shift+Down and Up on a section's header move it, keep focus on it, say where it went, and are kept", async () => {
    const app = await start();
    grip(privateRegion()).focus();
    await app.user.keyboard("{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}");
    expect(sectionNames()).toEqual(["Server Team server", `Private Space ${privateName()}`]);
    await waitFor(() => expect(document.activeElement).toBe(grip(privateRegion())));
    expect(said()).toBe(`${privateName()} moved to position 2 of 2`);
    expect(loadSidebarLayout(root).order).toEqual([`server:${server}`, "private"]);
    await app.user.keyboard("{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}"); // already last: nothing
    expect(sectionNames()).toEqual(["Server Team server", `Private Space ${privateName()}`]);
    await app.user.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
    expect(sectionNames()).toEqual([`Private Space ${privateName()}`, "Server Team server"]);
  });

  it("the grip opens the section's menu with Move section up and Move section down", async () => {
    const app = await start();
    await app.user.click(grip(region("Server Team server")));
    const menu = screen.getByRole("menu", { name: "Section: Team server" });
    expect((within(menu).getByRole("menuitem", { name: /^Move section down/ }) as HTMLButtonElement).disabled).toBe(true);
    await app.user.click(within(menu).getByRole("menuitem", { name: /^Move section up/ }));
    expect(sectionNames()).toEqual(["Server Team server", `Private Space ${privateName()}`]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(said()).toBe("Team server moved to position 1 of 2");
  });

  it("Shift+F10 on the header opens the menu too", async () => {
    const app = await start();
    grip(privateRegion()).focus();
    await app.user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu", { name: `Section: ${privateName()}` })).toBeTruthy();
  });

  it("comes back in the stored order when the Private Space opens again; ids that are not there are skipped", async () => {
    await start();
    cleanup();
    saveSectionOrder(root, ["server:not-here", `server:${server}`, "agents", "private"]);
    await start(); // the same server comes back with the same id
    expect(sectionNames()).toEqual(["Server Team server", `Private Space ${privateName()}`]);
  });

  it("follows a change made in another window on the same Private Space", async () => {
    await start();
    localStorage.setItem(sidebarKey(root), JSON.stringify({ v: 2, order: [`server:${server}`, "private"] }));
    act(() => void window.dispatchEvent(new StorageEvent("storage", { key: sidebarKey(root) })));
    expect(sectionNames()).toEqual(["Server Team server", `Private Space ${privateName()}`]);
  });

  it("a section folds away and unfolds from its name, and that is kept", async () => {
    const app = await start();
    const toggle = within(privateRegion()).getByRole("button", { name: privateName() });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await app.user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("tree", { name: "Pages in this Private Space" })).toBeNull(); // hidden
    expect(loadSidebarLayout(root).collapsed).toEqual(["private"]);
    await app.user.click(toggle);
    expect(screen.getByRole("tree", { name: "Pages in this Private Space" })).toBeTruthy();
    expect(loadSidebarLayout(root).collapsed).toEqual([]);
  });
});

describe("dragging a section by its header", () => {
  const pointer = (type: "pointerDown" | "pointerMove" | "pointerUp", target: Element | Window, y: number) =>
    fireEvent[type](target, { clientX: 100, clientY: y, button: 0, buttons: type === "pointerUp" ? 0 : 1, pointerId: 7, pointerType: "mouse" });
  const shift = (el: HTMLElement) => el.style.transform;

  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  });

  it("lifts the section, which follows the pointer, while the others slide aside; the drop moves it there", async () => {
    await start();
    layout();
    const animate = vi.fn();
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
    const header = privateRegion().querySelector<HTMLElement>(".sec")!;
    pointer("pointerDown", header, 10);
    pointer("pointerMove", window, 18);
    expect(privateRegion().dataset["dragging"]).toBe("");
    expect(shift(privateRegion())).toBe("translateY(8px)");
    pointer("pointerMove", window, 160); // its middle (50 + 150) is past the server's (150)
    expect(shift(region("Server Team server"))).toBe("translateY(-100px)");
    expect(shift(privateRegion())).toBe("translateY(100px)"); // it stops at the end of the last section
    pointer("pointerUp", window, 160);
    expect(sectionNames()).toEqual(["Server Team server", `Private Space ${privateName()}`]);
    expect(loadSidebarLayout(root).order).toEqual([`server:${server}`, "private"]);
    expect(shift(region("Server Team server"))).toBe("");
    expect(said()).toBe(`${privateName()} moved to position 2 of 2`);
    expect(animate).not.toHaveBeenCalled(); // both are already where they are shown
  });

  it("Escape puts it back, and nothing is stored", async () => {
    await start();
    layout();
    const header = region("Server Team server").querySelector<HTMLElement>(".sec")!;
    pointer("pointerDown", header, 110);
    pointer("pointerMove", window, 120);
    pointer("pointerMove", window, 5); // its middle (150 - 105) is above the Private Space's (50)
    expect(shift(privateRegion())).toBe("translateY(100px)");
    expect(shift(region("Server Team server"))).toBe("translateY(-100px)");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(shift(privateRegion())).toBe("");
    pointer("pointerUp", window, 5);
    expect(sectionNames()).toEqual([`Private Space ${privateName()}`, "Server Team server"]);
    expect(localStorage.getItem(sidebarKey(root))).toBeNull();
  });

  it("a drag cancelled with Escape does not fold the section when the button is let go later", async () => {
    await start();
    layout();
    const header = region("Server Team server").querySelector<HTMLElement>(".sec")!;
    const toggle = header.querySelector<HTMLElement>("[aria-expanded]")!;
    const before = toggle.getAttribute("aria-expanded");
    pointer("pointerDown", toggle, 110);
    pointer("pointerMove", window, 120);
    pointer("pointerMove", window, 5);
    fireEvent.keyDown(window, { key: "Escape" });
    await act(() => new Promise((r) => setTimeout(r, 20))); // the button is let go well after Escape
    pointer("pointerUp", window, 5);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe(before);
  });

  it("a press on a page in the tree never starts a section drag, and a press on the header is not a page drag", async () => {
    await start();
    layout();
    const page = screen.getByRole("treeitem", { name: "Alpha" });
    pointer("pointerDown", page, 40);
    pointer("pointerMove", window, 200);
    expect(document.querySelector("[data-section-dragging]")).toBeNull();
    expect(privateRegion().dataset["dragging"]).toBeUndefined();
    pointer("pointerUp", window, 200);
    expect(privateRegion().querySelector(".sec")!.getAttribute("draggable")).toBeNull();
  });

  it("a press that hardly moves is a click on the header (the grip opens its menu)", async () => {
    await start();
    layout();
    const g = grip(privateRegion());
    pointer("pointerDown", g, 10);
    pointer("pointerMove", window, 12);
    pointer("pointerUp", window, 12);
    fireEvent.click(g);
    expect(screen.getByRole("menu", { name: `Section: ${privateName()}` })).toBeTruthy();
  });
});
