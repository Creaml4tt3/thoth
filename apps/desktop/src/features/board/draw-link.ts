/**
 * Drawing string between two notes on a Board (ADR-0056) adds one link line at the end of the source page, spelled by
 * `linkText` as Connections spells a linked mention. Every open page's pending edits are written first, so the line
 * lands after them; the write is compare-and-swap on the bytes just read, and one conflict reads again and retries.
 * Undo removes that exact line only while it is still the last line and unchanged; it never touches anything else.
 * Callers must refresh the session (reconcile + revision bump) after linked/undone, as Connections does, or an open tab
 * of the source page goes stale.
 */
import { LinkResolver, parsePage } from "@thoth/content";
import { basename, stripExtension } from "@thoth/domain";
import { ConflictError, NotFoundError, type Vault } from "@thoth/local-store";
import type { Mention } from "@thoth/app-ui/connections/mentions.ts";
import { linkText } from "../editor/PrivateConnections.tsx";

export interface DrawnLink {
  outcome: "linked" | "changed" | "gone";
  /** Only when a line was written. */
  undo?: () => Promise<"undone" | "changed">;
}

/** The page as it can be written: null when it is gone or not UTF-8 (not editable). */
const readEditable = (vault: Vault, path: string) =>
  vault.readPage(path).then((r) => (r.editable ? r : null), (e) => (e instanceof NotFoundError ? null : Promise.reject(e)));

/** Writes `next(source)` with compare-and-swap; one conflict reads again and retries. null `next` writes nothing. */
async function rewrite(vault: Vault, path: string, next: (source: string) => string | null): Promise<"written" | "changed" | "gone"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await readEditable(vault, path);
    if (!page) return "gone";
    const source = next(page.source);
    if (source === null) return "changed";
    try {
      await vault.writePage(path, source, { expectedHash: page.hash });
      return "written";
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
  }
  return "changed";
}

export async function drawLink(vault: Vault, flushAll: () => Promise<boolean>, from: string, to: string): Promise<DrawnLink> {
  // A page never links itself here: the view does not offer it, and nothing is written if asked.
  if (from === to) return { outcome: "changed" };
  if (!(await flushAll())) return { outcome: "changed" };
  const target = await vault.pageByPath(to);
  if (!target) return { outcome: "gone" };
  const outgoing = await vault.outgoingLinks(from).catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e)));
  if (!outgoing) return { outcome: "gone" };
  // Already linked (anywhere on the page): a second line would only repeat it.
  if (outgoing.some((l) => l.resolution === "resolved" && l.targetPath === to)) return { outcome: "linked" };

  const [scan, pages, folders] = await Promise.all([vault.scanFiles(), vault.listPages(), vault.listFolders()]);
  const resolver = new LinkResolver(scan.files, pages.map((p) => ({ path: p.path, aliases: p.aliases })), folders);
  // A title that would break the link's label (a line break, brackets, a pipe, a backslash) gives way to the file name.
  const text = target.title === "" || /[[\]|\r\n\\]/.test(target.title) ? stripExtension(basename(to)) : target.title;
  const found: Mention = { start: 0, end: 0, text, name: text, occurrence: 0, inTable: false, before: "", after: "" };
  const line = linkText(resolver, from, to, found);

  // Recorded by the write that succeeded, for undo.
  let eol = "\n";
  let sep = "";
  const written = await rewrite(vault, from, (source) => {
    eol = source.includes("\r\n") ? "\r\n" : "\n";
    sep = source === "" || source.endsWith("\n") ? "" : eol;
    const next = source + sep + line + eol;
    // Written only if, in the page as it would be, our line is one whole link that reaches `to`: not inside an open
    // code block, not a name that cannot be spelled as a link. Ranges are UTF-16 offsets into the whole source.
    const start = source.length + sep.length;
    const ref = parsePage(from, next).references.at(-1);
    const reached = ref && resolver.resolve(from, ref);
    return ref?.range.start === start && ref.range.end === start + line.length && reached?.state === "resolved" && reached.path === to ? next : null;
  });
  if (written !== "written") return { outcome: written };

  // Undoable only while our line is still the page's last line, whole and unchanged; then only it (and the line break
  // it needed) goes.
  const without = (source: string): string | null => {
    const tail = line + eol;
    if (!source.endsWith(tail)) return null;
    const rest = source.slice(0, -tail.length);
    if (rest !== "" && !rest.endsWith("\n")) return null;
    return sep && rest.endsWith(sep) ? rest.slice(0, -sep.length) : rest;
  };
  const undo = async (): Promise<"undone" | "changed"> => {
    if (!(await flushAll())) return "changed";
    return (await rewrite(vault, from, without)) === "written" ? "undone" : "changed";
  };
  return { outcome: "linked", undo };
}
