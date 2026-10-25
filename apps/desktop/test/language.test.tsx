// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en as sharedEn, th as sharedTh } from "@thoth/app-ui/strings/index.ts";
import { DESKTOP_STRINGS, langPreference, resolveLang, setLangPreference, systemLanguages, en, th } from "../src/strings/index.ts";
import { currentOs, displayPath, middleTruncate, withTilde } from "../src/features/settings/path.ts";
import { cleanup, openApp, screen, waitFor, within } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, seed } from "./support/fixtures.ts";

const dirs = tempDirs();
let root: string;

/** Makes the webview report `languages` as the system's languages. */
function systemLanguage(...languages: string[]) {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
  vi.spyOn(navigator, "language", "get").mockReturnValue(languages[0] ?? "");
}

beforeEach(async () => {
  localStorage.clear();
  setLangPreference("system");
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA });
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await dirs.cleanup();
});

/** Every leaf of a strings table as `path → kind`, functions by arity. */
function shape(value: unknown, path = ""): string[] {
  if (typeof value === "function") return [`${path}:fn${value.length}`];
  if (Array.isArray(value)) return [`${path}:array${value.length}`];
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => shape(v, path ? `${path}.${k}` : k));
  return [`${path}:${typeof value}`];
}

describe("desktop strings", () => {
  it("Thai has exactly the English keys, and no Thai string is left in English", () => {
    expect(shape(th)).toEqual(shape(en));
    const leaves = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : []);
    const english = new Set(leaves(en));
    // Product and format names stay as they are in both languages.
    const same = new Set(["Thoth", "Private Space", "Agent Hub", "Claude Code", "Codex"]);
    expect(leaves(th).filter((s) => english.has(s) && !same.has(s))).toEqual([]);
  });

  it("follows the system language (th* is Thai, anything else English) unless a language is chosen", () => {
    expect(resolveLang("system", ["th-TH", "en-US"])).toBe("th");
    expect(resolveLang("system", ["TH"])).toBe("th");
    expect(resolveLang("system", ["fr-FR", "th"])).toBe("th");
    expect(resolveLang("system", ["ja-JP"])).toBe("en");
    expect(resolveLang("system", [])).toBe("en");
    expect(resolveLang("en", ["th-TH"])).toBe("en");
    expect(resolveLang("th", ["en-US"])).toBe("th");
    expect(systemLanguages({ languages: [], language: "th-TH" })).toEqual(["th-TH"]);
    expect(systemLanguages({ languages: [], language: "" })).toEqual([]);
  });

  it("remembers the chosen language, and ignores a stored value it does not know", () => {
    expect(langPreference()).toBe("system");
    setLangPreference("th");
    expect(localStorage.getItem("thoth.desktop.lang")).toBe("th");
    expect(langPreference()).toBe("th");
    localStorage.setItem("thoth.desktop.lang", "fr");
    expect(langPreference()).toBe("th"); // the in-memory choice, not the junk
    expect(DESKTOP_STRINGS.th).toBe(th);
  });
});

