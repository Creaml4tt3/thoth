// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fakeBrowser, open, screen } from "./support/render.tsx";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

describe("web theme", () => {
  it("starts on System, and the sign-in page has the theme control", async () => {
    const browser = fakeBrowser();
    open(browser);
    const select = (await screen.findByRole("combobox", { name: "Theme" })) as HTMLSelectElement;
    expect(select.value).toBe("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("system");
    expect([...browser.local.keys()]).toEqual([]);
  });

  it("remembers the choice in one localStorage key that holds only the theme name", async () => {
    const browser = fakeBrowser();
    open(browser);
    await browser.user.selectOptions(await screen.findByRole("combobox", { name: "Theme" }), "dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("night");
    expect([...browser.local.entries()]).toEqual([["thoth.theme", "dark"]]);
  });

  it("restores the saved theme before the first render", async () => {
    const browser = fakeBrowser(undefined, { local: new Map([["thoth.theme", "light"]]) });
    open(browser);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(((await screen.findByRole("combobox", { name: "Theme" })) as HTMLSelectElement).value).toBe("light");
  });

  it("names the control in Thai", async () => {
    const browser = fakeBrowser(undefined, { languages: ["th-TH"] });
    open(browser);
    expect(await screen.findByRole("combobox", { name: "ธีม" })).toBeTruthy();
  });
});
