/**
 * English UI text: the shared editor and workspace views (desktop and web) and the web client.
 * Thai is in `th.ts` with the same shape. The desktop app provides the language it resolved (system or
 * Settings → Language); its own views' text is in `apps/desktop/src/strings`.
 */
import type { TextColor } from "@thoth/editor";
import type { BlockKind } from "../editor/block-kinds.ts";
import type { ConflictChoice } from "../editor/page-session.ts";

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

  modal: { close: "Close", closeTitle: "Close (Esc)" },

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
  },
};

export type Strings = typeof en;
export type EditorStrings = Strings["editor"];