describe("Private Space folder in Settings", () => {
  it("replaces the home directory with ~ on macOS, Linux and Windows", () => {
    expect(withTilde("/Users/somchai/Documents/Thoth")).toBe("~/Documents/Thoth");
    expect(withTilde("/Users/somchai")).toBe("~");
    expect(withTilde("/home/ada/notes")).toBe("~/notes");
    expect(withTilde("C:\\Users\\Ada\\Notes")).toBe("~\\Notes");
    expect(withTilde("/Volumes/Data/Notes")).toBe("/Volumes/Data/Notes");
    expect(withTilde("/Users2/x")).toBe("/Users2/x");
  });

  it("shortens long paths in the middle, keeping the folder's name, without splitting characters", () => {
    expect(middleTruncate("~/a/b", 10)).toBe("~/a/b");
    const long = "~/Library/Mobile Documents/com~apple~CloudDocs/Projects/2026/Thoth notes";
    const short = middleTruncate(long, 32);
    expect([...short]).toHaveLength(32);
    expect(short.startsWith("~/Library/")).toBe(true);
    expect(short.endsWith("Thoth notes")).toBe(true);
    expect(short).toContain("…");
    const thai = middleTruncate("~/เอกสาร/โน้ตของฉัน/โปรเจกต์ใหม่/บันทึกประจำวัน", 20);
    expect([...thai]).toHaveLength(20);
    expect(displayPath("/Users/somchai/Documents/Thoth")).toBe("~/Documents/Thoth");
  });

  it("names the file manager of the platform", () => {
    expect(currentOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("mac");
    expect(currentOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(currentOs("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });

  it("shows the short form with the full path as a tooltip, and Show in Finder reveals the folder", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    const app = await openApp(root);
    const reveal = vi.fn(async () => undefined);
    await screen.findByRole("tree");
    app.platform.connections[0]!.reveal = reveal;
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const location = await screen.findByTestId("vault-location");
    expect(location.getAttribute("title")).toBe(root);
    expect(location.textContent).toBe(displayPath(root));
    await app.user.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("offers no Show action when the host cannot reveal folders, and reports a failure", async () => {
    const app = await openApp(root);
    await screen.findByRole("tree");
    const connection = app.platform.connections[0]!;
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByTestId("vault-location");
    expect(connection.reveal).toBeUndefined();
    expect(screen.queryByRole("button", { name: /^Show in/ })).toBeNull();

    cleanup();
    const again = await openApp(root);
    await screen.findByRole("tree");
    again.platform.connections.at(-1)!.reveal = async () => {
      throw new Error("Could not open the file manager");
    };
    await again.user.click(screen.getByRole("button", { name: "Settings" }));
    await again.user.click(await screen.findByRole("button", { name: /^Show in/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not open the file manager");
  });
});

describe("language in the app", () => {
  it("is Thai on a Thai system: onboarding, the shell, the shared editor text and Settings", async () => {
    systemLanguage("th-TH", "en-US");
    const app = await openApp(root);
    expect(document.documentElement.lang).toBe("th");
    await screen.findByRole("tree", { name: th.shell.pagesInSpace });
    expect(screen.getByRole("button", { name: th.shell.newPage })).toBeTruthy();
    // A shared (app-ui) string: the editor mode switch.
    expect(await screen.findByRole("group", { name: sharedTh.editor.modeGroup })).toBeTruthy();
    await app.user.click(screen.getByRole("button", { name: th.shell.settings }));
    expect(await screen.findByRole("heading", { level: 1, name: th.settings.title })).toBeTruthy();
    expect(screen.getByRole("radio", { name: sharedTh.editor.modes.plain.label })).toBeTruthy();
    expect(screen.getByRole("button", { name: th.settings.rebuild })).toBeTruthy();
  });

  it("can be chosen in Settings (System / English / ไทย), takes effect at once and is remembered", async () => {
    systemLanguage("en-US");
    const app = await openApp(root);
    await screen.findByRole("tree");
    expect(document.documentElement.lang).toBe("en");
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const language = await screen.findByRole("combobox", { name: "Language" });
    expect([...(language as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["System", "English", "ไทย"]);
    expect((language as HTMLSelectElement).value).toBe("system");

    await app.user.selectOptions(language, "th");
    expect(await screen.findByRole("heading", { level: 1, name: th.settings.title })).toBeTruthy();
    expect(document.documentElement.lang).toBe("th");
    expect(localStorage.getItem("thoth.desktop.lang")).toBe("th");
    const thaiSelect = screen.getByRole("combobox", { name: th.settings.language }) as HTMLSelectElement;
    expect([...thaiSelect.options].map((o) => o.textContent)).toEqual([th.settings.system, "English", "ไทย"]);
    expect(within(screen.getByRole("complementary")).getByRole("button", { name: th.shell.settings })).toBeTruthy();

    // A new window starts in the remembered language even though the system is English.
    cleanup();
    await openApp(root);
    await screen.findByRole("tree", { name: th.shell.pagesInSpace });

    // Back to System follows the system again.
    cleanup();
    const back = await openApp(root);
    await screen.findByRole("tree");
    await back.user.click(screen.getByRole("button", { name: th.shell.settings }));
    await back.user.selectOptions(await screen.findByRole("combobox", { name: th.settings.language }), "system");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: en.settings.title })).toBeTruthy());
    expect(localStorage.getItem("thoth.desktop.lang")).toBe("system");
    expect(screen.getByRole("radio", { name: sharedEn.editor.modes.plain.label })).toBeTruthy();
  });
});
