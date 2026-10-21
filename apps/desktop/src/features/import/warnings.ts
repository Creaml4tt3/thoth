/** Human-readable explanations for the warning codes the importers and pipeline emit. */
export interface WarningInfo {
  title: string;
  explanation: string;
}

const KNOWN: Record<string, WarningInfo> = {
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
};

export function describeWarning(code: string): WarningInfo {
  return KNOWN[code] ?? { title: code.replace(/_/g, " "), explanation: "The importer reported this; see the details for the affected files." };
}

export const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };
