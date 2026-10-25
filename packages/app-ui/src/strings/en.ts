/**
 * English UI text: the shared editor and workspace views (desktop and web) and the web client.
 * Thai is in `th.ts` with the same shape. The desktop app provides the language it resolved (system or
 * Settings → Language); its own views' text is in `apps/desktop/src/strings`.
 */
import type { TextColor } from "@thoth/editor";
import type { BlockKind } from "../editor/block-kinds.ts";
import type { ConflictChoice } from "../editor/page-session.ts";
import type { ShortcutGroup, ShortcutId } from "../keyboard/shortcuts.ts";

export type Lang = "en" | "th";
type Where = "disk" | "server";
type Choice = { title: string; hint: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export const en = {
  lang: "en" as Lang,
  /** Shown in the language switch, in its own language. */
  name: "English",

  editor: {
    status: { idle: "", dirty: "Unsaved changes", saving: "Saving…", saved: "Saved", error: "Not saved" },
    modeGroup: "Editor mode",
    modeSwitchTitle: "Switch editor mode (Ctrl/Cmd+Shift+E)",
    modes: {
      blocks: { label: "Blocks", hint: "Formatted blocks, like Notion" },
      plain: { label: "Plain", hint: "Markdown text with live preview, like Obsidian" },
    },
    breadcrumb: "Breadcrumb",
    retry: "Retry",
    /** "Your version was saved as <b>label</b>." */
    copySaved: { before: "Your version was saved as ", after: "." },
    openIt: "Open it",
    changedAgain: {
      disk: "The file changed on disk again. Review the new version and choose again.",
      server: "The page changed on the server again. Review the new version and choose again.",
    } satisfies Record<Where, string>,

    // Inside the editors (menus, node views, live preview).
    insertBlock: "Insert block",
    noMatchingBlocks: "No matching blocks",
    blockMenu: "Block menu",
    turnInto: "Turn into",
    duplicate: "Duplicate",
    delete: "Delete",
    moveUp: "Move up",
    moveDown: "Move down",
    handleLabel: "Drag to move, click for block menu",
    handleTitle: "Drag to move · Click for menu",
    linkToPage: "Link to page",
    linkAlias: (alias: string) => `alias “${alias}”`,
    linkNoMatch: (query: string) => `No page matches “${query}”. Keep typing to link to a new page.`,
    linkNoPages: "No other pages yet.",
    fold: (collapsed: boolean, toggle: boolean) => `${collapsed ? "Expand" : "Collapse"} ${toggle ? "toggle" : "callout"}`,
    preserved: (kind: "html" | "math" | "raw") => `${kind === "html" ? "HTML" : kind === "math" ? "Math" : "Markdown"} · preserved as written`,
    preservedTitle: "Preserved as written",
    linkAmbiguous: (candidates: string) => `Ambiguous: ${candidates}`,
    linkUnresolved: (target: string) => `No page named "${target}" yet`,
    linkState: { resolved: "open page", ambiguous: "ambiguous link", unresolved: "unresolved link" },
    embed: "Embed · ",
    done: "Done",

    /** The toolbar on selected text in Blocks mode (ADR-0016 rule 1). */
    styles: {
      toolbar: "Text formatting",
      bold: "Bold",
      italic: "Italic",
      underline: "Underline",
      strike: "Strikethrough",
      code: "Inline code",
      link: "Link",
      color: "Text colour",
      highlight: "Highlight",
      colorMenu: "Text colour",
      /** Shown for `default` and each palette name. */
      colorNames: { default: "Default", gray: "Gray", brown: "Brown", orange: "Orange", yellow: "Yellow", green: "Green", blue: "Blue", purple: "Purple", red: "Red" } satisfies Record<"default" | TextColor, string>,
      linkAddress: "Link address",
      linkPlaceholder: "Paste a link or type a page path",
      linkApply: "Apply",
      linkRemove: "Remove link",
      linkInvalid: "Use an address that starts with http, https, mailto or tel, or a page path.",
      /** Tooltip: the action and its shortcut. */
      withShortcut: (label: string, shortcut: string) => `${label} (${shortcut})`,
    },

    blocks: {
      text: { title: "Text", description: "Plain paragraph" },
      h1: { title: "Heading 1", description: "Big section heading" },
      h2: { title: "Heading 2", description: "Medium section heading" },
      h3: { title: "Heading 3", description: "Small section heading" },
      bullet: { title: "Bulleted list", description: "A simple list with bullets" },
      numbered: { title: "Numbered list", description: "A list with numbering" },
      todo: { title: "To-do list", description: "Track tasks with checkboxes" },
      toggle: { title: "Toggle", description: "A block you can fold open and closed" },
      callout: { title: "Callout", description: "Make writing stand out" },
      quote: { title: "Quote", description: "Capture a quote" },
      code: { title: "Code", description: "A block of code" },
      divider: { title: "Divider", description: "Visually divide blocks" },
    } satisfies Record<BlockKind, { title: string; description: string }>,
  },

  conflict: {
    text: {
      disk: { title: "This page changed on disk", side: "On disk", changed: "was changed outside Thoth", deleted: "was deleted or moved outside Thoth", group: "the version on disk" },
      server: { title: "This page changed on the server", side: "On the server", changed: "was changed by someone else", deleted: "was deleted on the server", group: "the version on the server" },
    } satisfies Record<Where, { title: string; side: string; changed: string; deleted: string; group: string }>,
    /** Follows the page's name in bold. */
    intro: (what: string) => ` ${what} while you have unsaved edits. Nothing has been overwritten. Choose what to keep.`,
    yourEdits: "Your edits",
    differences: (group: string) => `Differences between ${group} and your edits`,
    chooseToContinue: "Choose one to continue",
    choices: {
      disk: {
        mine: { title: "Keep mine", hint: "Replace the file on disk with what is in the editor." },
        theirs: { title: "Keep theirs", hint: "Reload the file from disk and drop my unsaved edits." },
        both: { title: "Keep both", hint: "Save my version as a separate conflict copy, then reload the file from disk." },
      },
      server: {
        mine: { title: "Keep mine", hint: "Replace the version on the server with what is in the editor." },
        theirs: { title: "Keep theirs", hint: "Load the version on the server and drop my unsaved edits." },
        both: { title: "Keep both", hint: "Save my version as a new page in this workspace, then load the version on the server." },
      },
    } satisfies Record<Where, Record<ConflictChoice, Choice>>,
  },

  modal: { close: "Close" },

  workspace: {
    badge: (name: string) => `Workspace · ${name}`,
    badgeShort: "Workspace",
    onServer: (workspace: string, server: string) => `${workspace} on ${server}`,
    readOnly: (name: string) => `You are a viewer in ${name}, so this page is read-only.`,
    missingTitle: "This page is gone",
    missingDetail: "It was deleted on the server, or you no longer have access to it.",
    pageFallback: "Page",
    couldNotLoad: "Could not load this workspace",
    loading: "Loading…",
    noPages: "No pages yet.",
    pagesIn: (name: string) => `Pages in ${name}`,
    newPageIn: (name: string) => `New page in ${name}`,
    newPage: "New page",
    newPageTitle: "Untitled",
    creating: "Creating…",
  },

  /** Both page trees (Private Space and workspaces): rename, folders, moving and ordering. */
  tree: {
    rename: "Rename",
    renameLabel: (title: string) => `Rename ${title}`,
    menuLabel: (title: string) => `Actions for ${title}`,
    newPageInside: "New page inside",
    newFolderInside: "New folder inside",
    moveUp: "Move up",
    moveDown: "Move down",
    moveTo: "Move to…",
    folder: "Folder",
    /** Shown as a tooltip on a folder row. */
    itemCount: (n: number) => (n === 0 ? "Empty" : plural(n, "item")),
    /** Said by screen readers after a move, for example "Plan moved to position 2 of 5". */
    movedTo: (title: string, position: number, total: number) => `${title} moved to position ${position} of ${total}`,
    movedInto: (title: string, folder: string) => `${title} moved into ${folder}`,
    movedToTop: (title: string) => `${title} moved to the top level`,
    renamed: (title: string) => `Renamed to ${title}`,
    renameFailed: (detail: string) => `Could not rename: ${detail}`,
    moveFailed: (detail: string) => `Could not move: ${detail}`,
    orderUnavailable: "This server cannot keep a custom order, so pages are sorted A–Z and cannot be reordered.",
    newFolderTitle: "New folder",
    newFolder: "New folder",
    newFolderIn: (name: string) => `New folder in ${name}`,
    newFolderFailed: (detail: string) => `Could not create the folder: ${detail}`,
    /** Why a name was refused in the Private Space tree (the others are in `renameDialog`). */
    nameProblem: {
      reserved: "That name is reserved.",
      invalid: "A name cannot contain : * ? \" < > | or control characters, end with a dot, or be a system name like CON.",
      tooLong: "That name is too long.",
    },
    renameDialog: {
      title: (name: string) => `Rename “${name}”`,
      name: "New name",
      rename: "Rename",
      cancel: "Cancel",
      empty: "Give it a name.",
      invalid: "A name cannot contain / or \\.",
      exists: "Something with that name is already there.",
    },
    moveDialog: {
      title: (name: string) => `Move “${name}” to…`,
      destination: "Move into",
      topLevel: "Top level",
      move: "Move",
      cancel: "Cancel",
    },
  },

  limits: {
    pages: (n: number) => `${plural(n, "page")} per workspace`,
    members: (n: number) => `${plural(n, "member")} per workspace`,
    workspaces: (n: number) => `${plural(n, "workspace")} per account`,
    attachmentsPerWorkspace: (size: string) => `${size} of attachments per workspace`,
    perAttachment: (size: string) => `${size} per attachment`,
    perPage: (size: string) => `${size} per page`,
    retention: (n: number) => `Old versions of a page are kept for ${plural(n, "day")}`,
    bytes: (n: number) => plural(n, "byte"),
  },

  /** The theme choice (Settings on the desktop, the account area on the web). */
  theme: { label: "Theme", light: "Light", dark: "Dark", system: "System" },

  /** The shortcuts list (Cmd/Ctrl+/) and the command palette (ADR-0016 rule 7). */
  keyboard: {
    title: "Keyboard shortcuts",
    intro: "Every command can be reached with the keyboard. Press Ctrl/Cmd+K and type > to find a command by name.",
    close: "Close",
    groups: { general: "Everywhere", assistant: "Thoth assistant", tabs: "Tabs", tree: "Page tree", editor: "Editor" } satisfies Record<ShortcutGroup, string>,
    /** Marks a shortcut that has other keys in the web version. */
    webDiffers: "Different on the desktop app",
    desktopDiffers: "Different in the web version",
    webNote: "Browsers keep some keys for themselves (new tab, close tab, switching tabs), so the web version uses these keys instead. Where they differ, the desktop keys are shown as well.",
    desktopKeys: (keys: string) => `Desktop app: ${keys}`,
    webKeys: (keys: string) => `Web: ${keys}`,
    searchOrCommands: "Search pages, or type > for commands",
    palette: {
      /** Under the search field before anything is typed. */
      hint: "Type > to run a command, for example “> new page”.",
      commands: "Commands",
      noCommands: "No command matches.",
    },
    /** Names of the palette's commands. */
    commands: {
      newPage: "New page",
      newPageIn: (workspace: string) => `New page in ${workspace}`,
      newFolder: "New folder",
      newFolderIn: (workspace: string) => `New folder in ${workspace}`,
      rename: "Rename page",
      moveTo: "Move to…",
      moveUp: "Move page up",
      moveDown: "Move page down",
      theme: (name: string) => `Change theme: ${name}`,
      settings: "Open Settings",
      /** Desktop only: the mascot's prompt bubble, its size, and the assistant's settings. */
      ask: "Ask Thoth",
      assistantSize: "Shrink or expand the assistant",
      assistantSettings: "Open the assistant settings",
      newTab: "New tab",
      closeTab: "Close tab",
      nextTab: "Next tab",
      previousTab: "Previous tab",
      goToTab: (label: string) => `Go to tab: ${label}`,
      toggleMode: "Switch between Blocks and Plain mode",
      shortcuts: "Show keyboard shortcuts",
      format: (style: string) => `Format: ${style}`,
      color: (name: string) => `Text colour: ${name}`,
    },
    names: {
      "palette.open": "Search pages, or type > for commands",
      "shortcuts.open": "Show keyboard shortcuts",
      "settings.open": "Open Settings",
      "page.new": "New page",
      "folder.new": "New folder",
      "theme.cycle": "Change theme (light, dark, system)",
      "tab.new": "New tab",
      "tab.close": "Close tab",
      "tab.next": "Next tab",
      "tab.previous": "Previous tab",
      "tab.jump": "Go to tab 1–9 (9 is the last tab)",
      "tab.openNew": "Open a page in a new tab",
      "tree.move": "Move between pages and folders",
      "tree.expand": "Open or close a folder",
      "tree.open": "Open the page",
      "tree.rename": "Rename",
      "tree.reorder": "Move the page up or down",
      "tree.menu": "Open the page's menu",
      "editor.save": "Save now",
      "editor.mode": "Switch between Blocks and Plain",
      "editor.blockMenu": "Block menu",
      "editor.blockMove": "Move the block up or down",
      "style.bold": "Bold",
      "style.italic": "Italic",
      "style.underline": "Underline",
      "style.strike": "Strikethrough",
      "style.code": "Inline code",
      "style.highlight": "Highlight",
      "style.link": "Link",
      "style.toolbar": "Go to the formatting toolbar",
      "dialog.close": "Close a dialog or menu",
      "assistant.ask": "Ask Thoth (open the assistant's bubble)",
      "assistant.size": "Shrink or expand the assistant",
    } satisfies Record<ShortcutId, string>,
  },

  /** Tabs above the page (ADR-0016 rule 5). */
  /** The drag handle on the sidebar's edge. */
  sidebar: {
    resize: "Resize sidebar",
    resizeHint: "Drag to resize. Double-click or press Enter to reset.",
  },

  tabs: {
    list: "Open pages",
    new: "New tab",
    /** The button in a tab. It does not repeat the page name: the name is its description, so a search for the page finds one thing. */
    close: "Close tab",
    blank: "New tab",
    settings: "Settings",
    untitled: "Untitled",
    loading: "Loading…",
  },

  web: {
    loading: "Loading…",
    signInTitle: "Sign in to Thoth",
    signInLead: "Write and share pages in a workspace on the Thoth demo server.",
    signInWith: (provider: string) => `Sign in with ${provider}`,
    signingIn: "Signing in…",
    noProviders: "This server does not offer sign-in from the browser.",
    signInFailed: {
      access_denied: "Sign-in was cancelled, or the server is not accepting new accounts right now.",
      state: "This sign-in did not start here, or it took too long. Please try again.",
      exchange: "The server did not accept the sign-in. Please try again.",
      generic: "Sign-in did not finish. Please try again.",
    },
    unreachable: "Could not reach the Thoth server. Check your connection and try again.",
    tryAgain: "Try again",
    signOut: "Sign out",
    privacy: "Privacy",
    cookieSettings: "Cookie settings",
    knownAs: ", known as",
    signingOut: "Signing out…",
    signedInAs: (name: string) => `Signed in as ${name}`,
    caution: "A free demo for trying Thoth, with limits. Accounts unused for 90 days are deleted, and the demo may be reset, so keep a copy of anything important.",
    limitsTitle: "This server has limits:",
    workspaces: "Workspaces",
    noWorkspaces: "You are not in any workspace yet.",
    search: "Search",
    searchLabel: (workspace: string) => `Search ${workspace}`,
    searchPlaceholder: "Search pages",
    searchNone: "No pages match.",
    searchHint: "Type to search this workspace.",
    nothingOpen: "Nothing open",
    nothingOpenHint: "Choose a page on the left, or create one with New page.",
    language: "Language",
    sessionEnded: "You were signed out. Signing in again leaves this page, so copy any text you have not saved first.",
    signInAgain: "Sign in again",
    sidebar: "Sidebar",
    pages: "Pages",
    /** The Settings tab of the web client. */
    settingsView: {
      title: "Settings",
      account: "Account",
      appearance: "Appearance",
      themeHint: "Light, dark, or the same as your system.",
      languageHint: "The language of menus and labels.",
      keyboard: "Keyboard",
      keyboardNote: "Every command can be reached with the keyboard. Browsers keep some keys, so the web version uses other keys there, and the list says which.",
      showShortcuts: "Show keyboard shortcuts",
    },
  },
};

export type Strings = typeof en;
export type EditorStrings = Strings["editor"];
