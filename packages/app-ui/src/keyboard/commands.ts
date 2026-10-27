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
  /** Copy or move the open workspace page (and its sub-pages) to another workspace (ADR-0006, amendment of 2026-10-27). */
  copyToWorkspace?(): void;
  moveToWorkspace?(): void;
  /** A public read-only link to the open workspace page (ADR-0023): owners and editors on a server with `public-share`. */
  sharePage?(): void;
  /** The members of the open page's workspace (ADR-0024), on a server with `members`, named for the menu. */
  members?: { workspace: string; run(): void };
  /** A new workspace on a server with `workspace-management` (ADR-0025). */
  newWorkspace?(): void;
  /** The deleted workspaces the user can restore (ADR-0025). */
  deletedWorkspaces?(): void;
  /** Rename or delete the open page's workspace: owners, on a server with `workspace-management`, named for the menu. */
  renameWorkspace?: { workspace: string; run(): void };
  deleteWorkspace?: { workspace: string; run(): void };
  reorder?(delta: -1 | 1): void;
  /** Star or unstar the open page (ADR-0027); `on`: it is a favorite now. */
  favorite?: { on: boolean; run(): void };
  theme: { current: Theme; set(theme: Theme): void };
  openSettings(): void;
  /** Import from Notion or Obsidian (the desktop only): Settings, Import & Export, with the wizard started. */
  importPages?(): void;
  /** The Thoth assistant (the desktop only): its prompt bubble, its size, and its settings. */
  askAssistant?(): void;
  toggleAssistantSize?(): void;
  openAssistantSettings?(): void;
  /** Opens the notification list (the bell in the sidebar). */
  openNotifications?(): void;
  /** Home (ADR-0029): recent pages and favorites. */
  goHome?(): void;
  /** The first-run tour of the basic tools (the desktop only, ADR-0032), shown again. */
  showTour?(): void;
  /** Hides the whole sidebar (`hidden: false`) or shows it again. */
  sidebar?: { hidden: boolean; toggle(): void };
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
    /** Pin or unpin the current tab (ADR-0027); absent for an empty tab. */
    pin?: { pinned: boolean; run(): void };
    /** Close every tab but the current one and the pinned ones; absent when there is none to close. */
    closeOthers?(): void;
    /** Split view (ADR-0030): the current tab into a new right pane (one pane), or to the other pane (two). */
    split?(): void;
    moveToOtherPane?(): void;
    /** Focus the other pane; absent with one pane. */
    focusOtherPane?(): void;
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
  if (a.copyToWorkspace) add("page.copy-to-workspace", t.copyToWorkspace, a.copyToWorkspace, { keywords: "transfer duplicate other workspace server" });
  if (a.moveToWorkspace) add("page.move-to-workspace", t.moveToWorkspace, a.moveToWorkspace, { keywords: "transfer other workspace server" });
  if (a.sharePage) add("page.share", t.share, a.sharePage, { keywords: "public link publish url read-only" });
  if (a.members) add("workspace.members", t.members(a.members.workspace), a.members.run, { keywords: "people invite invitation share team role owner editor viewer leave remove" });
  if (a.newWorkspace) add("workspace.new", t.newWorkspace, a.newWorkspace, { keywords: "create add team space" });
  if (a.deletedWorkspaces) add("workspace.deleted", t.deletedWorkspaces, a.deletedWorkspaces, { keywords: "restore trash bin undo recover permanently" });
  if (a.renameWorkspace) add("workspace.rename", t.renameWorkspace(a.renameWorkspace.workspace), a.renameWorkspace.run, { keywords: "name title" });
  if (a.deleteWorkspace) add("workspace.delete", t.deleteWorkspace(a.deleteWorkspace.workspace), a.deleteWorkspace.run, { keywords: "remove trash" });
  if (a.reorder) {
    const reorder = a.reorder;
    // The table writes both keys as "Alt+Shift+↑ / ↓"; each command shows its own.
    const keys = shortcutText("tree.reorder", client, platform);
    add("page.moveUp", t.moveUp, () => reorder(-1), { shortcut: keys.replace("↑ / ↓", "↑"), keywords: "order reorder earlier" });
    add("page.moveDown", t.moveDown, () => reorder(1), { shortcut: keys.replace("↑ / ↓", "↓"), keywords: "order reorder later" });
  }
  if (a.favorite) add("page.favorite", a.favorite.on ? strings.favorites.remove : strings.favorites.add, a.favorite.run, { ...key("page.favorite"), keywords: "favourite favorite star bookmark pin sidebar" });
  for (const theme of THEMES) add(`theme.${theme}`, t.theme(strings.theme[theme]), () => a.theme.set(theme), { keywords: `appearance colour mode ${theme === "dark" ? "night" : ""}`.trim() });
  add("settings.open", t.settings, a.openSettings, { ...key("settings.open"), keywords: "preferences" });
  if (a.importPages) add("import.open", t.importPages, a.importPages, { keywords: "notion obsidian import bring markdown zip export" });
  if (a.askAssistant) add("assistant.ask", t.ask, a.askAssistant, { ...key("assistant.ask"), keywords: "agent ai claude codex assistant mascot ibis prompt" });
  if (a.toggleAssistantSize) add("assistant.size", t.assistantSize, a.toggleAssistantSize, { ...key("assistant.size"), keywords: "mascot compact full small big" });
  if (a.openAssistantSettings) add("assistant.settings", t.assistantSettings, a.openAssistantSettings, { keywords: "agent hub ai claude codex history usage permissions mascot preferences" });
  if (a.openNotifications) add("notifications.open", t.notifications, a.openNotifications, { keywords: "bell notification unread alerts done failed" });
  if (a.goHome) add("home.open", t.goHome, a.goHome, { ...key("home.open"), keywords: "home start recent favorites dashboard" });
  if (a.showTour) add("tour.show", t.showTour, a.showTour, { keywords: "tour help guide welcome getting started onboarding tips" });
  if (a.sidebar) add("sidebar.toggle", a.sidebar.hidden ? t.showSidebar : t.hideSidebar, a.sidebar.toggle, { ...key("sidebar.toggle"), keywords: "sidebar collapse expand hide show panel focus full width" });
  add("tab.new", t.newTab, a.tabs.newTab, key("tab.new"));
  add("tab.close", t.closeTab, a.tabs.closeTab, key("tab.close"));
  add("tab.next", t.nextTab, a.tabs.next, key("tab.next"));
  add("tab.previous", t.previousTab, a.tabs.previous, key("tab.previous"));
  // The table writes both keys as "Alt+Shift+← / →"; each command shows its own.
  const tabKeys = shortcutText("tab.move", client, platform);
  if (a.tabs.moveLeft) add("tab.moveLeft", t.moveTabLeft, a.tabs.moveLeft, { shortcut: tabKeys.replace("← / →", "←"), keywords: "reorder order earlier" });
  if (a.tabs.moveRight) add("tab.moveRight", t.moveTabRight, a.tabs.moveRight, { shortcut: tabKeys.replace("← / →", "→"), keywords: "reorder order later" });
  if (a.tabs.pin) add("tab.pin", a.tabs.pin.pinned ? strings.tabs.unpin : strings.tabs.pin, a.tabs.pin.run, { ...key("tab.pin"), keywords: "pin keep stick tab" });
  if (a.tabs.closeOthers) add("tab.closeOthers", strings.tabs.closeOthers, a.tabs.closeOthers, { keywords: "close tabs others all" });
  if (a.tabs.moveToWindow) add("tab.moveToWindow", t.moveTabToWindow, a.tabs.moveToWindow, { keywords: "window detach tear off split" });
  if (a.tabs.split) add("tab.split", strings.tabs.splitRight, a.tabs.split, { ...key("tab.split"), keywords: "split pane side by side right editor group view" });
  if (a.tabs.moveToOtherPane) add("tab.otherPane", strings.tabs.moveToOtherPane, a.tabs.moveToOtherPane, { ...key("tab.split"), keywords: "split pane side move left right" });
  if (a.tabs.focusOtherPane) add("pane.focusOther", t.focusOtherPane, a.tabs.focusOtherPane, { ...key("pane.focusOther"), keywords: "split pane switch focus left right" });
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
