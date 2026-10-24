// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, createThemeStore, cycleTheme, resolveTheme, storageKey, useResolvedTheme, useTheme, watchSystemTheme } from "../src/ui/theme.ts";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

/** A fake `matchMedia` whose dark-mode result the test flips. */
function fakeMedia(dark: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query = {
    matches: dark,
    addEventListener: (_: "change", fn: (event: { matches: boolean }) => void) => void listeners.add(fn),
    removeEventListener: (_: "change", fn: (event: { matches: boolean }) => void) => void listeners.delete(fn),
  };
  return {
    matchMedia: (q: string) => {
      expect(q).toBe("(prefers-color-scheme: dark)");
      return query;
    },
    setDark(next: boolean) {
      query.matches = next;
      for (const fn of [...listeners]) fn({ matches: next });
    },
    listeners,
  };
}

describe("theme store", () => {
  it("applies the stored theme at once, and System when nothing valid is stored", () => {
    const map = new Map<string, string>([["thoth.theme", "dark"]]);
    createThemeStore(storageKey({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }, "thoth.theme"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("night");
    map.set("thoth.theme", "<script>");
    createThemeStore(storageKey({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }, "thoth.theme"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("system");
  });

  it("remembers a choice under one key that holds only the theme name", () => {
    const map = new Map<string, string>();
    const store = createThemeStore(storageKey({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }, "thoth.theme"));
    store.set("light");
    expect([...map.entries()]).toEqual([["thoth.theme", "light"]]);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    store.set("dark");
    expect([...map.entries()]).toEqual([["thoth.theme", "dark"]]);
  });

  it("keeps the choice for the session when storage throws", () => {
    const store = createThemeStore({ read: () => { throw new Error("denied"); }, write: () => { throw new Error("full"); } });
    expect(store.get()).toBe("system");
    store.set("dark");
    expect(store.get()).toBe("dark");
  });

  it("useTheme re-renders on set and cycleTheme goes Light → Dark → System", () => {
    const store = createThemeStore({ read: () => "light", write: () => undefined });
    const { result } = renderHook(() => useTheme(store));
    expect(result.current.theme).toBe("light");
    act(() => result.current.cycle());
    expect(result.current.theme).toBe("dark");
    act(() => result.current.cycle());
    expect(result.current.theme).toBe("system");
    expect(cycleTheme("system")).toBe("light");
  });

  it("applyTheme maps Dark to the tokens' night theme", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("night");
  });
});

describe("System", () => {
  it("resolves to the OS setting and follows it live", () => {
    const media = fakeMedia(false);
    expect(resolveTheme("system", media.matchMedia)).toBe("light");
    expect(resolveTheme("dark", media.matchMedia)).toBe("dark");
    const { result } = renderHook(() => useResolvedTheme("system", media.matchMedia));
    expect(result.current).toBe("light");
    act(() => media.setDark(true));
    expect(result.current).toBe("dark");
    act(() => media.setDark(false));
    expect(result.current).toBe("light");
  });

  it("ignores the OS when a theme is chosen, and stops listening on unmount", () => {
    const media = fakeMedia(true);
    const fixed = renderHook(() => useResolvedTheme("light", media.matchMedia));
    expect(fixed.result.current).toBe("light");
    expect(media.listeners.size).toBe(0);
    const system = renderHook(() => useResolvedTheme("system", media.matchMedia));
    expect(media.listeners.size).toBe(1);
    system.unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("watchSystemTheme reports changes", () => {
    const media = fakeMedia(false);
    const seen: boolean[] = [];
    const stop = watchSystemTheme((dark) => seen.push(dark), media.matchMedia);
    media.setDark(true);
    stop();
    media.setDark(false);
    expect(seen).toEqual([true]);
  });
});
