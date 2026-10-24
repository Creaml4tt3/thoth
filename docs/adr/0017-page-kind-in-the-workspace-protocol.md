# ADR-0017: Page kind in the workspace protocol

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** project owner (approved 2026-10-25)
- **Refines:** ADR-0004 (workspace protocol and capability negotiation), ADR-0016 rule 3 (folders in workspaces).

## Context

ADR-0016 rule 3 made folders in workspaces ordinary pages marked `thoth_kind: folder` in their frontmatter, "with no
server or protocol change". That kept the protocol small, but it has a cost the client now pays on every start: the
tree response lists only `{ id, parentId, title, position, revisionId, updatedAt }`, so the only way to learn which
pages are folders is to download every child page and read its frontmatter. The cost grows with the number of
pages, and it is paid again whenever a revision changes. A hosted workspace with a few hundred pages needs a few
hundred requests to draw the tree.

Page content is opaque to the protocol (protocol README, section 7): the server stores Markdown byte for byte and
never interprets it. The folder marker is the one piece of content that the tree needs. This ADR lets a server
publish it as metadata, and keeps everything else opaque.

## Decision

1. **A new optional `kind` member.** Its value is `"page"` or `"folder"`. An absent or `null` `kind` means
   "unknown", and clients treat unknown as a page. It appears on:
   - tree nodes (`getWorkspaceTree`);
   - page metadata (`metadata.kind` of a page resource, `getPage` and `putPage`);
   - change entries of kind `page.created` and `page.updated`. The entry already has a `kind` member (the change
     kind, such as `page.updated`), so the page kind travels there as **`pageKind`**.
2. **A new capability, `page-kind`.** A server lists it when it fills in the page kind. Clients MUST NOT expect
   `kind` from a server that does not list it, and keep finding folders the way ADR-0016 describes. A server that
   lists it MAY still return `null` for a page whose kind it does not know (see rule 4).
3. **The server derives the kind; clients never send it.** `PageWrite` does not gain a member. On every write that
   stores Markdown (`putPage`, including the first revision, and the transfer commit) the server reads one frontmatter
   key, `thoth_kind`, and stores the result on the page row:
   - the frontmatter parses and `thoth_kind` is the string `folder`: `"folder"`;
   - the frontmatter parses (or there is none) and `thoth_kind` is anything else or absent: `"page"`;
   - the frontmatter is malformed: `null` (unknown). A write is never refused because of its frontmatter.

   `thoth_kind` is the **only** frontmatter key a server reads. The rest of the Markdown stays opaque, and the
   server still stores it byte for byte. Frontmatter is parsed with the same rules the clients use (`parseFrontmatter`
   in `@thoth/content`), so both sides agree on which pages are folders.
4. **Moves keep the kind.** `movePage` changes only the parent and position, so the page's kind is unchanged and the
   tree node and the change entry it returns carry it. A page's kind changes only with a new revision.
5. **Historical revisions.** `GET ...?revision=<id>` reports the kind of the revision returned. For the current
   revision that is the stored value; for an older one the server reads that revision's frontmatter.
6. **Rows that existed before the capability.** The database migration only adds a nullable column, because SQL cannot
   parse Markdown. Existing pages therefore read as `null` until an operator runs the reference server's one-time
   backfill (`node src/cli.ts backfill-kind`). Until then a folder written earlier shows as a page. `migrate` prints a
   reminder to run it.
7. **Additive within protocol 1.0.** Old clients ignore `kind` and `pageKind`. Old servers do not list `page-kind` and
   omit both. The conformance suite checks them only when the capability is listed.
8. **Clients.** When the server lists `page-kind`, the tree is drawn from `kind` alone: no child page is downloaded to
   find folders. Without it, the client keeps reading each child page. A page opened for editing is still read in full,
   as before.
9. The protocol README, section 7, says that a server which lists `page-kind` reads `thoth_kind`, and that this is the
   only exception to "page content is opaque".

## Consequences

- Positive: the tree costs the same number of requests whatever the page count, and folder icons appear without
  downloading content.
- Positive: nothing changes for old clients and servers, and the Markdown file format is unchanged (ADR-0001, ADR-0002).
- Negative: a server now parses YAML on every write. The frontmatter is a small block at the top of a bounded page
  (the Markdown size limit applies), and the parser never fails a write.
- Negative: a rule about one frontmatter key now lives in the server as well as the clients. Both use the same parser
  and the shared helper `pageKindOf` in `@thoth/workspace-protocol`.
- Negative: the change entry names the page kind `pageKind`, not `kind`, because `kind` already names the change.
- Negative: operators of an existing database must run the backfill once (rule 6).
- Follow-up: migration 009, the backfill command, the schemas, OpenAPI and conformance checks, the workspace client and
  the tree (implementation plan, Phase 3b).

## Alternatives considered

- **Let clients send `kind` in `putPage`.** Rejected: it duplicates the frontmatter and the two can disagree. The file
  must stay the single source of truth, so another app that edits it cannot desynchronize the tree.
- **Return a `thoth_kind` frontmatter excerpt, or all frontmatter, in the tree.** Rejected: it opens page content to
  interpretation by servers and grows the tree response.
- **A server-side folder type with its own route.** Rejected for the reasons given in ADR-0016: it needs a transfer
  mapping and a protocol change for little gain.
- **Parse Markdown in the migration.** Not possible in SQL, so the backfill is a command.
- **Reuse `kind` in change entries.** Not possible, because the member already holds the change kind.
- **An open set of kinds, with `x-` vendor values.** Not needed now. A third kind would be a new decision.

## Spec references

Section 8 and 11 (workspace protocol, capability registry), as in ADR-0004.

## Open questions

None.
