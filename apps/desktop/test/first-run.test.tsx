// @vitest-environment jsdom
// First run (ADR-0032): a new, empty Private Space starts on the Welcome pages, in the UI language.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLangPreference } from "../src/strings/index.ts";
import { WELCOME, WELCOME_RECORD } from "../src/features/onboarding/welcome.ts";
import { cleanup, editorBox, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { TOUR_KEY } from "../src/features/tour/store.ts";
import { TOUR_STEPS, availableSteps } from "../src/features/tour/steps.ts";
import { tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  setLangPreference("system");
  localStorage.clear();
  await dirs.cleanup();
});

/** jsdom has no layout: every element gets a size inside the window, so the tour finds its controls on screen. */
function laidOut() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(10, 10, 120, 24));
}

async function skipTourIfShown(app: Harness) {
  const tour = document.querySelector<HTMLElement>(".tour");
  if (tour) await app.user.click(within(tour).getByRole("button", { name: "Skip tour" }));
}

const tourDialog = () => document.querySelector<HTMLElement>(".tour");
const tourTitle = () => tourDialog()?.querySelector("h2")?.textContent ?? null;

const tree = () => screen.findByRole("tree", { name: /Pages in this Private Space|หน้าใน Private Space นี้/ });
const rowNames = async () => within(await tree()).getAllByRole("treeitem").map((r) => r.getAttribute("aria-label") ?? r.textContent);

