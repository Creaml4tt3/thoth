/**
 * Local index schema (spec §6.3, ADR-001).
 *
 * Everything here is a cache derived from vault files and durable `.thoth/`
 * JSON records; a version mismatch simply drops and rebuilds the index.
 */
export const INDEX_SCHEMA_VERSION = 2;

export const INDEX_DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  -- ID claimed by the file (thoth_id or provisional); differs from id for duplicate-ID losers.
  claimed_id TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  path_key TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  stable_id INTEGER NOT NULL,
  frontmatter_error TEXT,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_path_key ON pages(path_key);
CREATE INDEX IF NOT EXISTS pages_claimed_id ON pages(claimed_id);

CREATE TABLE IF NOT EXISTS page_aliases (page_id TEXT NOT NULL, alias TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS page_aliases_page ON page_aliases(page_id);
CREATE TABLE IF NOT EXISTS page_tags (page_id TEXT NOT NULL, tag TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS page_tags_page ON page_tags(page_id);
CREATE INDEX IF NOT EXISTS page_tags_tag ON page_tags(tag);

CREATE TABLE IF NOT EXISTS blocks (
  page_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  type TEXT NOT NULL,
  anchor TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  PRIMARY KEY (page_id, ord)
);

CREATE TABLE IF NOT EXISTS refs (
  source_page_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  syntax TEXT NOT NULL,
  target TEXT NOT NULL,
  fragment TEXT,
  external INTEGER NOT NULL,
  resolution TEXT NOT NULL,
  target_path TEXT,
  line INTEGER NOT NULL,
  PRIMARY KEY (source_page_id, ord)
);
CREATE INDEX IF NOT EXISTS refs_target_path ON refs(target_path);

CREATE TABLE IF NOT EXISTS attachments (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  mime_type TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_content USING fts5(
  page_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2'
);
-- Trigram index for scripts written without word separators (e.g. Thai).
CREATE VIRTUAL TABLE IF NOT EXISTS search_trigram USING fts5(
  page_id UNINDEXED, title, body, tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS index_warnings (
  path TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS index_warnings_path ON index_warnings(path);

-- Projections of durable records (ADR-001 §2); reserved for P2/P3.
CREATE TABLE IF NOT EXISTS external_locations (
  page_id TEXT NOT NULL,
  workspace_url TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  PRIMARY KEY (page_id, workspace_url)
);
CREATE TABLE IF NOT EXISTS sync_state (
  page_id TEXT NOT NULL,
  workspace_url TEXT NOT NULL,
  remote_revision TEXT,
  base_hash TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (page_id, workspace_url)
);
CREATE TABLE IF NOT EXISTS operation_journal (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS import_items (
  job_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  state TEXT NOT NULL,
  dest_path TEXT,
  PRIMARY KEY (job_id, item_key)
);
`;
