-- Page tags and date (ADR-0051 rule 16, capability `page-tags`): the tags of a page (frontmatter `tags`/`tag` and inline
-- `#tags` outside code, the rules of `parsePage` in `@thoth/content`) and its frontmatter `date` (YYYY-MM-DD when it is a
-- valid date), derived by the server on every write and returned on tree nodes for the Timeline. Tree nodes are already
-- filtered for visibility (ADR-0042), so a hidden page's tags never leave the server.
--
-- Additive and nullable only, so it is safe to apply to a live database while an older server build runs: older builds
-- never read the columns. `tags` NULL means "not derived yet" (the page was written before this migration); a page with
-- no tags has an empty array. `page_date` NULL means no valid date. Production runs with MIGRATE_ON_START=false: apply
-- this migration (`node src/cli.ts migrate`, direct URL) before deploying a server build that lists `page-tags`.
--
-- SQL cannot parse Markdown, so this migration cannot fill the columns. After it, run `node src/cli.ts backfill-tags`
-- once (direct URL, safe to repeat and to run while the server is serving). Until then, pages written earlier have no
-- tags in the Timeline. Like the page kind (009), these live on the page row only and never touch page_revisions.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS tags text[];
ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_date text;
