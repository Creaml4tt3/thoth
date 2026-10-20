import type { PageDocument } from "@thoth/content";
import { basename, collisionKey, dirname, extname, type ImportWarning } from "@thoth/domain";
import { commonRootFolder, parseCsv, type ClassifiedEntry, type ImportProvider, type SourceEntry } from "@thoth/importer-core";

/**
 * Notion "Markdown & CSV" export provider (spec §7.2, docs/architecture/import-formats.md).
 *
 * Export conventions handled (see import-formats.md for verification status):
 * - Pages are `Title <32-hex id>.md`; child pages live in `Title <id>/`.
 * - Databases are `Name <id>.csv` and/or `Name <id>_all.csv`; row pages live in `Name <id>/`.
 * - Attachments live in a folder named after the page title, without the ID.
 * - Links are URL-encoded relative paths that include IDs.
 *
 * Destination names drop the ID suffix (kept as `thoth_source.sourceId`);
 * same-title pages are never merged — collisions are renamed and reported.
 */
const ID_SUFFIX = /^(.*?)\s+([0-9a-f]{32})(_all)?$/i;
const EXPORT_WRAPPER = /^Export-[0-9a-f-]{36}$/i;

export interface NotionName {
  title: string;
  id?: string;
  allVariant: boolean;
}

/** Splits "Title <id>.md" into title and ID; names without an ID are returned unchanged. */
export function parseNotionName(name: string): NotionName {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const m = ID_SUFFIX.exec(stem);
  if (!m || m[1]!.trim() === "") return { title: stem, allVariant: false };
  return { title: m[1]!, id: m[2]!.toLowerCase(), allVariant: m[3] !== undefined };
}

/** Rewrites every path segment to drop Notion ID suffixes (no collision handling). */
export function stripNotionIds(path: string): string {
  return path.split("/").map(stripSegment).join("/");
}

function stripSegment(segment: string): string {
  const ext = extname(segment);
  const parsed = parseNotionName(segment);
  if (!parsed.id) return segment;
  return parsed.title + (parsed.allVariant ? "_all" : "") + ext;
}

/**
 * Maps source paths to ID-free destination paths, resolving collisions per
 * directory *by Notion ID* rather than per file. A page `X <id>.md` and its
 * children folder `X <id>/` share one stem, so two same-title pages become
 * `X.md` + `X/…` and `X 2.md` + `X 2/…` — children are never merged into the
 * other page's folder (spec §7.2: never merge same-title pages).
 */
export function notionDestinations(paths: readonly string[]): Map<string, string> {
  // stem key: parent destination dir + "\0" + (id or literal segment) → assigned stem
  const stems = new Map<string, string>();
  const used = new Map<string, Set<string>>();
  // Notion puts a page's attachments in a folder named after the page title
  // *without* the ID ("Title/"). When exactly one sibling page has that title,
  // the folder belongs to that page and must share its (possibly renamed) stem.
  const pageTitleIds = new Map<string, string[]>();
  for (const path of paths) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const name = parseNotionName(basename(path));
    if (name.id && extname(path) === ".md") {
      const key = `${dir}\0${name.title}`;
      pageTitleIds.set(key, [...new Set([...(pageTitleIds.get(key) ?? []), name.id])]);
    }
  }
  const stemFor = (parentDest: string, parentSource: string, segment: string, isFile: boolean): string => {
    const ext = isFile ? extname(segment) : "";
    const parsed = parseNotionName(segment);
    const owners = !isFile && !parsed.id ? pageTitleIds.get(`${parentSource}\0${segment}`) : undefined;
    const identity = parsed.id ? `${parsed.id}${parsed.allVariant ? "_all" : ""}` : owners?.length === 1 ? owners[0]! : `literal:${segment}`;
    const key = `${parentDest}\0${identity}${parsed.id || owners?.length === 1 ? "" : `\0${isFile}`}`;
    const existing = stems.get(key);
    if (existing !== undefined) return existing + ext;
    const base = parsed.id ? stripSegment(segment).slice(0, ext ? -ext.length || undefined : undefined) : ext ? segment.slice(0, -ext.length) : segment;
    const taken = used.get(parentDest) ?? new Set<string>();
    used.set(parentDest, taken);
    let stem = base;
    for (let n = 2; taken.has(collisionKey(stem + ext)) || (parsed.id && taken.has(collisionKey(stem))); n++) stem = `${base} ${n}`;
    taken.add(collisionKey(stem + ext));
    if (parsed.id) taken.add(collisionKey(stem));
    stems.set(key, stem);
    return stem + ext;
  };
  const result = new Map<string, string>();
  for (const path of [...paths].sort()) {
    const segments = path.split("/");
    let parentDest = "";
    let parentSource = "";
    const out: string[] = [];
    segments.forEach((segment, i) => {
      const name = stemFor(parentDest, parentSource, segment, i === segments.length - 1);
      out.push(name);
      parentDest = parentDest ? `${parentDest}/${name}` : name;
      parentSource = parentSource ? `${parentSource}/${segment}` : segment;
    });
    result.set(path, out.join("/"));
  }
  return result;
}

