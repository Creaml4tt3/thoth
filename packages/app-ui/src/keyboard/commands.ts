/**
 * The commands of the palette (Cmd/Ctrl+K, then `>`), ADR-0016 rule 7. The app says what it can do right now
 * (`CommandActions`: an action that is missing means the command is not offered), and `buildCommands` turns that into
 * a list with names in the UI language and each command's shortcut, read from the shortcut table. Nothing here
 * touches the DOM, so the list and the filter are tested on their own.
 */
import type { TextColor } from "@thoth/editor";
import { TEXT_COLORS } from "@thoth/editor";
import type { Strings } from "../strings/en.ts";
import type { Theme } from "../ui/theme.ts";
import { THEMES } from "../ui/theme.ts";
import type { FormatCommand } from "./editor-actions.ts";
import { shortcutText, type Client, type Platform, type ShortcutId } from "./shortcuts.ts";

export interface Command {
  id: string;
  /** The name shown and searched. */
  title: string;
  /** Its shortcut as text, if it has one. */
  shortcut?: string;
  /** More words that find it (not shown). */
  keywords?: string;
  run(): void;
}

/** What the app can do at this moment. Leave out what does not apply (no open page: no rename). */
export interface CommandActions {
  /** A new page where the app creates them (the Private Space on the desktop, the workspace on the web). */
  newPage?(): void;
  /** A new page in the workspace of the open page, named for the menu (the desktop, when a workspace page is open). */
  newWorkspacePage?: { workspace: string; run(): void };
  /** A new folder where the app creates them (the Private Space on the desktop), or in the workspace named (the web). */
  newFolder?: { workspace?: string; run(): void };
  /** A new folder in the workspace of the open page, named for the menu (the desktop, when a workspace page is open). */
  newWorkspaceFolder?: { workspace: string; run(): void };
  rename?(): void;
  moveTo?(): void;
  reorder?(delta: -1 | 1): void;
  theme: { current: Theme; set(theme: Theme): void };
  openSettings(): void;
  /** The Thoth assistant (the desktop only): its prompt bubble, its size, and its settings. */
  askAssistant?(): void;
  toggleAssistantSize?(): void;
  openAssistantSettings?(): void;
  /** Opens the notification list (the bell in the sidebar). */
  openNotifications?(): void;
  tabs: {
    newTab(): void;
    closeTab(): void;
    next(): void;
    previous(): void;
    list: readonly { id: string; label: string }[];
    active: string;
    goTo(id: string): void;
    /** The current tab one place along (ADR-0019); absent at that end of the bar. */
    moveLeft?(): void;
    moveRight?(): void;
    /** The current tab into a new window (the desktop only, and not a window's only tab). */
    moveToWindow?(): void;
  };
  toggleMode?(): void;
  showShortcuts(): void;
  /** Present when text is selected and may be styled. */
  format?(command: FormatCommand): void;
}

