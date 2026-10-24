import { pageKindOf, type PageKind } from "@thoth/workspace-protocol";
import type { Database } from "./db.ts";

export const BACKFILL_BATCH_DEFAULT = 200;
export const BACKFILL_BATCH_MAX = 1000;

export interface BackfillKindResult {
  pages: { scanned: number; updated: number; unknown: number };
  changes: { scanned: number; updated: number; unknown: number };
}

export interface BackfillKindOptions {
  /** Rows read and written per statement (1 to 1000, default 200). Markdown is read, so keep it small on small instances. */
  batchSize?: number;
  /** Called after every batch, for progress output. */
  onBatch?: (progress: { table: "pages" | "changes"; scanned: number; updated: number }) => void;
}

interface PageBatchRow {
  workspace_id: string;
  id: string;
  current_revision_id: string;
  markdown: string;
}
interface ChangeBatchRow {
  workspace_id: string;
  seq: number;
  markdown: string;
}

/**
 * Fills in the page kind (ADR-0017, migration 009) of rows written before the column existed: SQL cannot parse
 * Markdown, so this reads each row's revision and derives the kind exactly as `putPage` does.
 *
 * - `pages.kind` of every page (deleted ones too) whose kind is NULL, from its current revision;
 * - `changes.page_kind` of every `page.created` / `page.updated` entry whose kind is NULL, from the revision the
 *   entry names. An entry whose revision was removed by retention stays NULL (unknown).
 *
 * Safe to repeat and to run while the server is serving, with no workspace lock:
 *  - rows are visited by key, in order, in batches, so a page with malformed frontmatter (which stays NULL) is read
 *    once per run, not forever;
 *  - a page is updated only if it is still NULL and still at the revision that was read, so it never overwrites a
 *    kind that a concurrent write has just derived;
 *  - only the kind column changes: `updated_at`, revisions and the change cursor are untouched, so clients see no
 *    new change.
 */
export async function backfillPageKind(db: Database, options: BackfillKindOptions = {}): Promise<BackfillKindResult> {
  const batch = options.batchSize ?? BACKFILL_BATCH_DEFAULT;
  if (!Number.isInteger(batch) || batch < 1 || batch > BACKFILL_BATCH_MAX) throw new RangeError(`batch size must be an integer from 1 to ${BACKFILL_BATCH_MAX}`);
  const result: BackfillKindResult = { pages: { scanned: 0, updated: 0, unknown: 0 }, changes: { scanned: 0, updated: 0, unknown: 0 } };

  let after: { workspace: string; id: string } | null = null;
  for (;;) {
    const page: { rows: PageBatchRow[] } = await db.query<PageBatchRow>(
      `SELECT p.workspace_id, p.id, p.current_revision_id, r.markdown
         FROM pages p JOIN page_revisions r ON r.id = p.current_revision_id
        WHERE p.kind IS NULL AND ($1::text IS NULL OR (p.workspace_id, p.id) > ($1, $2::uuid))
        ORDER BY p.workspace_id, p.id LIMIT $3`,
      [after?.workspace ?? null, after?.id ?? null, batch],
    );
    const rows = page.rows;
    if (rows.length === 0) break;
    const kinds = rows.map((row) => pageKindOf(row.markdown));
    const known = rows.flatMap((row, i) => (kinds[i] === null ? [] : [{ row, kind: kinds[i] as PageKind }]));
    let updated = 0;
    if (known.length > 0) {
      const res = await db.query(
        `UPDATE pages p SET kind = v.kind
           FROM unnest($1::text[], $2::uuid[], $3::text[], $4::text[]) AS v(workspace_id, id, revision_id, kind)
          WHERE p.workspace_id = v.workspace_id AND p.id = v.id AND p.current_revision_id = v.revision_id AND p.kind IS NULL`,
        [known.map((k) => k.row.workspace_id), known.map((k) => k.row.id), known.map((k) => k.row.current_revision_id), known.map((k) => k.kind)],
      );
      updated = res.rowCount ?? 0;
    }
    result.pages.scanned += rows.length;
    result.pages.updated += updated;
    result.pages.unknown += rows.length - known.length;
    options.onBatch?.({ table: "pages", scanned: result.pages.scanned, updated: result.pages.updated });
    const last = rows[rows.length - 1]!;
    after = { workspace: last.workspace_id, id: last.id };
    if (rows.length < batch) break;
  }

  let afterChange: { workspace: string; seq: number } | null = null;
  for (;;) {
    const page: { rows: ChangeBatchRow[] } = await db.query<ChangeBatchRow>(
      `SELECT c.workspace_id, c.seq, r.markdown
         FROM changes c JOIN page_revisions r ON r.id = c.revision_id
        WHERE c.page_kind IS NULL AND c.kind IN ('page.created', 'page.updated')
          AND ($1::text IS NULL OR (c.workspace_id, c.seq) > ($1, $2::bigint))
        ORDER BY c.workspace_id, c.seq LIMIT $3`,
      [afterChange?.workspace ?? null, afterChange?.seq ?? null, batch],
    );
    const rows = page.rows;
    if (rows.length === 0) break;
    const kinds = rows.map((row) => pageKindOf(row.markdown));
    const known = rows.flatMap((row, i) => (kinds[i] === null ? [] : [{ row, kind: kinds[i] as PageKind }]));
    let updated = 0;
    if (known.length > 0) {
      const res = await db.query(
        `UPDATE changes c SET page_kind = v.kind
           FROM unnest($1::text[], $2::bigint[], $3::text[]) AS v(workspace_id, seq, kind)
          WHERE c.workspace_id = v.workspace_id AND c.seq = v.seq AND c.page_kind IS NULL`,
        [known.map((k) => k.row.workspace_id), known.map((k) => k.row.seq), known.map((k) => k.kind)],
      );
      updated = res.rowCount ?? 0;
    }
    result.changes.scanned += rows.length;
    result.changes.updated += updated;
    result.changes.unknown += rows.length - known.length;
    options.onBatch?.({ table: "changes", scanned: result.changes.scanned, updated: result.changes.updated });
    const last = rows[rows.length - 1]!;
    afterChange = { workspace: last.workspace_id, seq: last.seq };
    if (rows.length < batch) break;
  }
  return result;
}
