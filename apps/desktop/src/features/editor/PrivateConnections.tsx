/**
 * Connections for a Private Space page (ADR-0050 rules 6): links and backlinks from the index; unlinked mentions from
 * the index's full-text search for the title, each candidate read from disk and matched. A mention is linked with a
 * compare-and-swap write on the hash just read, after every open page's pending edits are written.
 */
import { useMemo } from "react";
import { LinkResolver, encodeLinkDestination } from "@thoth/content";
import { basename, isMarkdownPath, relativeLink, stripExtension } from "@thoth/domain";
import { ConflictError, NotFoundError, type Vault } from "@thoth/local-store";
import { Connections, type ConnectedPage, type ConnectionsSource, type MentionRow } from "@thoth/app-ui/connections/Connections.tsx";
import { findMentions, linkMention, wikilinkFor, type Mention } from "@thoth/app-ui/connections/mentions.ts";
import { useSession } from "../../app/context.ts";

/** Candidate pages read for mentions, and mentions listed (ADR-0050 rule 6). */
export const MENTION_PAGES = 50;
export const MENTIONS_SHOWN = 100;

const once = (pages: ConnectedPage[]) => [...new Map(pages.map((p) => [p.ref, p])).values()];

/** The link that `from` writes to reach `target`, showing `found.text`: a wikilink when one resolves, else a Markdown link. */
export function linkText(resolver: LinkResolver, from: string, target: string, found: Mention): string {
  const reaches = (spelling: string) => {
    const r = resolver.resolve(from, { syntax: "wikilink", target: spelling, external: false });
    return r.state === "resolved" && r.path === target;
  };
  const spelling = [stripExtension(basename(target)), stripExtension(target)].find((c) => !/[[\]|#\n]/.test(c) && reaches(c));
  if (spelling !== undefined) return wikilinkFor(spelling, found.text, found.inTable);
  return `[${found.text}](${encodeLinkDestination(relativeLink(from, target))})`;
}

export function privateConnectionsSource(vault: Vault, path: string, title: string, deps: { revision: number; open: ConnectionsSource["open"]; flushAll(): Promise<boolean> }): ConnectionsSource {
  const titleOf = async () => new Map((await vault.listPages()).map((p) => [p.path, p.title]));
  return {
    title,
    tick: deps.revision,
    open: deps.open,
    async links() {
      const [outgoing, titles] = await Promise.all([vault.outgoingLinks(path), titleOf()]);
      return once(outgoing.flatMap((l) => (l.resolution === "resolved" && l.targetPath && l.targetPath !== path && isMarkdownPath(l.targetPath) ? [{ ref: l.targetPath, title: titles.get(l.targetPath) ?? l.targetPath, detail: l.targetPath }] : [])));
    },
    backlinks: async () => once((await vault.backlinks(path)).map((l) => ({ ref: l.sourcePath, title: l.sourceTitle, detail: l.sourcePath }))),
    async mentions() {
      const linking = new Set((await vault.backlinks(path)).map((l) => l.sourcePath));
      const hits = (await vault.search(title, MENTION_PAGES)).filter((h) => h.path !== path && !linking.has(h.path) && isMarkdownPath(h.path));
      const rows: MentionRow[] = [];
      let capped = false;
      for (const hit of hits) {
        const read = await vault.readPage(hit.path).catch(() => null);
        if (!read?.editable) continue;
        for (const mention of findMentions(read.source, title)) {
          if (rows.length >= MENTIONS_SHOWN) {
            capped = true;
            break;
          }
          rows.push({ page: { ref: hit.path, title: hit.title, detail: hit.path }, mention });
        }
      }
      return { rows, capped };
    },
    async link(row) {
      if (!(await deps.flushAll())) return "changed";
      const [scan, pages, folders] = await Promise.all([vault.scanFiles(), vault.listPages(), vault.listFolders()]);
      const resolver = new LinkResolver(scan.files, pages.map((p) => ({ path: p.path, aliases: p.aliases })), folders);
      const from = row.page.ref;
      return linkMention(
        {
          read: () => vault.readPage(from).then((r) => (r.editable ? { source: r.source, hash: r.hash } : null), (e) => (e instanceof NotFoundError ? null : Promise.reject(e))),
          write: (source, expected) => vault.writePage(from, source, { expectedHash: expected }),
          isConflict: (e) => e instanceof ConflictError,
        },
        title,
        row.mention,
        (found) => linkText(resolver, from, path, found),
      );
    },
  };
}

/** The Connections panel under a Private Space page. */
export function PrivateConnections({ path, title }: { path: string; title: string }) {
  const { vault, revision, openPage, flushAll, refresh } = useSession();
  const source = useMemo(() => {
    const base = privateConnectionsSource(vault, path, title, { revision, open: openPage, flushAll });
    // The index is read again after a link is written, so the lists follow.
    return { ...base, link: async (row: MentionRow) => {
      const outcome = await base.link!(row);
      if (outcome === "linked") await refresh().catch(() => undefined);
      return outcome;
    } };
  }, [vault, path, title, revision, openPage, flushAll, refresh]);
  return <Connections source={source} />;
}