export function notionProvider(): ImportProvider {
  return {
    system: "notion",
    sourceKind: "notion-zip",

    rootPrefix(paths) {
      const root = commonRootFolder(paths);
      return root && EXPORT_WRAPPER.test(root) ? `${root}/` : "";
    },

    classify(entries: readonly SourceEntry[]): ClassifiedEntry[] {
      const paths = new Set(entries.map((e) => e.path));
      const destinations = notionDestinations([...paths]);
      const result: ClassifiedEntry[] = [];
      for (const e of entries) {
        const name = parseNotionName(basename(e.path));
        const ext = extname(e.path);
        const relDest = destinations.get(e.path)!;
        const id = name.id !== undefined ? { sourceId: name.id } : {};
        if (ext === ".md") {
          result.push({ sourcePath: e.path, kind: "page", relDest, ...id });
        } else if (ext === ".csv" && name.id) {
          // Prefer `_all.csv` (all rows) when both variants exist; keep the other as provenance too.
          const sibling = `${dirname(e.path) ? dirname(e.path) + "/" : ""}${name.title} ${name.id}${name.allVariant ? "" : "_all"}.csv`;
          const warnings: ImportWarning[] = [];
          if (!name.allVariant && paths.has(sibling))
            warnings.push({ code: "database_view_csv", severity: "info", message: "This CSV holds the exported view only; the _all.csv variant with every row is imported alongside it", sourcePath: e.path });
          result.push({ sourcePath: e.path, kind: "database", relDest, ...id, warnings });
        } else {
          result.push({ sourcePath: e.path, kind: "attachment", relDest, ...id });
        }
      }
      return result;
    },

    analyzePage(doc: PageDocument, sourcePath: string): ImportWarning[] {
      const warnings: ImportWarning[] = [];
      const warn = (code: string, message: string, line?: number) =>
        warnings.push({ code, severity: "info", message, sourcePath, ...(line !== undefined ? { line } : {}) });
      for (const block of doc.blocks) {
        if (block.type !== "html" && block.type !== "raw") continue;
        const line = block.range.startLine;
        warn("html_block", "Notion exported this block as HTML (e.g. a callout or toggle); kept verbatim, not converted to a native block", line);
      }
      for (const ref of doc.references) {
        if (ref.external && /^https?:\/\/(www\.)?notion\.(so|site)\//.test(ref.target))
          warn("notion_url_link", `Link points to notion.so (page likely not in the export): ${ref.target}`, ref.range.startLine);
      }
      return warnings;
    },

    analyzeFile(sourcePath: string, bytes: Uint8Array): ImportWarning[] {
      const warnings: ImportWarning[] = [
        {
          code: "database_semantics_lost",
          severity: "warning",
          message: "Database imported as its original CSV (all columns preserved). Relations, formulas, rollups, views, filters, automations, and permissions are not reconstructed.",
          sourcePath,
        },
      ];
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        warnings.push({ code: "csv_not_utf8", severity: "warning", message: "CSV is not valid UTF-8; imported byte-for-byte", sourcePath });
        return warnings;
      }
      const rows = parseCsv(text);
      const width = rows[0]?.length ?? 0;
      const ragged = rows.filter((r) => r.length !== width && !(r.length === 1 && r[0] === "")).length;
      if (ragged > 0) warnings.push({ code: "csv_ragged_rows", severity: "warning", message: `${ragged} row(s) have a different column count than the header`, sourcePath });
      return warnings;
    },
  };
}
