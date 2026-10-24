/**
 * English text of the desktop app's own views: onboarding, the shell, Settings, servers and the import wizard.
 * The editor and workspace views it shares with the web client take their text from `@thoth/app-ui/strings`.
 * Thai is in `th.ts` with the same shape.
 */
import type { System } from "../features/import/model.ts";

type Phase = "staging" | "verifying" | "committing";
type Step = "source" | "instructions" | "pick" | "preview" | "destination" | "options" | "run" | "report";
type Os = "mac" | "windows" | "linux";

const times = (n: number) => (n === 1 ? "once" : `${n} times`);

export const en = {
  onboarding: {
    /** "Meet <mark> Thoth": the mark sits between the two parts. */
    meet: { before: "Meet", after: "Thoth" },
    lede: "A private place for everything you know. Your files stay on your computer as Markdown, in a folder you choose. No account, no cloud.",
    choose: "Choose or create a Private Space",
    opening: "Opening…",
    hint: "Pick an existing folder of Markdown files, or create a new empty folder in the dialog. Thoth keeps its index in a hidden .thoth folder inside it, and the index can always be rebuilt from your files.",
    recent: "Recent",
    ready: "Ready",
    /** "<b>folder</b> is now a Private Space. …" */
    readyLede: " is now a Private Space. Everything you write here is a Markdown file in that folder.",
    startWriting: "Start writing",
    importFrom: "Import from Notion or Obsidian",
  },

  shell: {
    sidebar: "Sidebar",
    searchPages: "Search pages",
    search: "Search",
    local: "Local",
    pages: "Pages",
    pagesInSpace: "Pages in this Private Space",
    noPages: "No pages yet.",
    newPage: "New page",
    settings: "Settings",
    watchError: (detail: string) => `Changes made outside Thoth may not show up automatically: ${detail}`,
    nothingOpen: "Nothing open",
    nothingOpenHint: "Create a page with New page, or press Ctrl/Cmd+K to search.",
  },

  newPage: {
    title: "New page",
    name: "Name (use / for a folder, for example Projects/Plan)",
    cancel: "Cancel",
    create: "Create",
    exists: "A page with that name already exists.",
    errors: {
      empty: "Give the page a name.",
      invalid: "That name is not a valid page path.",
      reserved: "The .thoth folder is reserved for Thoth.",
    },
  },

  search: {
    title: "Search",
    label: "Search pages",
    placeholder: "Search pages…",
    results: "Results",
    none: (query: string) => `No pages match “${query}”.`,
  },

  page: {
    readOnly: "This file is not valid UTF-8, so Thoth shows it read-only and will never write to it. Open it in another editor to change it.",
    goneTitle: "This page is gone",
    goneDetail: (path: string) => `${path} no longer exists on disk.`,
    backlinks: "Backlinks",
    noBacklinks: "No page links here yet.",
  },

  settings: {
    title: "Settings",
    privateSpace: "Private Space",
    local: "Local",
    vaultNote: "Pages are Markdown files in this folder. The index lives in .thoth inside it and can always be rebuilt.",
    reveal: { mac: "Show in Finder", windows: "Show in File Explorer", linux: "Show in Files" } satisfies Record<Os, string>,
    switchSpace: "Switch Private Space",
    language: "Language",
    languageHint: "System follows your computer's language.",
    system: "System",
    editor: "Editor",
    editorNote: "Both modes edit the same Markdown file. Switch any page with Ctrl/Cmd+Shift+E or the toggle above it.",
    defaultMode: "Default editor mode",
    index: "Search index",
    indexNote: "Rebuilding re-reads every file and recreates the index. Your files are not changed.",
    rebuild: "Rebuild index",
    rebuilding: "Rebuilding…",
    rebuilt: (pages: number) => `Index rebuilt (${pages} pages read).`,
    importExport: "Import & Export",
    importNote: "Bring pages in from Notion or Obsidian. Your originals are only ever read.",
    importFrom: "Import from Notion or Obsidian",
  },

  servers: {
    title: "Servers",
    intro: "Connect to a Thoth server to work in shared workspaces. Thoth keeps your sign-in in the system keychain; this window never sees it.",
    unreachable: (detail: string) => `Could not reach a Thoth server at that address. ${detail}`,
    unusable: (detail: string) => `That address cannot be used. ${detail}`,
    enterAddress: "Enter the server's address, for example https://thoth.example.com.",
    signedIn: "Signed in",
    signedOut: "Signed out",
    /** The account line on a server card. */
    account: (name: string | null, email: string | undefined, token: boolean) =>
      `Signed in${name === null ? "" : ` as ${name}${email ? ` (${email})` : ""}`}${token ? " with a personal access token" : ""}.`,
    notSignedIn: "Not signed in.",
    limitsTitle: "This server has limits:",
    waiting: (provider: string) => `Finish signing in with ${provider} in your browser. Thoth is waiting for it to come back.`,
    cancel: "Cancel",
    signInWith: (provider: string) => `Sign in with ${provider}`,
    useToken: "Use a personal access token",
    signOut: "Sign out",
    signingOut: "Signing out…",
    remove: "Remove",
    tokenLabel: "Personal access token (sent once to the app's host and stored in your system keychain; it is never shown again)",
    checking: "Checking…",
    signInWithToken: "Sign in with token",
    removeTitle: (server: string) => `Remove ${server}?`,
    removeBody: "Thoth signs you out of this server and forgets it. Pages on the server are not changed, and nothing in your Private Space is touched.",
    keepIt: "Keep it",
    removeServer: "Remove server",
    suggested: "Suggested",
    connecting: "Connecting…",
    addStarter: (name: string) => `Add ${name}`,
    addServer: "Add server",
    address: "Server address",
    /** The owner's demo server (app-ui `STARTER_SERVER`), in this language. */
    starter: {
      name: "Thoth demo server",
      caution: "A free demo for trying Thoth, with limits. Accounts unused for 90 days are deleted, and the demo may be reset, so keep anything important in your Private Space.",
    },
    serverSection: (server: string) => `Server ${server}`,
    signIn: "Sign in",
    loading: "Loading…",
    noWorkspaces: "No workspaces yet.",
    workspacesOn: (server: string) => `Workspaces on ${server}`,
    removedTitle: "This server was removed",
    removedDetail: "Add it again in Settings to open its pages.",
    signedOutOf: (server: string) => `Signed out of ${server}`,
    signInAgainDetail: "Sign in again to open this page.",
    signInTo: (server: string) => `Sign in to ${server}`,
    editsStay: "Your edits stay on this page. After signing in, choose Retry to save them.",
  },

  wizard: {
    region: "Import",
    titles: {
      source: "Choose a source",
      instructions: "Prepare your export",
      pick: "Pick the export",
      preview: "Preview",
      destination: "Destination",
      options: "Options",
      run: "Importing",
      report: "Report",
    } satisfies Record<Step, string>,
    stepOf: (step: number, total: number) => `Import & Export · Step ${step} of ${total}`,
    close: "Close",
    back: "Back",
    continue: "Continue",
    backToStart: "Back to start",

    source: {
      question: "Where are your notes coming from?",
      hints: { notion: "A Markdown & CSV export (ZIP, or the folder once extracted).", obsidian: "A vault folder, or a ZIP of one." } satisfies Record<System, string>,
      unfinished: "Unfinished imports",
      state: { cancelled: "Cancelled", failed: "Failed with errors", interrupted: "Interrupted" },
      progress: (done: number, total: number, into: string) => `${done} of ${total} items imported into ${into}`,
      topLevel: "the top level",
      resume: "Resume",
      resumeLabel: (source: string) => `Resume import of ${source}`,
    },

    how: {
      notion: {
        title: "Export from Notion",
        steps: [
          "In Notion, open Settings, then Export all workspace content (or use the ... menu on one page and choose Export).",
          "Choose the format Markdown & CSV. Include subpages, and include databases as CSV.",
          "Notion emails or downloads a ZIP. Keep the ZIP as it is. You can also extract it and pick the folder.",
        ],
        note: "Notion does not recreate your workspace from an export, so expect a best-effort migration. The preview shows what will and will not carry over.",
      },
      obsidian: {
        title: "Prepare an Obsidian vault",
        steps: [
          "Close Obsidian, or at least let it finish syncing, so files are not changing while Thoth reads them.",
          "Pick the vault folder itself (the one that contains your notes and the .obsidian folder), or a ZIP of it.",
          "You do not need to copy anything. Thoth reads the vault and never changes it.",
        ],
        note: "Obsidian settings and plugin code are not imported. Plugin syntax such as Dataview is kept as plain text.",
      },
    } satisfies Record<System, { title: string; steps: string[]; note: string }>,
    ready: "I have it ready",

    pick: {
      title: { notion: "Choose your Notion export", obsidian: "Choose your Obsidian vault" } satisfies Record<System, string>,
      note: "Thoth will scan it and show a preview. Nothing is imported or changed yet.",
      zip: "Choose ZIP file",
      folder: "Choose folder",
      scanning: "Scanning and validating the source…",
    },

    preview: {
      /** "Preview of <name>" */
      of: "Preview of ",
      contents: "Import contents",
      stats: { pages: "pages", folders: "folders", attachments: "attachments", databases: "databases / CSV", skipped: "skipped" },
      links: "Links",
      linkStats: { resolved: "resolved", unresolved: "unresolved", ambiguous: "ambiguous", external: "external" },
      already: (count: number, where: string) => `This exact content was already imported ${times(count)} (into ${where}). Importing again creates separate copies.`,
      duplicates: (n: number) => `Duplicate titles (${n})`,
      duplicatesNote: "Pages sharing a title are never merged. Each is kept as its own file.",
      pagesCount: (n: number) => `${n} pages`,
      collisions: (n: number) => `Name collisions (${n})`,
      collisionsNote: "These would clash with an existing file or each other. The destination step decides whether they are renamed or skipped.",
      warnings: "Warnings",
      noWarnings: "No warnings.",
      andMore: (n: number) => `and ${n} more`,
      safe: "Your source is only read. Thoth never changes, moves or deletes it.",
      another: "Choose another source",
    },

    destination: {
      question: "Where should the imported pages go?",
      privateNote: "Files stay on your computer as Markdown.",
      workspace: "Workspace",
      later: "Coming later",
      folder: "Folder inside your Private Space (leave empty for the top level)",
      ok: "Imported files are added here. Nothing existing is overwritten.",
      reserved: "The .thoth folder is reserved for Thoth.",
      invalid: "That is not a valid folder path inside your Private Space.",
    },

    options: {
      question: "If a file with the same name already exists",
      rename: { title: "Keep both (rename the new one)", hint: "The imported file gets a number added. Nothing is overwritten." },
      skip: { title: "Skip it", hint: "The existing file stays and the imported one is not added." },
      identity: "Add identity frontmatter to imported pages",
      identityHint: "Writes a thoth_id and where the page came from (thoth_source) at the top of each imported page. It keeps links and re-imports stable, and shows up as a small metadata block in the Markdown file. The source itself is never changed.",
      preparing: "Preparing…",
      start: "Start import",
    },

    run: {
      title: "Importing",
      cancelling: "Cancelling…",
      phases: { staging: "Reading and converting", verifying: "Verifying", committing: "Adding to your Private Space" } satisfies Record<Phase, string>,
      waiting: "waiting",
      errors: (n: number) => `Items with errors (${n})`,
      note: "You can cancel at any time. Cancelling keeps what was already added, and you can resume later.",
      cancel: "Cancel import",
    },

    report: {
      headline: { completed: "Import complete", cancelled: "Import cancelled", failed: "Import finished with errors", other: "Import finished" },
      results: "Import results",
      stats: { pages: "pages imported", attachments: "attachments", databases: "databases / CSV", skipped: "skipped", failed: "failed", warnings: "warnings" },
      failedItems: "Failed items",
      links: (resolved: number, unresolved: number, ambiguous: number) => `Links: ${resolved} resolved, ${unresolved} unresolved, ${ambiguous} ambiguous.`,
      safe: "Your source was only read. It was not changed, moved or deleted.",
      openLabel: (folder: string | null) => `Open imported folder ${folder ?? "(top level)"}`,
      open: (name: string | null) => `Open ${name === null ? "imported pages" : `“${name}”`}`,
    },

    /** Explanations for the warning codes the importers and pipeline emit. */
    warnings: {
      unresolved_link: { title: "Links to pages that are not in the import", explanation: "These links point at something that was not part of the export. They are left exactly as written and will work if you import that page later." },
      ambiguous_link: { title: "Ambiguous links", explanation: "These links match more than one file, so Thoth did not guess. They are left unchanged." },
      link_not_rewritable: { title: "Links that could not be rewritten", explanation: "The new location of the target contains characters that cannot appear in a link, so the link keeps its original text." },
      renamed_on_collision: { title: "Renamed to avoid a name clash", explanation: "A file with the same name already exists (or appears twice), so a number was added. Nothing was overwritten." },
      destination_exists: { title: "Skipped because the file already exists", explanation: "Your conflict setting is Skip, so existing files are left untouched and these were not imported." },
      file_folder_conflict: { title: "Name used as both a file and a folder", explanation: "These items could not be placed because the same name is needed as a file and as a folder. They were skipped." },
      reserved_path: { title: "Inside a .thoth folder", explanation: "Thoth keeps its own data in .thoth folders and never imports into them. These were skipped." },
      skipped_metadata: { title: "Tool metadata skipped", explanation: "Version-control and Thoth metadata folders are never imported." },
      obsidian_config_skipped: { title: "Obsidian settings skipped", explanation: "Obsidian's app and plugin settings are not imported, and plugin code is never run." },
      plugin_syntax: { title: "Plugin-dependent syntax", explanation: "Dataview, Templater and similar plugin syntax is kept as plain text or code. It will not run in Thoth." },
      obsidian_comment: { title: "Obsidian comments", explanation: "%% comments %% are kept as text and will be visible in Thoth." },
      custom_task_status: { title: "Custom task statuses", explanation: "Tasks such as [/] are kept as text rather than checkboxes." },
      embed_size: { title: "Embed sizes", explanation: "Sizes like ![[image|300]] are kept in the file but not yet applied when displayed." },
      html_block: { title: "HTML blocks kept as written", explanation: "Notion exported these (for example callouts or toggles) as HTML. They are preserved verbatim, not converted to native blocks." },
      notion_url_link: { title: "Links to notion.so", explanation: "These point to Notion pages that are probably not in the export. They are left as web links." },
      database_semantics_lost: { title: "Databases imported as CSV", explanation: "Each database becomes its original CSV file. Relations, formulas, rollups, views and automations are not rebuilt." },
      database_view_csv: { title: "Database view exports", explanation: "This CSV holds only a view of the database. The full export is imported alongside it." },
      csv_ragged_rows: { title: "Uneven CSV rows", explanation: "Some rows have a different number of columns than the header. The file is imported unchanged." },
      csv_not_utf8: { title: "CSV is not UTF-8", explanation: "The file is copied byte for byte and may show odd characters elsewhere." },
      invalid_utf8: { title: "Pages that are not UTF-8", explanation: "These are copied byte for byte, opened read-only, and their links are not rewritten." },
      malformed_frontmatter: { title: "Unreadable frontmatter", explanation: "The page's metadata block could not be parsed. The page is imported verbatim and not edited." },
      identity_not_written: { title: "No Thoth ID written", explanation: "Adding an ID would require editing content Thoth cannot safely parse, so these pages get a temporary ID in the index instead." },
      unsafe_path: { title: "Unsafe paths rejected", explanation: "Entries whose paths could escape the destination (for example ../) were rejected for safety." },
      symlink_entry: { title: "Shortcuts not followed", explanation: "Symbolic links are never followed, so they were left out." },
      special_entry: { title: "Special files skipped", explanation: "Entries that are not regular files were skipped." },
      duplicate_entry: { title: "Duplicate entries", explanation: "The same path appeared more than once. The first copy was kept." },
      entry_too_large: { title: "Files over the size limit", explanation: "These files exceed the per-file safety limit and were not imported." },
      encrypted_entry: { title: "Encrypted entries", explanation: "Password-protected archive entries cannot be read and were skipped." },
      nested_archive: { title: "Nested archives", explanation: "Archives more than one level deep are not opened." },
    } satisfies Record<string, { title: string; explanation: string }>,
    unknownWarning: "The importer reported this; see the details for the affected files.",
  },
};

export type DesktopStrings = typeof en;
export type { Os };
