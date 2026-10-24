import { describe, expect, it, vi } from "vitest";
import { buildCommands, commandText, filterCommands, isCommandQuery, type CommandActions } from "../src/keyboard/commands.ts";
import { THEMES } from "../src/ui/theme.ts";
import { en } from "../src/strings/en.ts";
import { th } from "../src/strings/th.ts";

/** Actions that record what they were asked to do. */
function spies() {
  const log: string[] = [];
  const say = (name: string) => vi.fn((...args: unknown[]) => void log.push([name, ...args.map(String)].join(" ")));
  const actions = {
    newPage: say("newPage"),
    rename: say("rename"),
    moveTo: say("moveTo"),
    reorder: say("reorder"),
    theme: { current: "system" as const, set: say("theme") },
    openSettings: say("openSettings"),
    tabs: {
      newTab: say("newTab"),
      closeTab: say("closeTab"),
      next: say("nextTab"),
      previous: say("previousTab"),
      list: [
        { id: "t1", label: "Alpha" },
        { id: "t2", label: "Beta" },
        { id: "t3", label: "Settings" },
      ],
      active: "t1",
      goTo: say("goTo"),
    },
    toggleMode: say("toggleMode"),
    showShortcuts: say("showShortcuts"),
  } satisfies CommandActions;
  return { actions, log };
}

const titles = (list: readonly { title: string }[]) => list.map((c) => c.title);
const find = (list: ReturnType<typeof buildCommands>, id: string) => list.find((c) => c.id === id);

describe("New folder", () => {
  it("is offered with its shortcut, and the workspace one is a second command without one", () => {
    const { actions, log } = spies();
    const both: CommandActions = { ...actions, newFolder: { run: vi.fn(() => void log.push("newFolder")) }, newWorkspaceFolder: { workspace: "Design", run: vi.fn(() => void log.push("newWorkspaceFolder")) } };
    const list = buildCommands(both, en, "desktop", "mac");
    expect(titles(list).filter((t) => t.startsWith("New folder"))).toEqual(["New folder", "New folder in Design"]);
    expect(find(list, "folder.new")?.shortcut).toBe("Cmd+Shift+N");
    expect(find(list, "folder.newWorkspace")?.shortcut).toBeUndefined();
    find(list, "folder.new")!.run();
    find(list, "folder.newWorkspace")!.run();
    expect(log).toEqual(["newFolder", "newWorkspaceFolder"]);
    expect(titles(buildCommands(both, th, "desktop", "mac"))).toContain("โฟลเดอร์ใหม่ใน Design");
    expect(filterCommands("> new folder", list).map((c) => c.id)).toEqual(["folder.new", "folder.newWorkspace"]);
  });
});

