// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createThemeStore } from "@thoth/app-ui/ui/theme.ts";
import { startWindowGlass } from "../src/platform/window-glass.ts";

const memory = () => {
  let v: string | null = "dark";
  return { read: () => v, write: (x: string) => void (v = x) };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("window glass", () => {
  it("marks the page and keeps the window's appearance on Thoth's theme, System handing it back to the OS", async () => {
    const root = document.createElement("html");
    const store = createThemeStore(memory(), root);
    const seen: ("light" | "dark" | null)[] = [];
    const stop = startWindowGlass(true, store, async () => ({ setTheme: async (t) => void seen.push(t) }), root);
    expect(root.hasAttribute("data-os-effect")).toBe(true);
    store.set("light");
    store.set("system");
    await flush();
    expect(seen).toEqual(["dark", "light", null]);
    stop();
    store.set("dark");
    await flush();
    expect(seen).toHaveLength(3);
  });

  it("does nothing outside the macOS app", () => {
    const root = document.createElement("html");
    startWindowGlass(false, createThemeStore(memory(), root), async () => ({ setTheme: async () => undefined }), root);
    expect(root.hasAttribute("data-os-effect")).toBe(false);
  });
});
