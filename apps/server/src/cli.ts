/**
 * Admin CLI. Reads DATABASE_URL from the environment.
 *
 *   node src/cli.ts migrate
 *   node src/cli.ts backfill-kind [--batch <n>]
 *   node src/cli.ts create-user --name "Ada" [--email ada@example.org]
 *   node src/cli.ts create-workspace --name "Team" [--export-restricted]
 *   node src/cli.ts add-member --workspace <id> --user <id> --role owner|editor|viewer
 *   node src/cli.ts create-token --user <id> --out <file> [--label <text>] [--expires-days <n>]
 *   node src/cli.ts revoke-token --token-id <id>
 *   node src/cli.ts maintenance
 *   node src/cli.ts feedback list [--since <date | 7d | 12h>]
 *   node src/cli.ts feedback export --json [--since <date | 7d | 12h>]
 *
 * IDs are printed to stdout. A token is written only to the --out file (mode 0600); it is never
 * printed, logged, or accepted on the command line.
 */
import { parseArgs } from "node:util";
import { BACKFILL_BATCH_DEFAULT, BACKFILL_BATCH_MAX, backfillPageKind } from "./backfill.ts";
import { AdminError, addMember, createToken, createUser, createWorkspace, revokeToken } from "./admin.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createDatabase } from "./db.ts";
import { ApiError } from "./errors.ts";
import { runMaintenance } from "./maintenance.ts";
import { FsBlobStore, PgBlobStore } from "./blob.ts";
import { migrate } from "./migrate.ts";
import { listFeedback, type FeedbackRow } from "./feedback.ts";

const USAGE = `Usage: node src/cli.ts <command> [options]   (DATABASE_URL must be set)

Commands:
  migrate                                                   apply pending SQL migrations
  backfill-kind [--batch <n>]                               fill in the page kind (ADR-0017) of pages and change entries written
                                                            before migration 009; run once after it, safe to repeat and to run
                                                            while the server is serving; prints the counts as JSON
  create-user --name <name> [--email <email>]               prints the user ID
  create-workspace --name <name> [--export-restricted] [--owner <user id>]   prints the workspace ID
  add-member --workspace <id> --user <id> --role <role>     role: owner | editor | viewer
  create-token --user <id> --out <file> [--label <text>] [--expires-days <n>]
                                                            writes the token to <file> (mode 0600); prints the token ID
  revoke-token --token-id <id>
  maintenance                                               purge workspaces deleted more than 30 days ago, prune old revisions
                                                            (REVISION_RETENTION_DAYS), expired idempotency records, rate-limit
                                                            rows, sign-in rows and feedback older than 90 days; prints what was removed
  feedback list [--since <when>]                            feedback from users (ADR-0033), newest first; <when> is a date
                                                            (2026-10-27, or an ISO time) or an age (7d, 12h)
  feedback export --json [--since <when>]                   the same as a JSON array on stdout

create-user, create-workspace and add-member enforce the quotas of the environment (THOTH_PROFILE, MAX_*).
create-workspace takes --owner <user id> to make that user the owner (and count it against MAX_WORKSPACES_PER_ACCOUNT).
Run migrate with a direct (non-pooled) DATABASE_URL.`;