describe("the palette's commands", () => {
  it("offers what the app can do now, in the UI language", () => {
    const { actions } = spies();
    const list = buildCommands(actions, en, "desktop", "other");
    expect(titles(list)).toEqual([
      "New page",
      "Rename page",
      "Move to…",
      "Move page up",
      "Move page down",
      "Change theme: Light",
      "Change theme: Dark",
      "Change theme: System",
      "Open Settings",
      "New tab",
      "Close tab",
      "Next tab",
      "Previous tab",
      "Go to tab: Beta",
      "Go to tab: Settings",
      "Switch between Blocks and Plain mode",
      "Show keyboard shortcuts",
    ]);
    const thai = buildCommands(actions, th, "desktop", "other");
    expect(titles(thai)).toContain("หน้าใหม่");
    expect(titles(thai)).toContain("เปลี่ยนธีม: มืด");
    expect(titles(thai)).toContain("ไปที่แท็บ: Beta");
    expect(thai).toHaveLength(list.length);
  });

  it("leaves out what does not apply: no open page, no rename, move or order; no editor, no mode or format", () => {
    const { actions } = spies();
    const bare: CommandActions = { theme: actions.theme, openSettings: actions.openSettings, tabs: { ...actions.tabs, list: [{ id: "t1", label: "New tab" }] }, showShortcuts: actions.showShortcuts };
    const list = buildCommands(bare, en, "web", "other");
    for (const missing of ["page.new", "page.rename", "page.moveTo", "page.moveUp", "page.moveDown", "editor.mode", "folder.new"]) expect(find(list, missing), missing).toBeUndefined();
    expect(list.some((c) => c.id.startsWith("format."))).toBe(false);
    expect(list.some((c) => c.id.startsWith("tab.go."))).toBe(false);
    expect(find(list, "settings.open")).toBeDefined();
  });

  it("adds the style commands only where text is selected, with their shortcuts", () => {
    const { actions } = spies();
    const format = vi.fn();
    const list = buildCommands({ ...actions, format }, en, "desktop", "other");
    expect(titles(list.filter((c) => c.id.startsWith("format.")))).toEqual([
      "Format: Bold",
      "Format: Italic",
      "Format: Underline",
      "Format: Strikethrough",
      "Format: Inline code",
      "Format: Highlight",
      "Format: Link",
      "Text colour: Default",
      "Text colour: Gray",
      "Text colour: Brown",
      "Text colour: Orange",
      "Text colour: Yellow",
      "Text colour: Green",
      "Text colour: Blue",
      "Text colour: Purple",
      "Text colour: Red",
    ]);
    expect(find(list, "format.highlight")?.shortcut).toBe("Ctrl+Shift+H");
    find(list, "format.bold")!.run();
    find(list, "format.link")!.run();
    find(list, "format.color.red")!.run();
    find(list, "format.color.default")!.run();
    expect(format.mock.calls).toEqual([["bold"], ["link"], [{ color: "red" }], [{ color: null }]]);
  });

  it("runs the action each command stands for", () => {
    const { actions, log } = spies();
    const list = buildCommands(actions, en, "desktop", "other");
    for (const id of ["page.new", "page.rename", "page.moveTo", "page.moveUp", "page.moveDown", "settings.open", "tab.new", "tab.close", "tab.next", "tab.previous", "tab.go.t2", "editor.mode", "shortcuts.open"]) find(list, id)!.run();
    for (const theme of THEMES) find(list, `theme.${theme}`)!.run();
    expect(log).toEqual([
      "newPage",
      "rename",
      "moveTo",
      "reorder -1",
      "reorder 1",
      "openSettings",
      "newTab",
      "closeTab",
      "nextTab",
      "previousTab",
      "goTo t2",
      "toggleMode",
      "showShortcuts",
      "theme light",
      "theme dark",
      "theme system",
    ]);
  });

  it("names new pages and folders after the workspace when there is more than one place", () => {
    const { actions } = spies();
    const here = vi.fn();
    const list = buildCommands({ ...actions, newWorkspacePage: { workspace: "Design", run: here }, newFolder: { workspace: "Design", run: here } }, en, "desktop", "other");
    expect(titles(list).slice(0, 3)).toEqual(["New page", "New page in Design", "New folder in Design"]);
    expect(titles(buildCommands({ ...actions, newFolder: { run: here } }, en, "web", "other"))).toContain("New folder");
  });

  it("shows each command's shortcut for this client and platform, from the shortcut table", () => {
    const { actions } = spies();
    const desktop = buildCommands(actions, en, "desktop", "mac");
    expect(find(desktop, "page.new")?.shortcut).toBe("Cmd+N");
    expect(find(desktop, "tab.close")?.shortcut).toBe("Cmd+W");
    expect(find(desktop, "page.rename")?.shortcut).toBe("F2");
    expect(find(desktop, "page.moveUp")?.shortcut).toBe("Option+Shift+↑");
    expect(find(desktop, "page.moveDown")?.shortcut).toBe("Option+Shift+↓");
    expect(find(desktop, "shortcuts.open")?.shortcut).toBe("Cmd+/");
    const web = buildCommands(actions, en, "web", "other");
    expect(find(web, "page.new")?.shortcut).toBe("Alt+N");
    expect(find(web, "tab.close")?.shortcut).toBe("Alt+W");
    expect(find(web, "tab.next")?.shortcut).toBe("Alt+Page Down");
    expect(find(web, "settings.open")?.shortcut).toBe("Alt+,");
    expect(find(web, "page.moveUp")?.shortcut).toBe("Alt+Shift+↑");
  });
});

describe("finding a command", () => {
  const { actions } = spies();
  const list = buildCommands(actions, en, "desktop", "other");

  it("knows a command query from a search", () => {
    expect(isCommandQuery(">")).toBe(true);
    expect(isCommandQuery("  > theme")).toBe(true);
    expect(isCommandQuery("theme >")).toBe(false);
    expect(isCommandQuery("")).toBe(false);
    expect(commandText(" >  dark mode ")).toBe("dark mode");
  });

  it("shows every command for a bare >", () => {
    expect(filterCommands(">", list)).toHaveLength(list.length);
    expect(filterCommands("> ", list)).toHaveLength(list.length);
  });

  it("needs every word, in the name or the hidden keywords, in any case", () => {
    expect(titles(filterCommands(">THEME dark", list))).toEqual(["Change theme: Dark"]);
    expect(titles(filterCommands("> night", list))).toEqual(["Change theme: Dark"]);
    expect(titles(filterCommands("> page up", list))).toEqual(["Move page up"]);
    expect(filterCommands("> zzz", list)).toEqual([]);
  });

  it("puts names that start with the word first, then names with a word that starts with it, then keyword matches", () => {
    expect(titles(filterCommands("> mo", list))).toEqual([
      "Move to…",
      "Move page up",
      "Move page down",
      "Switch between Blocks and Plain mode",
      // Found only through the hidden keyword "mode".
      "Change theme: Light",
      "Change theme: Dark",
      "Change theme: System",
    ]);
    expect(titles(filterCommands("> ne", list)).slice(0, 3)).toEqual(["New page", "New tab", "Next tab"]);
  });

  it("finds a tab by its name, and a command by a synonym", () => {
    expect(titles(filterCommands("> beta", list))).toEqual(["Go to tab: Beta"]);
    expect(titles(filterCommands("> preferences", list))).toEqual(["Open Settings"]);
    expect(titles(filterCommands("> plain", list))).toEqual(["Switch between Blocks and Plain mode"]);
    expect(titles(filterCommands("> keyboard", list))).toEqual(["Show keyboard shortcuts"]);
  });
});
