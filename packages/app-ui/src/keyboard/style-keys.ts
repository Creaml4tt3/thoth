/**
 * The keys of the text styles (ADR-0016 rule 1), with no editor in it: the Blocks editor binds them and the
 * shortcuts list (`shortcuts.ts`) reads them, so the two cannot drift apart.
 *
 * Written in Tiptap's notation (`Mod` is Cmd on macOS and Ctrl elsewhere).
 *
 * - Mod+K is not here: it opens search and the command palette, so the link field is Mod+Shift+K.
 * - Mod+S saves, so strikethrough is Mod+Shift+S (the same as Notion).
 * - Mod+Shift+H is highlight (ADR-0016 rule 2).
 * - Alt+F10 is the usual "go to the toolbar" key for editors; Mod+Alt+T is the same for keyboards where F10 is awkward.
 */

/** What a style shortcut can do. `link` opens the toolbar's link field and `toolbar` moves focus into the toolbar. */
export type StyleCommand = "bold" | "italic" | "underline" | "strike" | "inlineCode" | "highlight" | "link" | "toolbar";

/** The desktop app's keys. */
export const STYLE_SHORTCUTS: Readonly<Record<StyleCommand, readonly string[]>> = {
  bold: ["Mod-b"],
  italic: ["Mod-i"],
  underline: ["Mod-u"],
  strike: ["Mod-Shift-s"],
  inlineCode: ["Mod-e"],
  highlight: ["Mod-Shift-h"],
  link: ["Mod-Shift-k"],
  toolbar: ["Alt-F10", "Mod-Alt-t"],
};

/**
 * What the web client uses instead where the browser keeps the desktop's key (ADR-0016 rule 7). Firefox keeps
 * Ctrl+Shift+S (screenshots) and Ctrl+Shift+K (web console), so strikethrough and the link field move to
 * Mod+Alt+S and Mod+Alt+L. The shortcuts list says so.
 */
export const WEB_STYLE_SHORTCUTS: Readonly<Partial<Record<StyleCommand, readonly string[]>>> = {
  strike: ["Mod-Alt-s"],
  link: ["Mod-Alt-l"],
};

/** The style keys of a client: the web's overrides on top of the desktop's. */
export function styleShortcuts(client: "desktop" | "web"): Readonly<Record<StyleCommand, readonly string[]>> {
  return client === "web" ? { ...STYLE_SHORTCUTS, ...WEB_STYLE_SHORTCUTS } : STYLE_SHORTCUTS;
}