export function buildCommands(a: CommandActions, strings: Strings, client: Client, platform: Platform): Command[] {
  const t = strings.keyboard.commands;
  const key = (id: ShortcutId): { shortcut?: string } => {
    const text = shortcutText(id, client, platform);
    return text ? { shortcut: text } : {};
  };
  const out: Command[] = [];
  const add = (id: string, title: string, run: () => void, extra: Omit<Command, "id" | "title" | "run"> = {}) => void out.push({ id, title, run, ...extra });

  if (a.newPage) add("page.new", t.newPage, a.newPage, { ...key("page.new"), keywords: "create add" });
  if (a.newWorkspacePage) add("page.newWorkspace", t.newPageIn(a.newWorkspacePage.workspace), a.newWorkspacePage.run, { keywords: "create add workspace" });
  if (a.newFolder) add("folder.new", a.newFolder.workspace ? t.newFolderIn(a.newFolder.workspace) : t.newFolder, a.newFolder.run, { ...key("folder.new"), keywords: "create add" });
  if (a.newWorkspaceFolder) add("folder.newWorkspace", t.newFolderIn(a.newWorkspaceFolder.workspace), a.newWorkspaceFolder.run, { keywords: "create add workspace" });
  if (a.rename) add("page.rename", t.rename, a.rename, { ...key("tree.rename"), keywords: "name title" });
  if (a.moveTo) add("page.moveTo", t.moveTo, a.moveTo, { keywords: "folder nest" });
  if (a.reorder) {
    const reorder = a.reorder;
    // The table writes both keys as "Alt+Shift+↑ / ↓"; each command shows its own.
    const keys = shortcutText("tree.reorder", client, platform);
    add("page.moveUp", t.moveUp, () => reorder(-1), { shortcut: keys.replace("↑ / ↓", "↑"), keywords: "order reorder earlier" });
    add("page.moveDown", t.moveDown, () => reorder(1), { shortcut: keys.replace("↑ / ↓", "↓"), keywords: "order reorder later" });
  }
  for (const theme of THEMES) add(`theme.${theme}`, t.theme(strings.theme[theme]), () => a.theme.set(theme), { keywords: `appearance colour mode ${theme === "dark" ? "night" : ""}`.trim() });
  add("settings.open", t.settings, a.openSettings, { ...key("settings.open"), keywords: "preferences" });
  if (a.askAssistant) add("assistant.ask", t.ask, a.askAssistant, { ...key("assistant.ask"), keywords: "agent ai claude codex assistant mascot ibis prompt" });
  if (a.toggleAssistantSize) add("assistant.size", t.assistantSize, a.toggleAssistantSize, { ...key("assistant.size"), keywords: "mascot compact full small big" });
  if (a.openAssistantSettings) add("assistant.settings", t.assistantSettings, a.openAssistantSettings, { keywords: "agent hub ai claude codex history usage permissions mascot preferences" });
  if (a.openNotifications) add("notifications.open", t.notifications, a.openNotifications, { keywords: "bell notification unread alerts done failed" });
  add("tab.new", t.newTab, a.tabs.newTab, key("tab.new"));
  add("tab.close", t.closeTab, a.tabs.closeTab, key("tab.close"));
  add("tab.next", t.nextTab, a.tabs.next, key("tab.next"));
  add("tab.previous", t.previousTab, a.tabs.previous, key("tab.previous"));
  // The table writes both keys as "Alt+Shift+← / →"; each command shows its own.
  const tabKeys = shortcutText("tab.move", client, platform);
  if (a.tabs.moveLeft) add("tab.moveLeft", t.moveTabLeft, a.tabs.moveLeft, { shortcut: tabKeys.replace("← / →", "←"), keywords: "reorder order earlier" });
  if (a.tabs.moveRight) add("tab.moveRight", t.moveTabRight, a.tabs.moveRight, { shortcut: tabKeys.replace("← / →", "→"), keywords: "reorder order later" });
  if (a.tabs.moveToWindow) add("tab.moveToWindow", t.moveTabToWindow, a.tabs.moveToWindow, { keywords: "window detach tear off split" });
  a.tabs.list.forEach((tab, index) => {
    if (tab.id !== a.tabs.active) add(`tab.go.${tab.id}`, t.goToTab(tab.label), () => a.tabs.goTo(tab.id), { keywords: `switch tab ${index + 1}` });
  });
  if (a.toggleMode) add("editor.mode", t.toggleMode, a.toggleMode, { ...key("editor.mode"), keywords: "plain blocks markdown editor" });
  add("shortcuts.open", t.shortcuts, a.showShortcuts, { ...key("shortcuts.open"), keywords: "keys keyboard help" });

  if (a.format) {
    const format = a.format;
    const s = strings.editor.styles;
    const styles: [FormatCommand, string, ShortcutId | null][] = [
      ["bold", s.bold, "style.bold"],
      ["italic", s.italic, "style.italic"],
      ["underline", s.underline, "style.underline"],
      ["strike", s.strike, "style.strike"],
      ["inlineCode", s.code, "style.code"],
      ["highlight", s.highlight, "style.highlight"],
      ["link", s.link, "style.link"],
    ];
    for (const [command, name, shortcut] of styles) add(`format.${typeof command === "string" ? command : "color"}`, t.format(name), () => format(command), { ...(shortcut ? key(shortcut) : {}), keywords: "text style selection" });
    const colors: (TextColor | null)[] = [null, ...TEXT_COLORS];
    for (const color of colors) add(`format.color.${color ?? "default"}`, t.color(s.colorNames[color ?? "default"]), () => format({ color }), { keywords: "text style selection colour" });
  }
  return out;
}

export const COMMAND_PREFIX = ">";

/** True when the text typed in the palette asks for commands (it starts with `>`). */
export const isCommandQuery = (query: string): boolean => query.trimStart().startsWith(COMMAND_PREFIX);

/** What follows the `>`. */
export const commandText = (query: string): string => query.trimStart().slice(COMMAND_PREFIX.length).trim();

const fold = (text: string): string => text.toLocaleLowerCase();

/**
 * The commands that match what was typed after the `>`: every word must appear in the name or the keywords. Names
 * that start with the first word come first, then names that contain it, then keyword matches; the list's own order
 * breaks ties.
 */
export function filterCommands(query: string, commands: readonly Command[]): Command[] {
  const words = fold(commandText(query)).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];
  const ranked: { command: Command; rank: number; at: number }[] = [];
  commands.forEach((command, at) => {
    const title = fold(command.title);
    const haystack = `${title} ${fold(command.keywords ?? "")}`;
    if (!words.every((w) => haystack.includes(w))) return;
    const first = words[0]!;
    const rank = title.startsWith(first) ? 0 : title.split(/[\s:]+/).some((w) => w.startsWith(first)) ? 1 : title.includes(first) ? 2 : 3;
    ranked.push({ command, rank, at });
  });
  return ranked.sort((x, y) => x.rank - y.rank || x.at - y.at).map((r) => r.command);
}
