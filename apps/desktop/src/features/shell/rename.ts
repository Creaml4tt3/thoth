/**
 * Renaming in the Private Space tree (ADR-0016 rule 4, ADR-0001/0003). A page or a folder is renamed by moving it
 * inside the vault: `Vault.move` is one atomic filesystem rename and follows the links to it. This module is the one
 * code path for that, shared by F2 in the tree and "Rename page" in the palette.
 *
 * - The name is the file name without its extension (`Plan` for `Plan.md`); a page keeps its extension.
 * - The entry keeps its place in `.thoth/order.json`; no order file appears just for a rename.
 * - A page whose title text was the old name gets the new one (`retitle`), written as a compare-and-swap write on
 *   the bytes just read. Anything else in the page is left alone, byte for byte.
 */
import { parsePage, updateFrontmatter } from "@thoth/content";
import { basename, collisionKey, dirname, isMarkdownPath, isReservedPath, stripExtension } from "@thoth/domain";
import { ConflictError, entryNameProblem, readOrder, renameInOrder, writeOrder, type NameProblem, type OrderRecord, type Vault } from "@thoth/local-store";
import type { Strings } from "@thoth/app-ui/strings/index.ts";

/** Why a rename was refused before anything changed: a bad name, or `exists` (a sibling with that name, in any letter case). */
export class RenameError extends Error {
  readonly problem: NameProblem | "exists";

  constructor(problem: NameProblem | "exists") {
    super(`Cannot rename: ${problem}`);
    this.name = "RenameError";
    this.problem = problem;
  }
}

/** The sentence for a refused name, in the UI language. */
export function renameProblemText(problem: NameProblem | "exists", t: Strings["tree"]): string {
  switch (problem) {
    case "empty":
      return t.renameDialog.empty;
    case "separator":
      return t.renameDialog.invalid;
    case "exists":
      return t.renameDialog.exists;
    default:
      return t.nameProblem[problem];
  }
}

export interface Renamed {
  from: string;
  to: string;
  kind: "page" | "folder";
  /** The order record after the rename (what is on disk). */
  order: OrderRecord;
  /** The text of the page changed to carry the new name. */
  titleUpdated: boolean;
  /** The page's title text was the old name but could not be updated (the page changed meanwhile, or the new name cannot be written there). */
  titleSkipped: boolean;
}

const join = (folder: string, name: string) => (folder === "" ? name : `${folder}/${name}`);

/**
 * Renames the page or folder at `from` to `name` (without extension), in the same folder.
 *
 * @throws RenameError the name is not acceptable (nothing changed)
 */
export async function renamePrivate(vault: Vault, from: string, name: string, options: { retitle: boolean }): Promise<Renamed> {
  const stat = await vault.fs.stat(from);
  const folder = stat?.kind === "directory";
  const file = basename(from);
  const extension = folder ? "" : file.slice(stripExtension(file).length);
  const oldStem = folder ? file : stripExtension(file);
  const stem = name.trim();
  const entry = `${stem}${extension}`;
  const kind = folder ? "folder" : "file";
  const problem = entryNameProblem(stem, kind) ?? entryNameProblem(entry, kind);
  if (problem) throw new RenameError(problem);
  const to = join(dirname(from), entry);
  if (isReservedPath(to)) throw new RenameError("reserved");
  const order = await readOrder(vault);
  if (entry === file) return { from, to, kind: folder ? "folder" : "page", order, titleUpdated: false, titleSkipped: false };

  // A sibling with the same name in any letter case is taken, whether or not this volume tells the two apart.
  // The entry itself (a rename that only changes letter case) is not a clash.
  const key = collisionKey(entry);
  if ((await vault.fs.list(dirname(from))).some((e) => e.name !== file && collisionKey(e.name) === key)) throw new RenameError("exists");

  let report;
  try {
    report = await vault.move(from, to);
  } catch (error) {
    if (error instanceof ConflictError) throw new RenameError("exists");
    throw error;
  }
  const moved = renameInOrder(order, report.moved);
  const changed = JSON.stringify(moved) !== JSON.stringify(order);
  if (changed) await writeOrder(vault, moved); // no order file appears just for a rename

  let titleUpdated = false;
  let titleSkipped = false;
  if (options.retitle && !folder && isMarkdownPath(to)) {
    try {
      const page = await vault.readPage(to);
      if (page.editable) {
        const next = retitle(to, page.source, oldStem, stem);
        if (next !== page.source) {
          await vault.writePage(to, next, { expectedHash: page.hash });
          titleUpdated = true;
        } else if (titleTextIs(to, page.source, oldStem)) {
          titleSkipped = true; // it names the old stem, and the new name cannot be written there
        }
      }
    } catch {
      // The page changed under us (`ConflictError`) or could not be read: the rename stands, the title is left as it was.
      titleSkipped = true;
    }
  }
  return { from, to, kind: folder ? "folder" : "page", order: changed ? moved : order, titleUpdated, titleSkipped };
}

/** The text of a first-level heading (`# Title`) that is a whole top-level block, and where its line is in the source. */
function firstH1(path: string, source: string): { text: string; start: number; end: number; open: string; close: string } | null {
  const block = parsePage(path, source).blocks.find((b) => b.type === "heading" && b.level === 1);
  if (!block) return null;
  const line = /^[^\r\n]*/.exec(source.slice(block.range.start, block.range.end))![0];
  const m = /^(#[ \t]+)(.*?)((?:[ \t]+#+)?[ \t]*)$/.exec(line);
  return m ? { text: m[2]!, start: block.range.start, end: block.range.start + line.length, open: m[1]!, close: m[3]! } : null;
}

const frontmatterTitle = (path: string, source: string): string | null => {
  const doc = parsePage(path, source);
  const title = doc.frontmatter["title"];
  return doc.frontmatterError === undefined && typeof title === "string" ? title.trim() : null;
};

/** True when the page's frontmatter `title:` or first `# ` heading is exactly `stem`. */
function titleTextIs(path: string, source: string, stem: string): boolean {
  return frontmatterTitle(path, source) === stem || firstH1(path, source)?.text === stem;
}

/**
 * `source` with its title text changed from the old file name to the new one, or `source` itself.
 *
 * The title of a Private Space page is its frontmatter `title:`, else its file name. So when the page has no
 * `title:`, the new name already is its title and nothing in the text needs to change. The text changes only where it
 * says the old name exactly: a frontmatter `title:` equal to `oldStem`, and the first `# ` heading equal to
 * `oldStem`. Each is rewritten in place (`updateFrontmatter` keeps every other key and the body; the heading keeps
 * its marker and closing `#`s). A title that is anything else, or an edit that would not read back as `newStem`
 * (for example a trailing `#`), is left alone.
 */
export function retitle(path: string, source: string, oldStem: string, newStem: string): string {
  let out = source;
  // The heading is later in the file than the frontmatter, so it is spliced first, while its offsets are still right.
  const heading = firstH1(path, out);
  if (heading && heading.text === oldStem) {
    const candidate = out.slice(0, heading.start) + heading.open + newStem + heading.close + out.slice(heading.end);
    if (firstH1(path, candidate)?.text === newStem) out = candidate;
  }
  if (frontmatterTitle(path, out) === oldStem) {
    try {
      const candidate = updateFrontmatter(out, { title: newStem });
      if (frontmatterTitle(path, candidate) === newStem) out = candidate;
    } catch {
      // Frontmatter that cannot be edited safely is never rewritten.
    }
  }
  return out;
}
