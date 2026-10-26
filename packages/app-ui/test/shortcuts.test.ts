import { describe, expect, it } from "vitest";
import {
  BROWSER_RESERVED,
  OS_RESERVED,
  SHORTCUTS,
  allShortcuts,
  chordFromKeymap,
  chordSignature,
  chordsFor,
  formatShortcut,
  matchesChord,
  registerShortcuts,
  reservedBy,
  shortcutById,
  shortcutFor,
  shortcutText,
  type Chord,
  type Client,
  type Platform,
  type ShortcutDef,
  type ShortcutScope,
} from "../src/keyboard/shortcuts.ts";
import { STYLE_SHORTCUTS, WEB_STYLE_SHORTCUTS, styleShortcuts } from "../src/keyboard/style-keys.ts";
import { en } from "../src/strings/en.ts";
import { th } from "../src/strings/th.ts";

const CLIENTS: Client[] = ["desktop", "web"];
const PLATFORMS: Platform[] = ["mac", "other"];

interface Placed {
  def: ShortcutDef;
  chord: Chord;
  sig: string;
}
const placed = (client: Client, platform: Platform, scopes?: ShortcutScope[]): Placed[] =>
  SHORTCUTS.filter((d) => !scopes || scopes.includes(d.scope)).flatMap((def) => chordsFor(def, client).map((chord) => ({ def, chord, sig: chordSignature(chord, platform) })));

/** A keydown for a chord, as the browser reports it. */
function eventFor(chord: Chord, platform: Platform) {
  return {
    key: chord.key ?? (chord.code === "Slash" ? "/" : chord.code === "Comma" ? "," : (chord.code ?? "").replace(/^(Key|Digit)/, "").toLowerCase()),
    code: chord.code ?? "",
    metaKey: chord.mod === true && platform === "mac",
    ctrlKey: chord.ctrl === true || (chord.mod === true && platform !== "mac"),
    altKey: chord.alt === true,
    shiftKey: chord.shift === true,
  };
}