const fail = (message: string): never => {
  throw new AdminError(message);
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      name: { type: "string" },
      email: { type: "string" },
      workspace: { type: "string" },
      user: { type: "string" },
      owner: { type: "string" },
      role: { type: "string" },
      out: { type: "string" },
      label: { type: "string" },
      "token-id": { type: "string" },
      "expires-days": { type: "string" },
      batch: { type: "string" },
      since: { type: "string" },
      json: { type: "boolean" },
      "export-restricted": { type: "boolean" },
    },
    strict: true,
    allowPositionals: true,
  });
  // Only `feedback` has a sub-command; anything else positional is a mistake.
  const sub = command === "feedback" ? positionals.shift() : undefined;
  if (positionals.length > 0) fail(`unexpected argument: ${positionals[0]}`);
  if (command === "feedback" && sub !== "list" && sub !== "export") fail("feedback needs a sub-command: list or export --json");
  const since = values.since === undefined ? undefined : sinceFrom(values.since);
  const url = process.env.DATABASE_URL;
  if (!url) throw new ConfigError("DATABASE_URL is required");
  // Quotas and retention come from the same environment as the server (the profile applies here too).
  const config = loadConfig(process.env);
  const db = createDatabase(url, { max: 2 });
  try {
    switch (command) {
      case "migrate": {
        const result = await migrate(db.pool);
        console.log(result.applied.length ? `applied: ${result.applied.join(", ")}` : `up to date (${result.alreadyApplied} migration(s) applied)`);
        // SQL cannot parse Markdown: pages written before 009 have no kind until the backfill has run.
        if (result.applied.includes("009_page_kind.sql")) console.log("hint: existing pages have no page kind yet. Run `node src/cli.ts backfill-kind` once so that folders written earlier show as folders (ADR-0017).");
        return 0;
      }
      case "backfill-kind": {
        const raw = values.batch;
        if (raw !== undefined && (!/^[1-9]\d{0,3}$/.test(raw) || Number(raw) > BACKFILL_BATCH_MAX)) fail(`--batch must be an integer from 1 to ${BACKFILL_BATCH_MAX} (default ${BACKFILL_BATCH_DEFAULT})`);
        const result = await backfillPageKind(db, raw === undefined ? {} : { batchSize: Number(raw) });
        console.log(JSON.stringify(result));
        return 0;
      }
      case "create-user": {
        const { id } = await createUser(db, { name: values.name ?? fail("--name is required"), ...(values.email ? { email: values.email } : {}) }, config);
        console.log(id);
        return 0;
      }
      case "create-workspace": {
        const { id } = await createWorkspace(db, { name: values.name ?? fail("--name is required"), exportRestricted: values["export-restricted"] === true, ...(values.owner ? { ownerId: values.owner } : {}) }, config);
        console.log(id);
        return 0;
      }
      case "add-member": {
        await addMember(db, { workspaceId: values.workspace ?? fail("--workspace is required"), userId: values.user ?? fail("--user is required"), role: values.role ?? fail("--role is required") }, config);
        console.log("ok");
        return 0;
      }
      case "maintenance": {
        const blobs = config.blobStore === "postgres" ? new PgBlobStore(db) : new FsBlobStore(config.blobDir);
        const result = await runMaintenance(db, { revisionRetentionDays: config.revisionRetentionDays, blobs });
        console.log(JSON.stringify(result));
        return 0;
      }
      case "feedback": {
        const rows = await listFeedback(db, since ? { since } : {});
        if (sub === "export") {
          if (values.json !== true) fail("feedback export needs --json (the only format)");
          console.log(safeJson(rows.map((r) => (r.diagnostics ? { ...r, diagnostics: { log: r.diagnostics.log.map(printable) } } : r))));
        } else console.log(rows.length === 0 ? "no feedback" : rows.map(formatFeedback).join("\n\n"));
        return 0;
      }
      case "create-token": {
        const days = values["expires-days"];
        if (days !== undefined && !/^[1-9]\d{0,4}$/.test(days)) fail("--expires-days must be a positive integer");
        const { tokenId } = await createToken(db, {
          userId: values.user ?? fail("--user is required"),
          outFile: values.out ?? fail("--out is required: the token is written only to that file"),
          ...(values.label ? { label: values.label } : {}),
          ...(days === undefined ? {} : { expiresInDays: Number(days) }),
        });
        console.log(tokenId);
        return 0;
      }
      case "revoke-token": {
        const revoked = await revokeToken(db, values["token-id"] ?? fail("--token-id is required"));
        console.log(revoked ? "revoked" : "no active token with that ID");
        return revoked ? 0 : 1;
      }
      default:
        console.error(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } finally {
    await db.close();
  }
}

/** `--since`: a date or ISO time, or an age like `7d` or `12h`. */
function sinceFrom(raw: string): Date {
  const age = /^([1-9]\d{0,4})([dh])$/.exec(raw);
  if (age) return new Date(Date.now() - Number(age[1]) * (age[2] === "d" ? 86_400_000 : 3_600_000));
  const at = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw) ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) fail("--since must be a date (2026-10-27), an ISO time, or an age like 7d or 12h");
  return at!;
}

/** Messages are typed by strangers: control characters (terminal escapes) never reach the terminal as such. */
const printable = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const safeJson = (value: unknown): string => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function formatFeedback(row: FeedbackRow): string {
  const context = row.context ? Object.entries(row.context).map(([k, v]) => `${k}=${v}`).join(" ") : "";
  const head = [row.createdAt, row.kind, row.email ?? "-", row.accountId ? `account ${row.accountId}` : "anonymous", context, row.diagnostics ? `log: ${row.diagnostics.log.length} lines` : ""].filter((x) => x !== "").join("  ");
  return `${printable(head)}\n${printable(row.message).replace(/^/gm, "    ")}`;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  // Messages may quote driver errors; never let a connection string through.
  console.error(`error: ${message.replace(/postgres(ql)?:\/\/\S+/g, "postgres://[redacted]")}`);
  process.exitCode = error instanceof AdminError || error instanceof ConfigError || (error instanceof ApiError && error.code === "quota_exceeded") || (error as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? 2 : 1;
}