describe("the Welcome pages", () => {
  it("a new, empty Private Space: Start writing writes them, shows them in the tree, and opens the Welcome page", async () => {
    const app = await openApp(root);
    // The intro still offers the import.
    expect(await screen.findByRole("button", { name: "Import from Notion or Obsidian" })).toBeTruthy();
    await app.user.click(screen.getByRole("button", { name: /start writing/i }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Welcome to Thoth" })).toBeTruthy());
    expect(await editorBox()).toBeTruthy();
    await waitFor(async () => expect(await rowNames()).toEqual(expect.arrayContaining(["Getting started", "Linking pages", "Welcome to Thoth"])));
    expect(await app.read("Welcome to Thoth.md")).toBe(WELCOME.en.files[0]!.text);
    expect(JSON.parse(await app.read(WELCOME_RECORD))).toMatchObject({ version: 1, lang: "en" });
  });

  it("in Thai when the app shows Thai", async () => {
    setLangPreference("th");
    const app = await openApp(root);
    await app.user.click(await screen.findByRole("button", { name: "เริ่มเขียน" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "ยินดีต้อนรับสู่ Thoth" })).toBeTruthy());
    await waitFor(async () => expect(await rowNames()).toEqual(expect.arrayContaining(["เริ่มต้นใช้งาน", "การลิงก์หน้า", "ยินดีต้อนรับสู่ Thoth"])));
    expect(await readFile(join(root, "ยินดีต้อนรับสู่ Thoth.md"), "utf8")).toBe(WELCOME.th.files[0]!.text);
  });

  it("a page link on the Welcome page is a link the tree knows", async () => {
    const app = await openApp(root);
    await app.user.click(await screen.findByRole("button", { name: /start writing/i }));
    const box = await editorBox();
    await waitFor(() => expect(box.querySelector('[data-target="Linking pages.md"]')).not.toBeNull());
    await skipTourIfShown(app);
  });

  it("not again: a Private Space that had them and is empty now starts empty", async () => {
    await seed(root, { [WELCOME_RECORD]: '{ "version": 1 }\n' });
    const app = await openApp(root);
    await app.user.click(await screen.findByRole("button", { name: /start writing/i }));
    expect(await screen.findByText("No pages yet.")).toBeTruthy();
  });
});

const STEPS = ["Your pages", "New page, new folder, import", "Search and commands", "Write in blocks", "Tabs", "Home"];

describe("the first-run tour", () => {
  beforeEach(() => laidOut());

  async function firstRun() {
    const app = await openApp(root);
    await app.user.click(await screen.findByRole("button", { name: /start writing/i }));
    await waitFor(() => expect(tourTitle()).toBe("Your pages"), { timeout: 5000 });
    return app;
  }

  it("starts once the Welcome page is open, points at each control in turn, and goes by keyboard to Done", async () => {
    const app = await firstRun();
    const dialog = screen.getByRole("dialog", { name: "Your pages" });
    expect(dialog.textContent).toContain("1 of 6");
    // Focus is in the popover, on Next; the tree it points at is described by the step's text and ringed.
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Next" }));
    const body = dialog.querySelector(".tour-body")!;
    const anchor = document.querySelector(".sidebar .tree-wrap")!;
    expect(anchor.getAttribute("aria-describedby")?.split(" ")).toContain(body.id);
    expect(anchor.hasAttribute("data-tour-anchor")).toBe(true);
    expect(within(dialog).queryByRole("button", { name: "Back" })).toBeNull();

    const seen = [tourTitle()];
    for (let i = 1; i < STEPS.length; i++) {
      await app.user.keyboard("{Enter}");
      await waitFor(() => expect(tourTitle()).not.toBe(seen.at(-1)));
      seen.push(tourTitle());
      expect(tourDialog()!.textContent).toContain(`${i + 1} of 6`);
      expect(document.activeElement?.textContent).toBe(i === STEPS.length - 1 ? "Done" : "Next");
    }
    expect(seen).toEqual(STEPS);
    // The step before is no longer described or ringed.
    expect(anchor.getAttribute("aria-describedby") ?? "").not.toContain(body.id);
    expect(anchor.hasAttribute("data-tour-anchor")).toBe(false);
    // Back goes back a step and says where it is.
    await app.user.click(within(tourDialog()!).getByRole("button", { name: "Back" }));
    expect(tourTitle()).toBe("Tabs");
    expect(tourDialog()!.querySelector("[aria-live]")!.textContent).toContain("5 of 6. Tabs.");
    await app.user.keyboard("{Enter}");
    await app.user.keyboard("{Enter}");
    await waitFor(() => expect(tourDialog()).toBeNull());
    expect(localStorage.getItem(TOUR_KEY)).toBe("finished");
  });

  it("Escape skips it, and it is remembered: the next new Private Space opens without it", async () => {
    const app = await firstRun();
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(tourDialog()).toBeNull());
    expect(localStorage.getItem(TOUR_KEY)).toBe("skipped");
    cleanup();

    root = await dirs.dir();
    const again = await openApp(root);
    await again.user.click(await screen.findByRole("button", { name: /start writing/i }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Welcome to Thoth" })).toBeTruthy());
    await new Promise((r) => setTimeout(r, 300));
    expect(tourDialog()).toBeNull();
  });

  it("Skip tour is a button too", async () => {
    const app = await firstRun();
    await app.user.click(within(tourDialog()!).getByRole("button", { name: "Skip tour" }));
    expect(tourDialog()).toBeNull();
    expect(localStorage.getItem(TOUR_KEY)).toBe("skipped");
  });

  it("comes back from Settings and from the palette; a control not on screen (the sidebar hidden) is left out", async () => {
    localStorage.setItem(TOUR_KEY, "finished");
    await seed(root, { "Notes.md": "# Notes\n\nText.\n" });
    const app = await openApp(root);
    await screen.findByRole("heading", { level: 1, name: "Notes" });
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    await app.user.click(await screen.findByRole("button", { name: "Show the tour again" }));
    await waitFor(() => expect(tourTitle()).toBe("Your pages"));
    // On Settings there is no page, so no editor step: 5 steps.
    expect(tourDialog()!.textContent).toContain("1 of 5");
    await app.user.keyboard("{Escape}");

    await app.user.click(screen.getByRole("tab", { name: "Settings" }));
    await app.user.keyboard("{Control>}w{/Control}");
    await screen.findByRole("heading", { level: 1, name: "Notes" });
    await app.user.keyboard("{Control>}\\{/Control}"); // hide the sidebar
    await waitFor(() => expect(document.querySelector(".sidebar")!.hasAttribute("inert")).toBe(true));
    await app.user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    await app.user.keyboard("> tour");
    await app.user.click(within(search).getByRole("option", { name: /^Show the tour/ }));
    await waitFor(() => expect(tourTitle()).toBe("Write in blocks"));
    expect(tourDialog()!.textContent).toContain("1 of 3");
  });

  it("has a step for the assistant only where the assistant is on screen", () => {
    document.body.innerHTML = '<aside class="sidebar"><nav class="tree-wrap"></nav></aside><div class="mascot-layer"><button class="mascot"></button></div>';
    expect(availableSteps(TOUR_STEPS).map((s) => s.id)).toEqual(["tree", "assistant"]);
    document.body.innerHTML = '<aside class="sidebar" inert><nav class="tree-wrap"></nav></aside>';
    expect(availableSteps(TOUR_STEPS)).toEqual([]);
    document.body.innerHTML = "";
  });

  it("in Thai", async () => {
    setLangPreference("th");
    const app = await openApp(root);
    await app.user.click(await screen.findByRole("button", { name: "เริ่มเขียน" }));
    await waitFor(() => expect(tourTitle()).toBe("หน้าของคุณ"), { timeout: 5000 });
    expect(tourDialog()!.textContent).toContain("1 จาก 6");
    expect(within(tourDialog()!).getByRole("button", { name: "ข้ามทัวร์" })).toBeTruthy();
    await app.user.keyboard("{Escape}");
  });
});
