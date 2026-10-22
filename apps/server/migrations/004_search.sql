-- Search is a case-insensitive substring match backed by trigram indexes (pg_trgm).
-- PostgreSQL full-text search does not segment Thai, which has no spaces between words;
-- a substring match works for every script. See README, "Deviations".
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX page_revisions_markdown_trgm ON page_revisions USING gin (markdown gin_trgm_ops);
CREATE INDEX page_revisions_title_trgm ON page_revisions USING gin (title gin_trgm_ops);
