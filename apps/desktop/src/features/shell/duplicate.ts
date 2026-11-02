/**
 * Duplicate in the Private Space (ADR-0046): a page, or a folder with everything in it, copied as new files. Every
 * write is a create (`expectedHash: null`), so nothing existing is ever replaced.
 *
 * - The copy is named by `label` ("Alpha (copy)", then "Alpha (copy 2)"…) and sits right after the original, or at
 *   the end of the folder it goes into; the folder's color and the order inside it come along (`.thoth/order.json`).
 * - Each copied page gets a new `thoth_id`. Links between pages of the copied set point at the copies; links to
 *   anything else still reach what they reached (rewritten only where the copy's place changes the spelling).
 * - Images a page shows from outside the copied set are copied next to the page's copy under their own name, or
 *   `name-2.png`… when taken (ADR-0028), and the copy's `src` follows.
 * - Structure only: each page keeps only its title; images and other files stay behind.
 * - A failure part-way removes every file and folder it created, then throws.
 */
import { LinkResolver, parseFrontmatter, parsePage, updateFrontmatter, type ParsedReference } from "@thoth/content";
import { basename, collisionKey, dirname, extname, isMarkdownPath, newStableId, relativeLink, stripExtension } from "@thoth/domain";
import { ConflictError, readOrder, writeOrder, type OrderRecord, type Vault } from "@thoth/local-store";
import { applyRewrites, type ClassifiedReference } from "@thoth/transfer";
import { copyName } from "@thoth/app-ui/order/duplicate.ts";
import { imageMimeType } from "@thoth/app-ui/editor/media.ts";
import { placeName } from "./arrange.ts";
import { retitle } from "./rename.ts";

export interface PrivateDuplicate {
  /** The page or folder to copy. */
  source: string;
  kind: "page" | "folder";
  /** The folder the copy goes into ("" is the top level). */
  into: string;
  structureOnly: boolean;
  /** The copy's name for try `n` (1, 2, …): `tree.copyName`. */
  label(name: string, n: number): string;
  /** `into`'s items in display order (names), and where among them the copy goes. */
  place: { siblings: readonly string[]; index: number };
}

export interface Duplicated {
  /** The copy of `source`. */
  path: string;
  order: OrderRecord;
  /** Every file written, in order. */
  files: string[];
}

const join = (folder: string, name: string) => (folder === "" ? name : `${folder}/${name}`);
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
const encoder = new TextEncoder();
const isImageRef = (ref: ParsedReference) => ref.syntax === "markdown-image" || ref.syntax === "embed";

