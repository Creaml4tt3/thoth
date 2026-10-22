import { collisionKey, stripExtension } from "@thoth/domain";
import type { ImportProvider } from "./provider.ts";

/** Longest default folder name, in user-perceived characters (Thai combining marks count with their base). */
export const MAX_IMPORT_FOLDER_CHARS = 48;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_ID = /\b[0-9a-f]{32}\b/gi;
// Characters that are unsafe or awkward in a folder name on macOS, Windows or Linux.
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;
const SYSTEM_NAME: Record<ImportProvider["system"], string> = { notion: "Notion", obsidian: "Obsidian" };

function truncate(text: string, max: number): string {
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
  if (graphemes.length <= max) return text;
  const cut = graphemes.slice(0, max).join("");
  // Prefer ending at a word boundary when one is reasonably close.
  const space = cut.lastIndexOf(" ");
  return (space >= cut.length * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A short, readable folder name for an import, derived from the source's file
 * or folder name. Machine-generated parts are dropped: Notion names its export
 * `<uuid>_Export-<uuid>.zip`, which would otherwise become a 90-character folder.
 * When nothing readable is left, the name is "<System> import <date>".
 */
export function importFolderName(sourceLabel: string, system: ImportProvider["system"], now: number = Date.now()): string {
  const stem = stripExtension(sourceLabel).normalize("NFC");
  const generated = UUID.test(stem);
  UUID.lastIndex = 0;
  let readable = stem.replace(UUID, " ").replace(HEX_ID, " ").replace(/_/g, " ");
  // Notion's own "Export" label only appears next to the UUIDs it generated; a user's "Trip Export" folder keeps it.
  if (generated) readable = readable.replace(/(^|[\s-])Export(?=[\s-]|$)/gi, " ");
  readable = readable
    .replace(UNSAFE, "-")
    .replace(/\s+/g, " ")
    .replace(/(\s*-\s*){2,}/g, " - ")
    .replace(/^[\s.\-]+|[\s.\-]+$/g, "");
  const name = truncate(readable, MAX_IMPORT_FOLDER_CHARS).replace(/[\s.\-]+$/, "");
  return name !== "" ? name : `${SYSTEM_NAME[system]} import ${localDate(now)}`;
}

/** `Imports/<name>`, with " 2", " 3"… appended when that folder already exists in the vault. */
export async function defaultImportRoot(existing: (path: string) => Promise<boolean>, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = `Imports/${n === 1 ? name : `${name} ${n}`}`;
    if (!(await existing(candidate))) return candidate;
  }
}

/** Case-insensitive existence check for a vault folder, matching how collisions are detected elsewhere. */
export function folderExists(list: (dir: string) => Promise<{ name: string }[]>): (path: string) => Promise<boolean> {
  return async (path) => {
    const slash = path.lastIndexOf("/");
    const parent = slash < 0 ? "" : path.slice(0, slash);
    const name = path.slice(slash + 1);
    try {
      return (await list(parent)).some((e) => collisionKey(e.name) === collisionKey(name));
    } catch {
      return false;
    }
  };
}
