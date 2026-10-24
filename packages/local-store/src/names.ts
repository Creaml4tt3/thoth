/**
 * Names the Private Space tree lets people give to a page file or a folder (rename, new folder).
 *
 * A name is one path segment, so it must work on every volume a vault may live on (macOS, Windows, Linux) and in the
 * tools that share the folder. The check is pure so the tree can show the reason before touching the disk; the vault
 * still refuses what is reserved or already there (`Vault.move`, `Vault.createFolder`).
 */

/** Why a name is refused. `exists` is not here: only the disk knows (and it is case-insensitive, see `collisionKey`). */
export type NameProblem = "empty" | "separator" | "reserved" | "invalid" | "tooLong";

/** Folders the scan never lists (the vault's `IGNORED_DIRS`), so a folder with such a name would vanish from the tree. */
const HIDDEN_FOLDERS = new Set([".thoth", ".obsidian", ".git", ".trash", "node_modules"]);
/** Characters Windows refuses in a name; one set for all platforms, so a vault can move between them. */
const WINDOWS_FORBIDDEN = /[<>:"|?*\u0000-\u001f\u007f]/;
/** Device names Windows reserves, with or without an extension. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Longest name in bytes that common volumes accept. */
export const MAX_NAME_BYTES = 255;

/**
 * Checks the name an entry will have on disk (`Plan.md` for a page, `Archive` for a folder). Returns the first
 * problem, or null. `folder` also refuses the names the vault does not scan.
 */
export function entryNameProblem(name: string, kind: "file" | "folder"): NameProblem | null {
  const trimmed = name.trim();
  if (trimmed === "") return "empty";
  if (/[\\/]/.test(trimmed)) return "separator";
  const key = trimmed.normalize("NFC").toLocaleLowerCase("en-US");
  if (key === ".thoth" || (kind === "folder" && HIDDEN_FOLDERS.has(key))) return "reserved";
  if (trimmed === "." || trimmed === ".." || WINDOWS_FORBIDDEN.test(trimmed) || /[. ]$/.test(trimmed) || WINDOWS_DEVICE.test(trimmed)) return "invalid";
  if (new TextEncoder().encode(trimmed.normalize("NFC")).length > MAX_NAME_BYTES) return "tooLong";
  return null;
}
