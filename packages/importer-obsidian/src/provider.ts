import type { PageDocument } from "@thoth/content";
import { isMarkdownPath, type ImportWarning } from "@thoth/domain";
import { commonRootFolder, type ClassifiedEntry, type ImportProvider, type SourceEntry } from "@thoth/importer-core";

/**
 * Obsidian vault provider (spec §7.3). The vault filesystem is the import
 * interface: notes are copied verbatim, wikilinks stay wikilinks, and only
 * links whose target would otherwise change are rewritten.
 */
const OBSIDIAN_DIR = ".obsidian";
/** Fenced code languages owned by community plugins; content is kept, semantics are not. */
const PLUGIN_CODE_BLOCKS = new Set(["dataview", "dataviewjs", "tasks", "query", "excalidraw", "mermaid-js", "kanban", "chart", "tracker"]);
const TEMPLATER = /<%[\s\S]*?%>/;
const INLINE_DATAVIEW = /`=\s*[^`]+`/;
const COMMENT = /%%[\s\S]*?%%/;
const NONSTANDARD_TASK = /^\s*[-*+] \[[^ xX]\]/m;

/**
 * A ZIP of a vault folder usually wraps everything in "<VaultName>/". Only
 * archives are unwrapped: a directory the user picked *is* the vault root, and
 * a single top-level folder inside it is real content.
 */
export function zippedVaultRoot(paths: readonly string[]): string {
  const root = commonRootFolder(paths);
  return root && root !== OBSIDIAN_DIR ? `${root}/` : "";
}

export function obsidianProvider(): ImportProvider {
  return {
    system: "obsidian",
    sourceKind: "obsidian-vault",

    classify(entries: readonly SourceEntry[]): ClassifiedEntry[] {
      return entries.map((e) => {
        const segments = e.path.split("/");
        if (segments.includes(OBSIDIAN_DIR)) {
          return {
            sourcePath: e.path,
            kind: "skipped",
            warnings: [{ code: "obsidian_config_skipped", severity: "info", message: "Obsidian app/plugin configuration is not imported; plugin code is never executed", sourcePath: e.path }],
          };
        }
        return { sourcePath: e.path, kind: isMarkdownPath(e.path) ? "page" : "attachment", relDest: e.path };
      });
    },

    analyzePage(doc: PageDocument, sourcePath: string): ImportWarning[] {
      const warnings: ImportWarning[] = [];
      const warn = (code: string, message: string, line?: number) =>
        warnings.push({ code, severity: "info", message, sourcePath, ...(line !== undefined ? { line } : {}) });
      for (const block of doc.blocks) {
        if (block.type === "code" && block.lang && PLUGIN_CODE_BLOCKS.has(block.lang.toLowerCase()))
          warn("plugin_syntax", `\`\`\`${block.lang} block depends on an Obsidian plugin; kept as a code block`, block.range.startLine);
      }
      const body = doc.plainText;
      if (TEMPLATER.test(body)) warn("plugin_syntax", "Templater syntax (<% %>) is kept as text and is never executed");
      if (INLINE_DATAVIEW.test(body)) warn("plugin_syntax", "Inline Dataview queries are kept as text");
      if (COMMENT.test(body)) warn("obsidian_comment", "Obsidian %% comments %% are kept as text and will be visible");
      if (NONSTANDARD_TASK.test(body)) warn("custom_task_status", "Custom task statuses (e.g. [/]) are kept as text, not checkboxes");
      for (const ref of doc.references) {
        if (ref.syntax === "embed" && ref.label && /^\d+(x\d+)?$/.test(ref.label))
          warn("embed_size", `Embed size "|${ref.label}" is preserved but not yet rendered`, ref.range.startLine);
      }
      return warnings;
    },
  };
}

