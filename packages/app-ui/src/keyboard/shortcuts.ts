/**
 * Every keyboard shortcut of the desktop app and the web client, in one table (ADR-0016 rule 7). The global
 * handler (`useShortcuts`) and the shortcuts list (`ShortcutsDialog`) both read it, so the list cannot drift from
 * what the keys do. The text styles read their keys from `style-keys.ts`, which the Blocks editor binds too.
 *
 * A browser keeps some keys for itself (Cmd/Ctrl+T, W, N and 1–9 and Ctrl+Tab belong to its own tabs and
 * windows; Firefox keeps Ctrl+Shift+K and Ctrl+Shift+S), so the web client binds an alternative there and the
 * list says so. Nothing takes keys the OS keeps (Cmd+Q, Cmd+H, Alt+F4). `BROWSER_RESERVED` and `OS_RESERVED`
 * name those keys, and a test checks that no shortcut is on them.
 *
 * One thing this file cannot promise: a key in the table is bound in the page, but the desktop shell's native
 * menu (macOS "Close Window" is Cmd+W) is outside it.
 */
import { STYLE_SHORTCUTS, WEB_STYLE_SHORTCUTS, type StyleCommand } from "./style-keys.ts";

export type Client = "desktop" | "web";
export type Platform = "mac" | "other";

/**
 * One key combination. `mod` is Cmd on macOS and Ctrl elsewhere; `ctrl` is Ctrl everywhere (Ctrl+Tab is Ctrl on a
 * Mac too). `code` matches the physical key (`Digit1`, `Comma`, `KeyN`), so Option on a Mac, which changes the
 * character, and layouts that need Shift for a digit still match.
 */
export interface Chord {
  key?: string;
  code?: string;
  mod?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export type ShortcutId =
  | "palette.open"
  | "shortcuts.open"
  | "settings.open"
  | "page.new"
  | "folder.new"
  | "theme.cycle"
  | "tab.new"
  | "tab.close"
  | "tab.next"
  | "tab.previous"
  | "tab.jump"
  | "tab.openNew"
  | "tree.move"
  | "tree.expand"
  | "tree.open"
  | "tree.rename"
  | "tree.reorder"
  | "tree.menu"
  | "editor.save"
  | "editor.mode"
  | "editor.blockMenu"
  | "editor.blockMove"
  | "style.bold"
  | "style.italic"
  | "style.underline"
  | "style.strike"
  | "style.code"
  | "style.highlight"
  | "style.link"
  | "style.toolbar"
  | "dialog.close";

export type ShortcutGroup = "general" | "tabs" | "tree" | "editor";

/**
 * Who acts on the key. "global": `useShortcuts` (the app passes the handlers). "tree", "editor" and "dialog": the
 * focused tree, editor or dialog handles it itself; the entry is here so the list shows it and the tests see it.
 */
export type ShortcutScope = "global" | "tree" | "editor" | "dialog";

export interface ShortcutDef {
  id: ShortcutId;
  group: ShortcutGroup;
  scope: ShortcutScope;
  /** Key combinations on the desktop. A list means any of them. */
  desktop: readonly Chord[];
  /** Omitted: the same as on the desktop. */
  web?: readonly Chord[];
  /** How the keys are written in the list when they are not a plain chord (for example "Cmd/Ctrl+click"). */
  display?: { desktop?: string; web?: string };
}

const DIGITS = Array.from({ length: 9 }, (_, i) => `Digit${i + 1}`);

/** `Mod-Shift-s` (Tiptap's notation) as a chord. Letters with Alt are matched by physical key: Option changes the character on a Mac. */
export function chordFromKeymap(notation: string): Chord {
  const parts = notation.split("-");
  const name = parts.pop() ?? "";
  const chord: { -readonly [K in keyof Chord]: Chord[K] } = {};
  for (const part of parts) {
    if (part === "Mod") chord.mod = true;
    else if (part === "Ctrl") chord.ctrl = true;
    else if (part === "Alt") chord.alt = true;
    else if (part === "Shift") chord.shift = true;
  }
  if (chord.alt && /^[a-z]$/i.test(name)) chord.code = `Key${name.toUpperCase()}`;
  else chord.key = name;
  return chord;
}

const styleDef = (id: ShortcutId, command: StyleCommand): ShortcutDef => ({
  id,
  group: "editor",
  scope: "editor",
  desktop: STYLE_SHORTCUTS[command].map(chordFromKeymap),
  ...(WEB_STYLE_SHORTCUTS[command] ? { web: WEB_STYLE_SHORTCUTS[command].map(chordFromKeymap) } : {}),
});

export const SHORTCUTS: readonly ShortcutDef[] = [
  // Everywhere
  { id: "palette.open", group: "general", scope: "global", desktop: [{ key: "k", mod: true }] },
  { id: "shortcuts.open", group: "general", scope: "global", desktop: [{ key: "/", mod: true }, { code: "Slash", mod: true }] },
  { id: "settings.open", group: "general", scope: "global", desktop: [{ code: "Comma", mod: true }], web: [{ code: "Comma", alt: true }] },
  { id: "page.new", group: "general", scope: "global", desktop: [{ key: "n", mod: true }], web: [{ code: "KeyN", alt: true }] },
  { id: "folder.new", group: "general", scope: "global", desktop: [{ key: "n", mod: true, shift: true }], web: [{ code: "KeyN", alt: true, shift: true }] },
  { id: "theme.cycle", group: "general", scope: "global", desktop: [{ key: "l", mod: true, shift: true }] },
  { id: "dialog.close", group: "general", scope: "dialog", desktop: [{ key: "Escape" }] },

  // Tabs
  { id: "tab.new", group: "tabs", scope: "global", desktop: [{ key: "t", mod: true }], web: [{ code: "KeyT", alt: true }] },
  { id: "tab.close", group: "tabs", scope: "global", desktop: [{ key: "w", mod: true }], web: [{ code: "KeyW", alt: true }] },
  { id: "tab.next", group: "tabs", scope: "global", desktop: [{ key: "Tab", ctrl: true }], web: [{ key: "PageDown", alt: true }] },
  { id: "tab.previous", group: "tabs", scope: "global", desktop: [{ key: "Tab", ctrl: true, shift: true }], web: [{ key: "PageUp", alt: true }] },
  {
    id: "tab.jump",
    group: "tabs",
    scope: "global",
    desktop: DIGITS.map((code) => ({ code, mod: true })),
    web: DIGITS.map((code) => ({ code, alt: true })),
    display: { desktop: "Cmd/Ctrl+1–9", web: "Alt+1–9" },
  },
  { id: "tab.openNew", group: "tabs", scope: "tree", desktop: [{ key: "Enter", mod: true }], display: { desktop: "Cmd/Ctrl+click, middle-click, Cmd/Ctrl+Enter" } },

  // The page trees
  { id: "tree.move", group: "tree", scope: "tree", desktop: [{ key: "ArrowUp" }, { key: "ArrowDown" }, { key: "Home" }, { key: "End" }], display: { desktop: "↑ ↓ Home End" } },
  { id: "tree.expand", group: "tree", scope: "tree", desktop: [{ key: "ArrowRight" }, { key: "ArrowLeft" }], display: { desktop: "→ ←" } },
  { id: "tree.open", group: "tree", scope: "tree", desktop: [{ key: "Enter" }, { key: " " }], display: { desktop: "Enter / Space" } },
  { id: "tree.rename", group: "tree", scope: "tree", desktop: [{ key: "F2" }] },
  { id: "tree.reorder", group: "tree", scope: "tree", desktop: [{ key: "ArrowUp", alt: true, shift: true }, { key: "ArrowDown", alt: true, shift: true }], display: { desktop: "Alt+Shift+↑ / ↓" } },
  { id: "tree.menu", group: "tree", scope: "tree", desktop: [{ key: "ContextMenu" }, { key: "F10", shift: true }], display: { desktop: "Menu key / Shift+F10" } },

  // The editor
  { id: "editor.save", group: "editor", scope: "editor", desktop: [{ key: "s", mod: true }] },
  { id: "editor.mode", group: "editor", scope: "editor", desktop: [{ key: "e", mod: true, shift: true }] },
  { id: "editor.blockMenu", group: "editor", scope: "editor", desktop: [{ code: "KeyM", mod: true, alt: true }] },
  { id: "editor.blockMove", group: "editor", scope: "editor", desktop: [{ key: "ArrowUp", alt: true, shift: true }, { key: "ArrowDown", alt: true, shift: true }], display: { desktop: "Alt+Shift+↑ / ↓" } },
  styleDef("style.bold", "bold"),
  styleDef("style.italic", "italic"),
  styleDef("style.underline", "underline"),
  styleDef("style.strike", "strike"),
  styleDef("style.code", "inlineCode"),
  styleDef("style.highlight", "highlight"),
  styleDef("style.link", "link"),
  styleDef("style.toolbar", "toolbar"),
];

/** Shortcuts added by other features. Same rules as `SHORTCUTS`. Returns the remover. */
const extra: ShortcutDef[] = [];
export function registerShortcuts(defs: readonly ShortcutDef[]): () => void {
  extra.push(...defs);
  return () => {
    for (const def of defs) {
      const at = extra.indexOf(def);
      if (at >= 0) extra.splice(at, 1);
    }
  };
}

export function allShortcuts(): readonly ShortcutDef[] {
  return extra.length === 0 ? SHORTCUTS : [...SHORTCUTS, ...extra];
}

export const shortcutById = (id: ShortcutId): ShortcutDef | undefined => allShortcuts().find((s) => s.id === id);

export function chordsFor(def: ShortcutDef, client: Client): readonly Chord[] {
  return client === "web" && def.web ? def.web : def.desktop;
}

export function currentPlatform(userAgent: string = globalThis.navigator?.userAgent ?? ""): Platform {
  return /Mac OS X|Macintosh|iPhone|iPad/.test(userAgent) ? "mac" : "other";
}

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & { getModifierState?(key: string): boolean };

export function matchesChord(event: KeyLike, chord: Chord, platform: Platform): boolean {
  if (chord.mod === true && platform !== "mac") {
    // Ctrl is the Mod key here. Meta (the Windows or Super key) is tolerated in its place, because the OS keeps
    // those combinations and a page that sees one has no other meaning for it; but never both at once.
    if (event.ctrlKey === event.metaKey) return false;
  } else {
    const wantMeta = chord.mod === true && platform === "mac";
    if (event.metaKey !== wantMeta || event.ctrlKey !== (chord.ctrl === true)) return false;
  }
  if (event.altKey !== (chord.alt === true) || event.shiftKey !== (chord.shift === true)) return false;
  // Ctrl+Alt is how Windows reports AltGr, which types characters on many layouts: never a shortcut.
  if (event.ctrlKey && event.altKey && event.getModifierState?.("AltGraph")) return false;
  if (chord.code !== undefined) return event.code === chord.code;
  return chord.key !== undefined && event.key.toLowerCase() === chord.key.toLowerCase();
}

/** The shortcut `event` triggers among those of `scope`, and for `tab.jump` the digit. */
export function shortcutFor(event: KeyLike, client: Client, platform: Platform, scope: ShortcutScope = "global"): { id: ShortcutId; digit?: number } | null {
  for (const def of allShortcuts()) {
    if (def.scope !== scope) continue;
    for (const chord of chordsFor(def, client)) {
      if (!matchesChord(event, chord, platform)) continue;
      const digit = chord.code?.startsWith("Digit") ? Number(chord.code.slice(5)) : undefined;
      return digit === undefined ? { id: def.id } : { id: def.id, digit };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Keys that are not ours to take

/** A key combination that belongs to somebody else, and why. */
export interface Reserved extends Chord {
  reason: string;
  /** Only on this platform; omitted: on both. */
  platform?: Platform;
}

/**
 * Keys a browser keeps for itself, and a page cannot (or must not) take. The web client binds none of them; where
 * the desktop uses one, the web has an alternative. Firefox's Ctrl+Shift+K and Ctrl+Shift+S are the ones the text
 * styles used to need.
 */
export const BROWSER_RESERVED: readonly Reserved[] = [
  { key: "t", mod: true, reason: "New browser tab" },
  { key: "w", mod: true, reason: "Close browser tab" },
  { key: "n", mod: true, reason: "New browser window" },
  { key: "n", mod: true, shift: true, reason: "New private window" },
  { key: "t", mod: true, shift: true, reason: "Reopen closed tab" },
  { key: "w", mod: true, shift: true, reason: "Close browser window" },
  { key: "p", mod: true, shift: true, reason: "Private window (Firefox)" },
  ...DIGITS.map((code): Reserved => ({ code, mod: true, reason: "Jump to browser tab" })),
  { key: "Tab", ctrl: true, reason: "Next browser tab" },
  { key: "Tab", ctrl: true, shift: true, reason: "Previous browser tab" },
  { key: "PageDown", ctrl: true, reason: "Next browser tab" },
  { key: "PageUp", ctrl: true, reason: "Previous browser tab" },
  { key: "k", mod: true, shift: true, reason: "Web console (Firefox)" },
  { key: "s", mod: true, shift: true, reason: "Screenshots (Firefox)" },
  { key: "r", mod: true, reason: "Reload" },
  { key: "l", mod: true, reason: "Address bar" },
  { key: "F5", reason: "Reload" },
  { key: "F11", reason: "Full screen" },
  { key: "F12", reason: "Developer tools" },
];

/** Keys the operating system keeps. Neither client binds them. */
export const OS_RESERVED: readonly Reserved[] = [
  { key: "q", mod: true, platform: "mac", reason: "Quit" },
  { key: "h", mod: true, platform: "mac", reason: "Hide the app" },
  { key: "m", mod: true, platform: "mac", reason: "Minimise" },
  { key: "Tab", mod: true, platform: "mac", reason: "Switch app" },
  { key: " ", mod: true, platform: "mac", reason: "Spotlight" },
  { key: "F4", alt: true, platform: "other", reason: "Close window" },
  { key: "Tab", alt: true, platform: "other", reason: "Switch app" },
  { key: "Escape", ctrl: true, platform: "other", reason: "Start menu" },
  { key: "Delete", ctrl: true, alt: true, platform: "other", reason: "Security screen" },
];

const CODE_NAMES: Record<string, string> = { Comma: ",", Slash: "/", Period: ".", Space: " " };

/** A chord reduced to what it presses, so two spellings of the same keys compare equal. */
export function chordSignature(chord: Chord, platform: Platform): string {
  const meta = chord.mod === true && platform === "mac";
  const ctrl = chord.ctrl === true || (chord.mod === true && platform !== "mac");
  let name = (chord.key ?? "").toLowerCase();
  if (chord.code !== undefined) name = (CODE_NAMES[chord.code] ?? chord.code.replace(/^(Key|Digit)/, "")).toLowerCase();
  return `${meta ? "meta+" : ""}${ctrl ? "ctrl+" : ""}${chord.alt ? "alt+" : ""}${chord.shift ? "shift+" : ""}${name}`;
}

/** The entry of `list` that `chord` presses on `platform`, if any. */
export function reservedBy(chord: Chord, list: readonly Reserved[], platform: Platform): Reserved | undefined {
  const mine = chordSignature(chord, platform);
  return list.find((r) => (r.platform === undefined || r.platform === platform) && chordSignature(r, platform) === mine);
}

// ---------------------------------------------------------------------------
// Writing keys down

const KEY_NAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", PageDown: "Page Down", PageUp: "Page Up", " ": "Space", ContextMenu: "Menu" };

/** "Cmd+Shift+N" on a Mac, "Ctrl+Shift+N" elsewhere. */
export function formatChord(chord: Chord, platform: Platform): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.mod) parts.push(platform === "mac" ? "Cmd" : "Ctrl");
  if (chord.alt) parts.push(platform === "mac" ? "Option" : "Alt");
  if (chord.shift) parts.push("Shift");
  const key = chord.code !== undefined ? (CODE_NAMES[chord.code] ?? chord.code.replace(/^(Key|Digit)/, "")) : (chord.key ?? "");
  parts.push(KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key));
  return parts.join("+");
}

/** How a shortcut is written in the list and in the palette, for this client and platform. */
export function formatShortcut(def: ShortcutDef, client: Client, platform: Platform): string {
  const display = client === "web" ? (def.display?.web ?? (def.web ? undefined : def.display?.desktop)) : def.display?.desktop;
  if (display !== undefined) return platform === "mac" ? display.replace(/Cmd\/Ctrl/g, "Cmd").replace(/\bAlt\b/g, "Option") : display.replace(/Cmd\/Ctrl/g, "Ctrl");
  // `/` is listed twice (by key and by physical key) so it works on other layouts; show each spelling once.
  const shown = [...new Set(chordsFor(def, client).map((c) => formatChord(c, platform)))];
  return shown.join(" / ");
}

/** The first shortcut of `id` as text, for a menu or the palette; "" when there is none. */
export function shortcutText(id: ShortcutId, client: Client, platform: Platform): string {
  const def = shortcutById(id);
  return def ? formatShortcut(def, client, platform) : "";
}

const MAC_SYMBOLS: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", " ": "Space", Comma: ",", Slash: "/" };

/** "⌘⇧N" on a Mac (the symbols a Mac menu uses), "Ctrl+Shift+N" elsewhere: one chord, short enough for a tooltip. */
export function formatChordShort(chord: Chord, platform: Platform): string {
  if (platform !== "mac") return formatChord(chord, platform);
  const key = chord.code !== undefined ? (CODE_NAMES[chord.code] ?? chord.code.replace(/^(Key|Digit)/, "")) : (chord.key ?? "");
  const name = MAC_SYMBOLS[key] ?? (key.length === 1 ? key.toUpperCase() : (KEY_NAMES[key] ?? key));
  return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.mod ? "⌘" : ""}${name}`;
}

/** The `aria-keyshortcuts` value of a chord: "Meta+Shift+N" on a Mac, "Control+Shift+N" elsewhere. */
export function ariaKeyShortcut(chord: Chord, platform: Platform): string {
  const parts: string[] = [];
  if (chord.ctrl || (chord.mod && platform !== "mac")) parts.push("Control");
  if (chord.mod && platform === "mac") parts.push("Meta");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  const key = chord.code !== undefined ? (CODE_NAMES[chord.code] ?? chord.code.replace(/^(Key|Digit)/, "")) : (chord.key ?? "");
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join("+");
}

/** What an icon button shows beside its name and announces: the first key combination of `id`, or nothing when it has none. */
export function shortcutHint(id: ShortcutId, client: Client, platform: Platform): { keys: string; aria: string } | null {
  const def = shortcutById(id);
  const chord = def ? chordsFor(def, client)[0] : undefined;
  return chord ? { keys: formatChordShort(chord, platform), aria: ariaKeyShortcut(chord, platform) } : null;
}

/** True when the web client binds other keys than the desktop for this shortcut (the list says so). */
export const differsOnWeb = (def: ShortcutDef): boolean => def.web !== undefined;
