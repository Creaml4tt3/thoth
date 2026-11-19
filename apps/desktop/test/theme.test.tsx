// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { THEME_KEY, desktopTheme } from "../src/features/settings/theme.ts";
import { cleanup, openApp, screen } from "./support/render.tsx";
import { tempDirs } from "./support/node-platform.ts";
import { ALPHA, seed } from "./support/fixtures.ts";
import { chooseOption, selectValue } from "../../../packages/app-ui/test/support/select.ts";

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  localStorage.clear();
  desktopTheme.set("system");
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Alpha.md": ALPHA });
});
afterEach(async () => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
  await dirs.cleanup();
});

describe("desktop theme", () => {
  it("is chosen in Settings, applies at once and is kept with the other preferences", async () => {
    const app = await openApp(root);
    await app.user.click(await screen.findByRole("button", { name: "Settings" }));
    await app.user.click(await screen.findByRole("tab", { name: "Appearance" }));
    const select = await screen.findByRole("combobox", { name: "Theme" });
    expect(selectValue(select)).toBe("system");
    chooseOption(select, "Dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("night");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    chooseOption(select, "Light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
  });

  it("is Thai in a Thai UI", async () => {
    const { th } = await import("../src/strings/index.ts");
    expect(th.settings.theme).toBe("ธีม");
    expect(th.settings.themeHint.length).toBeGreaterThan(0);
  });
});