describe("the shortcut table", () => {
  it.each(CLIENTS.flatMap((c) => PLATFORMS.map((p) => [c, p] as const)))("has no key pressed by two shortcuts that act in the same place (%s, %s)", (client, platform) => {
    // The global handler works over everything; a tree, an editor and a dialog each have their own keys.
    const seen = new Map<string, string>();
    for (const { def, sig } of placed(client, platform)) {
      const places = def.scope === "global" ? ["global", "tree", "tabs", "sidebar", "editor", "dialog"] : [def.scope];
      for (const place of places) {
        const key = `${place}:${sig}`;
        const other = seen.get(key);
        // One shortcut may list the same key twice (a key and a physical key); that is not two shortcuts.
        expect(other === undefined || other === def.id, `${sig} is on both ${other} and ${def.id}`).toBe(true);
        seen.set(key, def.id);
      }
    }
  });

  it("gives every shortcut a key (or says how it is typed) and a name in English and Thai", () => {
    const names = Object.keys(en.keyboard.names).sort();
    expect(Object.keys(th.keyboard.names).sort()).toEqual(names);
    expect(SHORTCUTS.map((d) => d.id).sort()).toEqual(names);
    for (const def of SHORTCUTS) {
      expect(def.desktop.length, def.id).toBeGreaterThan(0);
      expect(new Set(SHORTCUTS.map((d) => d.id)).size).toBe(SHORTCUTS.length);
    }
  });

  it.each(PLATFORMS)("keeps the web client off every key a browser keeps (%s)", (platform) => {
    for (const { def, chord } of placed("web", platform)) {
      expect(reservedBy(chord, BROWSER_RESERVED, platform)?.reason, `${def.id} (${chordSignature(chord, platform)}) is the browser's`).toBeUndefined();
    }
  });

  it.each(CLIENTS.flatMap((c) => PLATFORMS.map((p) => [c, p] as const)))("keeps both clients off every key the OS keeps (%s, %s)", (client, platform) => {
    for (const { def, chord } of placed(client, platform)) {
      expect(reservedBy(chord, OS_RESERVED, platform)?.reason, `${def.id} (${chordSignature(chord, platform)}) is the OS's`).toBeUndefined();
    }
  });

  it("has the web alternatives ADR-0016 rule 7 asks for, where the desktop uses a browser's key", () => {
    // The desktop keys that a browser keeps...
    const desktopTaken = placed("desktop", "other").filter(({ chord }) => reservedBy(chord, BROWSER_RESERVED, "other"));
    const ids = [...new Set(desktopTaken.map((p) => p.def.id))].sort();
    expect(ids).toEqual(["folder.new", "page.new", "style.link", "style.strike", "tab.close", "tab.jump", "tab.new", "tab.next", "tab.previous"]);
    // ...each have a different key on the web, and the list says so.
    for (const id of ids) {
      const def = shortcutById(id as never)!;
      expect(def.web, id).toBeDefined();
      expect(formatShortcut(def, "web", "other"), id).not.toBe(formatShortcut(def, "desktop", "other"));
    }
  });

  it("names Firefox's Ctrl+Shift+K and Ctrl+Shift+S as the browser's, and the web styles avoid them", () => {
    const k = { key: "k", mod: true, shift: true } satisfies Chord;
    const s = { key: "s", mod: true, shift: true } satisfies Chord;
    expect(reservedBy(k, BROWSER_RESERVED, "other")).toBeDefined();
    expect(reservedBy(s, BROWSER_RESERVED, "other")).toBeDefined();
    const web = styleShortcuts("web");
    expect(web.link).toEqual(["Mod-Alt-l"]);
    expect(web.strike).toEqual(["Mod-Alt-s"]);
    expect(styleShortcuts("desktop")).toBe(STYLE_SHORTCUTS);
    // Everything else about the styles is the same on both.
    for (const command of Object.keys(STYLE_SHORTCUTS) as (keyof typeof STYLE_SHORTCUTS)[]) {
      if (!(command in WEB_STYLE_SHORTCUTS)) expect(web[command]).toEqual(STYLE_SHORTCUTS[command]);
    }
  });

  it("lists the text styles from the editor's own table, and the tree keys", () => {
    const style = (id: string) => shortcutById(id as never)!;
    expect(style("style.highlight").desktop).toEqual([{ key: "h", mod: true, shift: true }]);
    expect(style("style.bold").desktop).toEqual([{ key: "b", mod: true }]);
    expect(style("style.strike").web).toEqual([{ code: "KeyS", mod: true, alt: true }]);
    expect(style("style.toolbar").desktop).toEqual([{ key: "F10", alt: true }, { code: "KeyT", mod: true, alt: true }]);
    for (const id of ["tree.move", "tree.expand", "tree.open", "tree.rename", "tree.reorder", "tree.menu", "tab.openNew"]) expect(shortcutById(id as never)?.scope, id).toBe("tree");
    expect(shortcutById("tree.rename" as never)!.desktop).toEqual([{ key: "F2" }]);
    expect(shortcutById("tree.reorder" as never)!.desktop).toEqual([
      { key: "ArrowUp", alt: true, shift: true },
      { key: "ArrowDown", alt: true, shift: true },
    ]);
  });

  it("moves a focused tab with Alt/Option+Shift+Left and Right, on both clients (ADR-0019)", () => {
    const def = shortcutById("tab.move" as never)!;
    expect(def.scope).toBe("tabs");
    expect(def.web).toBeUndefined(); // a browser keeps neither key
    expect(def.desktop).toEqual([
      { key: "ArrowLeft", alt: true, shift: true },
      { key: "ArrowRight", alt: true, shift: true },
    ]);
    expect(formatShortcut(def, "desktop", "mac")).toBe("Option+Shift+← / →");
    expect(formatShortcut(def, "web", "other")).toBe("Alt+Shift+← / →");
    expect(shortcutById("tab.menu" as never)!.scope).toBe("tabs");
  });

  it("reads Tiptap's notation", () => {
    expect(chordFromKeymap("Mod-Shift-s")).toEqual({ mod: true, shift: true, key: "s" });
    expect(chordFromKeymap("Mod-Alt-t")).toEqual({ mod: true, alt: true, code: "KeyT" });
    expect(chordFromKeymap("Alt-F10")).toEqual({ alt: true, key: "F10" });
    expect(chordFromKeymap("Mod-b")).toEqual({ mod: true, key: "b" });
  });
});