export async function duplicatePrivate(vault: Vault, input: PrivateDuplicate): Promise<Duplicated> {
  const files = (await vault.scanFiles()).files;
  const pages = await vault.listPages();
  const folders = await vault.listFolders();
  const before = new LinkResolver(files, pages.map((p) => ({ path: p.path, aliases: p.aliases })));
  const taken = new Set([...files, ...folders].map(collisionKey));
  const isFree = (path: string) => !taken.has(collisionKey(path));
  const claim = (path: string) => taken.add(collisionKey(path));

  const created: { path: string; hash: string }[] = [];
  const madeFolders: string[] = [];
  const write = async (path: string, data: Uint8Array) => {
    claim(path);
    created.push({ path, hash: await vault.writeFileAtomic(path, data, { expectedHash: null }) });
  };

  try {
    // The copy's name, and where every copied path goes.
    let root: string;
    const ext = input.kind === "page" ? extname(input.source) : "";
    const stem = input.kind === "page" ? stripExtension(basename(input.source)) : basename(input.source);
    let suffix = 1;
    const labelFor = (name: string) => copyName(
      (candidate) => isFree(join(input.into, `${candidate}${ext}`)),
      (n) => {
        suffix = n;
        return input.label(name, n);
      },
    );
    if (input.kind === "folder") {
      for (;;) {
        root = join(input.into, labelFor(stem));
        try {
          await vault.createFolder(root);
          claim(root);
          madeFolders.push(root);
          break;
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error;
          claim(root); // someone made it meanwhile: the next name
        }
      }
    } else root = join(input.into, `${labelFor(stem)}${ext}`);
    const moved = (path: string) => (input.kind === "folder" ? root + path.slice(input.source.length) : root);

    const members = input.kind === "folder" ? files.filter((f) => within(f, input.source)) : [input.source];
    const memberPages = members.filter(isMarkdownPath);
    const copies = new Map(members.filter((m) => !input.structureOnly || isMarkdownPath(m)).map((m) => [m, moved(m)]));

    // Folders inside, so empty ones come along too (parents first: `listFolders` is sorted).
    if (input.kind === "folder") {
      for (const folder of folders.filter((f) => f !== input.source && within(f, input.source))) {
        await vault.createFolder(moved(folder));
        madeFolders.push(moved(folder));
      }
    }

    // Read every page once; images shown from outside the copied set are copied next to the page's copy.
    const sources = new Map<string, Awaited<ReturnType<Vault["readPage"]>>>();
    for (const page of memberPages) sources.set(page, await vault.readPage(page));
    const imageCopies = new Map<string, string>();
    if (!input.structureOnly) {
      for (const page of memberPages) {
        const read = sources.get(page)!;
        if (!read.editable) continue;
        for (const ref of parsePage(page, read.source).references) {
          if (!isImageRef(ref) || ref.external || ref.target === "") continue;
          const hit = before.resolve(page, ref);
          if (hit.state !== "resolved" || isMarkdownPath(hit.path) || !imageMimeType(hit.path) || copies.has(hit.path) || imageCopies.has(hit.path)) continue;
          const name = basename(hit.path);
          const dot = name.lastIndexOf(".");
          const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
          const at = dirname(moved(page));
          const target = join(at, copyName((c) => isFree(join(at, c)), (n) => (n === 1 ? name : `${base}-${n}${extension}`)));
          await write(target, await vault.fs.readFile(hit.path));
          imageCopies.set(hit.path, target);
        }
      }
      // Everything else in the folder, byte for byte.
      for (const file of members) if (!isMarkdownPath(file)) await write(moved(file), await vault.fs.readFile(file));
    }

    // Links are checked against the vault as it will be, with every copy in it.
    const after = new LinkResolver(
      [...files, ...copies.values(), ...imageCopies.values()],
      [...pages.map((p) => ({ path: p.path, aliases: p.aliases })), ...pages.filter((p) => copies.has(p.path)).map((p) => ({ path: copies.get(p.path)!, aliases: p.aliases }))],
    );
    for (const page of memberPages) {
      const read = sources.get(page)!;
      const to = moved(page);
      if (!read.editable) {
        if (!input.structureOnly) await write(to, await vault.fs.readFile(page));
        continue;
      }
      const isRoot = page === input.source;
      const title = read.document.title;
      const frontmatter = parseFrontmatter(read.source).data;
      const fmTitle = frontmatter["title"];
      const copyTitle = isRoot ? input.label(title, suffix) : title;
      let text: string;
      if (input.structureOnly) {
        text = updateFrontmatter(`# ${copyTitle}\n`, { thoth_id: newStableId(), ...(typeof fmTitle === "string" ? { title: copyTitle } : {}) });
      } else {
        text = applyRewrites(read.source, relinked(page, to, read.source, before, after, (p) => copies.get(p) ?? imageCopies.get(p) ?? p), { labelBareWikilinks: true });
        if (frontmatter["thoth_id"] !== undefined) text = updateFrontmatter(text, { thoth_id: newStableId() });
        if (isRoot) {
          text = retitle(to, text, stem, stripExtension(basename(to)));
          if (typeof fmTitle === "string" && fmTitle.trim() !== stem) text = updateFrontmatter(text, { title: copyTitle });
        }
      }
      await write(to, encoder.encode(text));
    }

    // The order record: the copy right where it was asked for, and the folder's own order and colors under it.
    const record = await readOrder(vault);
    const next: OrderRecord = { ...record, folders: { ...record.folders }, ...(record.colors ? { colors: { ...record.colors } } : {}) };
    if (input.kind === "folder") {
      for (const [key, list] of Object.entries(record.folders)) if (within(key, input.source)) next.folders[moved(key)] = [...list];
      for (const [key, color] of Object.entries(record.colors ?? {})) if (within(key, input.source)) next.colors![moved(key)] = color;
    }
    next.folders[input.into] = placeName(input.place.siblings, basename(root), input.place.index);
    await writeOrder(vault, next);
    return { path: root, order: next, files: created.map((c) => c.path) };
  } catch (error) {
    await undo(vault, created, madeFolders);
    throw error;
  }
}

/** Removes what a failed duplicate made: files newest first, then its folders, deepest first. Best effort. */
async function undo(vault: Vault, files: readonly { path: string; hash: string }[], folders: readonly string[]): Promise<void> {
  for (const file of [...files].reverse()) await vault.deleteFileAtomic(file.path, { expectedHash: file.hash }).catch(() => undefined);
  for (const folder of [...folders].reverse()) await vault.removeEmptyFolder(folder).catch(() => undefined);
}

/**
 * The references of `source` (the page at `from`, copied to `to`) whose target must change so that, from `to`, each
 * still reaches `want(what it reached from from)`. A reference that already does, or that reached nothing, is kept.
 */
export function relinked(from: string, to: string, source: string, before: LinkResolver, after: LinkResolver, want: (path: string) => string): ClassifiedReference[] {
  const out: ClassifiedReference[] = [];
  for (const reference of parsePage(from, source).references) {
    if (reference.external || reference.target === "") continue;
    const hit = before.resolve(from, reference);
    if (hit.state !== "resolved") continue;
    const target = want(hit.path);
    const reaches = (spelling: string) => {
      const r = after.resolve(to, { syntax: reference.syntax, target: spelling, external: false });
      return r.state === "resolved" && r.path === target;
    };
    if (reaches(reference.target)) continue;
    const wiki = reference.syntax === "wikilink" || reference.syntax === "embed";
    const full = isMarkdownPath(target) ? stripExtension(target) : target;
    const candidates = wiki ? [isMarkdownPath(target) ? stripExtension(basename(target)) : basename(target), full] : [relativeLink(to, target)];
    const spelling = candidates.find((c) => !(wiki && /[[\]|#\n]/.test(c)) && reaches(c));
    if (spelling !== undefined) out.push({ sourcePath: from, reference, class: "included", newTarget: spelling });
  }
  return out;
}
