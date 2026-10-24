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
    newFolder: "New folder",
    /** The name a new folder starts with; a number follows when it is taken ("Untitled folder 2"). */
    untitledFolder: "Untitled folder",
    folderCreated: (name: string) => `Created the folder ${name}`,
    /** Said after a rename when the page changed meanwhile, so the title inside it was left alone. */
    titleNotUpdated: (name: string) => `Renamed to ${name}. The title inside the page was not updated because the page changed.`,
    unsavedChanges: "The open page has changes that could not be saved yet.",
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
    placeholder: "Search pages, or type > for commands",
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
    theme: "Theme",
    themeHint: "System follows your computer's light or dark setting.",
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

  transfer: {
    // Entry points.
    select: "Select pages",
    selectDone: "Done selecting",
    selectPage: (title: string) => `Select ${title}`,
    selected: (n: number) => `${n} selected`,
    copyTo: "Copy to workspace…",
    moveTo: "Move to workspace…",
    copyHere: "Copy to Private Space…",
    moveHere: "Move to Private Space…",
    transfers: "Transfers",
    noWorkspaces: "Add a server and sign in to a workspace first (Settings → Servers).",

    // Dialog titles.
    titleTo: (mode: "copy" | "move", n: number) => `${mode === "copy" ? "Copy" : "Move"} ${n === 1 ? "1 page" : `${n} pages`} to a workspace`,
    titleFrom: (mode: "copy" | "move", title: string) => `${mode === "copy" ? "Copy" : "Move"} “${title}” to your Private Space`,

    // Destination.
    destination: "Destination",
    workspace: "Workspace",
    chooseWorkspace: "Choose a workspace",
    parent: "Put the pages",
    topLevel: "At the top level",
    under: (title: string) => `Inside “${title}”`,
    folder: "Folder in your Private Space (leave empty for the top level)",
    folderHint: "A page that was moved out of this Private Space goes back where it was, if that place is free.",
    mode: "What happens to the original",
    copy: { title: "Copy", hint: "The original stays where it is. The copy gets its own identity." },
    moveToWs: { title: "Move", hint: "The original is deleted from your Private Space after the workspace has confirmed every page. A page you edit in the meantime is kept." },
    moveFromWs: { title: "Move", hint: "The page is deleted from the workspace after it is safely in your Private Space. If someone edits it in the meantime, it stays in the workspace." },
    attachments: "Include attachments the pages link to",

    // Preview.
    checking: "Checking what this transfer would do…",
    whoCanSee: "Who can see it",
    visibleTo: (n: number) => (n === 1 ? "Only you, the only member of this workspace." : `Everyone in this workspace (${n} members) can see these pages.`),
    membersHidden: (n: number) => `${n} members can see these pages. This server does not list them.`,
    roles: { owner: "owner", editor: "editor", viewer: "viewer" },
    you: (role: string) => `Your role: ${role}`,
    pagesHeading: "Pages",
    attachmentsHeading: (n: number) => (n === 1 ? "1 attachment is uploaded" : `${n} attachments are uploaded`),
    linksHeading: "Links",
    links: {
      included: "point to pages or files in this transfer and are updated",
      already_at_destination: "point to pages already in the workspace and are updated",
      left_at_source: "point to pages that stay behind; they keep their target",
      external: "are web links and stay as they are",
      unresolved: "point to nothing that exists; they are kept as written",
    },
    linksIn: "From the workspace's point of view",
    flaggedTitle: "Links that will not work at the destination",
    noLinks: "These pages have no links.",
    nothingLeaves: "Nothing has left this computer yet.",
    nothingLeavesFrom: "Nothing has been written to your Private Space yet.",

    // Problems (block the transfer).
    problems: {
      server_unknown: "This server is no longer in your list.",
      unreachable: (detail: string) => `The server could not be reached. ${detail}`,
      signed_out: "You are signed out of this server. Sign in again in Settings → Servers.",
      incompatible: "This server speaks a different version of the workspace protocol.",
      no_transfers: "This server does not accept transfers, so copying and moving pages is turned off for it.",
      workspace_not_found: "The workspace no longer exists, or you are no longer a member.",
      forbidden: (role: string) => `You are a ${role} in this workspace, which does not allow this.`,
      export_restricted: "This workspace does not allow copying or moving its pages out. Its owner turned on an export restriction, and the server enforces it.",
      not_editable: (path: string) => `${path} is not UTF-8 text, so it cannot be given the stable ID a transfer needs.`,
      malformed_frontmatter: (path: string) => `${path} has frontmatter Thoth cannot read safely, so it cannot be given the stable ID a transfer needs.`,
      page_too_large: (path: string, size: string, limit: string) => `${path} is ${size}; this server accepts pages up to ${limit}.`,
      too_large_total: (size: string, limit: string) => `Together these pages are ${size}, more than ${limit} can be sent at once. Select fewer.`,
      quota: (limit: number, current: number, adding: number) => `The workspace holds ${current} of at most ${limit} pages, so ${adding} more do not fit.`,
      bad_folder: "That is not a valid folder in your Private Space.",
      nothing_selected: "Select at least one page.",
    },

    // Warnings (do not block).
    warnings: {
      unresolved_links: (n: number) => `${n === 1 ? "1 link points" : `${n} links point`} to nothing that exists. ${n === 1 ? "It is" : "They are"} kept exactly as written.`,
      left_at_source: (n: number) => `${n === 1 ? "1 link points" : `${n} links point`} to pages that are not part of this transfer, so ${n === 1 ? "it" : "they"} will not open at the destination.`,
      attachments_unsupported: (n: number) => `This server does not take attachments, so ${n === 1 ? "1 linked file stays" : `${n} linked files stay`} behind.`,
      attachment_too_large: (path: string, size: string, limit: string) => `${path} is ${size}, over this server's ${limit} limit for one file. It stays behind.`,
      attachments_stay_in_workspace: (n: number) => `${n === 1 ? "1 linked file stays" : `${n} linked files stay`} in the workspace; Workspace → Private transfers bring pages only.`,
      quota_near: (limit: number, current: number, adding: number) => `After this the workspace holds ${current + adding} of at most ${limit} pages.`,
    },

    // Actions.
    cancel: "Cancel",
    startCopy: "Copy",
    startMove: "Move",
    close: "Close",
    retry: "Try again",
    stop: "Stop and undo",
    dismiss: "Dismiss",
    openResult: "Open",

    // Progress.
    working: "Transferring…",
    states: {
      plan: "Planning",
      validate: "Checking permissions and limits",
      stage: "Preparing at the destination",
      transfer: "Sending",
      verify: "Verifying",
      commit_destination: "Saving at the destination",
      finalize_source: "Removing the originals",
      done: "Done",
      destination_committed_source_cleanup_pending: "Done, originals kept",
      failed: "Not transferred",
      aborted: "Stopped",
    },
    progressLabel: "Transfer progress",

    // Results.
    resultDone: (mode: "copy" | "move", n: number, where: string) => `${n === 1 ? "1 page was" : `${n} pages were`} ${mode === "copy" ? "copied" : "moved"} to ${where}. Every page was checked at the destination.`,
    resultPending: (moved: number, kept: number, where: string) =>
      `${moved === 1 ? "1 page is" : `${moved} pages are`} now in ${where}, but the move is not finished: ${kept === 1 ? "1 original was" : `${kept} originals were`} kept because ${kept === 1 ? "it was" : "they were"} changed after the transfer started. Nothing was lost. Compare the two versions, then delete the one you do not need.`,
    resultFailed: (detail: string) => `Nothing was transferred, and the originals are unchanged. ${detail}`,
    resultAborted: "The transfer was stopped and undone. Nothing changed at the destination, and the originals are unchanged.",
    resultInterrupted: (detail: string) => `The transfer was interrupted: ${detail} Your originals are safe. Try again, or stop and undo.`,
    keptItems: "Originals kept",
    keptReason: {
      source_changed: "edited after the transfer started",
      source_moved: "moved after the transfer started",
      revision_conflict: "edited in the workspace after the transfer started",
      hash_mismatch: "could not be verified at the destination",
    } as Record<string, string>,
    keptOther: "kept for safety",
    conflictCopies: (n: number) => `${n === 1 ? "1 page" : `${n} pages`} already existed here with other changes, so ${n === 1 ? "it was" : "they were"} saved next to the original as a conflict copy.`,
    privateSpace: "your Private Space",

    // Startup recovery and the transfers list.
    recoveredTitle: "Unfinished transfers",
    recoveredCompleted: (n: number) => `${n === 1 ? "1 transfer" : `${n} transfers`} that was interrupted when Thoth last closed ${n === 1 ? "has" : "have"} been finished.`,
    recoveredRolledBack: (n: number) => `${n === 1 ? "1 transfer" : `${n} transfers`} that was interrupted before ${n === 1 ? "it was" : "they were"} saved at the destination ${n === 1 ? "was" : "were"} undone. The originals are unchanged.`,
    recoveredWaiting: (n: number) => `${n === 1 ? "1 transfer" : `${n} transfers`} could not be settled because the server is not reachable. Thoth will try again next time.`,
    pendingList: "Moves with originals kept",
    pendingItem: (n: number, where: string) => `${n === 1 ? "1 original" : `${n} originals`} kept · ${where}`,
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