describe("matching a key press", () => {
  const press = (init: Partial<Parameters<typeof matchesChord>[0]>) => ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init });

  it("Mod is Cmd on a Mac and Ctrl elsewhere", () => {
    const chord: Chord = { key: "t", mod: true };
    expect(matchesChord(press({ key: "t", metaKey: true }), chord, "mac")).toBe(true);
    expect(matchesChord(press({ key: "t", ctrlKey: true }), chord, "mac")).toBe(false);
    expect(matchesChord(press({ key: "t", ctrlKey: true }), chord, "other")).toBe(true);
    expect(matchesChord(press({ key: "t", metaKey: true }), chord, "other")).toBe(true);
    expect(matchesChord(press({ key: "t", ctrlKey: true, metaKey: true }), chord, "other")).toBe(false);
  });

  it("Ctrl+Tab is Ctrl on a Mac too, and Shift makes it the other way round", () => {
    const next = shortcutById("tab.next")!;
    const hit = (e: object, platform: Platform) => shortcutFor(press({ key: "Tab", ...e }), "desktop", platform)?.id;
    expect(hit({ ctrlKey: true }, "mac")).toBe("tab.next");
    expect(hit({ ctrlKey: true }, "other")).toBe("tab.next");
    expect(hit({ ctrlKey: true, shiftKey: true }, "mac")).toBe("tab.previous");
    expect(hit({ metaKey: true }, "mac")).toBeUndefined();
    expect(chordsFor(next, "web")).toEqual([{ key: "PageDown", alt: true }]);
  });

  it("matches digits by physical key, so a layout that needs Shift for 1 still jumps", () => {
    expect(shortcutFor(press({ key: "&", code: "Digit1", ctrlKey: true }), "desktop", "other")).toEqual({ id: "tab.jump", digit: 1 });
    expect(shortcutFor(press({ key: "(", code: "Digit9", metaKey: true }), "desktop", "mac")).toEqual({ id: "tab.jump", digit: 9 });
    expect(shortcutFor(press({ key: "1", code: "Digit1", altKey: true }), "web", "other")).toEqual({ id: "tab.jump", digit: 1 });
    // On the web Ctrl+1 is the browser's.
    expect(shortcutFor(press({ key: "1", code: "Digit1", ctrlKey: true }), "web", "other")).toBeNull();
  });

  it("matches Option combinations by physical key, because Option changes the character on a Mac", () => {
    expect(shortcutFor(press({ key: "†", code: "KeyT", altKey: true }), "web", "mac")).toEqual({ id: "tab.new" });
    expect(shortcutFor(press({ key: "≤", code: "Comma", altKey: true }), "web", "mac")).toEqual({ id: "settings.open" });
  });

  it("takes / by key or by physical key", () => {
    expect(shortcutFor(press({ key: "/", code: "Slash", metaKey: true }), "desktop", "mac")?.id).toBe("shortcuts.open");
    expect(shortcutFor(press({ key: "é", code: "Slash", ctrlKey: true }), "desktop", "other")?.id).toBe("shortcuts.open");
  });

  it("never treats AltGr (Ctrl+Alt on Windows) as a shortcut", () => {
    const altGr = { ...press({ key: "ł", code: "KeyL", ctrlKey: true, altKey: true }), getModifierState: (k: string) => k === "AltGraph" };
    expect(matchesChord(altGr, { code: "KeyL", mod: true, alt: true }, "other")).toBe(false);
    expect(matchesChord({ ...altGr, getModifierState: () => false }, { code: "KeyL", mod: true, alt: true }, "other")).toBe(true);
  });

  it.each(CLIENTS.flatMap((c) => PLATFORMS.map((p) => [c, p] as const)))("finds every global shortcut by its own keys (%s, %s)", (client, platform) => {
    for (const def of SHORTCUTS.filter((d) => d.scope === "global")) {
      for (const chord of chordsFor(def, client)) {
        const hit = shortcutFor({ ...eventFor(chord, platform) }, client, platform);
        expect(hit?.id, `${def.id} ${chordSignature(chord, platform)}`).toBe(def.id);
      }
    }
  });
});

describe("writing keys down", () => {
  it("says Cmd and Option on a Mac, Ctrl and Alt elsewhere", () => {
    const page = shortcutById("page.new")!;
    expect(formatShortcut(page, "desktop", "mac")).toBe("Cmd+N");
    expect(formatShortcut(page, "desktop", "other")).toBe("Ctrl+N");
    expect(formatShortcut(page, "web", "mac")).toBe("Option+N");
    expect(formatShortcut(page, "web", "other")).toBe("Alt+N");
    expect(shortcutText("tab.new", "web", "other")).toBe("Alt+T");
    expect(shortcutText("tab.jump", "desktop", "mac")).toBe("Cmd+1–9");
    expect(shortcutText("tab.jump", "web", "other")).toBe("Alt+1–9");
    expect(shortcutText("tab.openNew", "web", "mac")).toBe("Cmd+click, middle-click, Cmd+Enter");
    expect(shortcutText("tab.next", "desktop", "mac")).toBe("Ctrl+Tab");
    expect(shortcutText("shortcuts.open", "desktop", "other")).toBe("Ctrl+/");
    expect(shortcutText("style.highlight", "web", "other")).toBe("Ctrl+Shift+H");
    expect(shortcutText("style.strike", "web", "other")).toBe("Ctrl+Alt+S");
  });

  it("lets other features add shortcuts, and take them away", () => {
    const extra: ShortcutDef = { id: "palette.open", group: "general", scope: "global", desktop: [{ key: "j", mod: true }] };
    const before = allShortcuts().length;
    const remove = registerShortcuts([extra]);
    expect(allShortcuts()).toHaveLength(before + 1);
    remove();
    expect(allShortcuts()).toHaveLength(before);
  });
});
