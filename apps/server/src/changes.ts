import { SSE_EVENT_NAME, type ChangeEntry } from "@thoth/workspace-protocol";
import pg from "pg";
import { encodeCursor } from "./cursor.ts";
import type { Queryable } from "./db.ts";

export const NOTIFY_CHANNEL = "thoth_changes";

export interface NewChange {
  kind: "page.created" | "page.updated" | "page.deleted" | "attachment.created";
  actorId: string | null;
  pageId?: string;
  revisionId?: string;
  parentId?: string | null;
  title?: string;
  attachmentId?: string;
}

/**
 * Appends one entry to a workspace's change feed and returns its position.
 *
 * The caller MUST already hold the workspace row lock (`workspaceAccess(..., { lock: true })`).
 * That serializes writers per workspace, so `change_seq` is gap-free and commits in order: a reader
 * that has seen position N will never later see an entry at a position below N.
 */
export async function appendChange(tx: Queryable, workspaceId: string, change: NewChange, occurredAt: Date): Promise<number> {
  const seq = (await tx.query<{ change_seq: number }>("UPDATE workspaces SET change_seq = change_seq + 1 WHERE id = $1 RETURNING change_seq", [workspaceId])).rows[0]!.change_seq;
  await tx.query(
    `INSERT INTO changes (workspace_id, seq, kind, occurred_at, actor_id, page_id, revision_id, parent_id, title, attachment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [workspaceId, seq, change.kind, occurredAt, change.actorId, change.pageId ?? null, change.revisionId ?? null, change.parentId ?? null, change.title ?? null, change.attachmentId ?? null],
  );
  return seq;
}

export interface ChangeRow {
  seq: number;
  kind: string;
  occurred_at: Date;
  actor_id: string | null;
  page_id: string | null;
  revision_id: string | null;
  parent_id: string | null;
  title: string | null;
  attachment_id: string | null;
}

/** Entry IDs are unique within the workspace for the life of the feed: the position, prefixed. */
export function changeEntryOf(row: ChangeRow): ChangeEntry {
  return {
    id: `chg_${row.seq}`,
    kind: row.kind,
    occurredAt: row.occurred_at.toISOString(),
    actorId: row.actor_id,
    ...(row.page_id === null ? {} : { pageId: row.page_id }),
    ...(row.revision_id === null ? {} : { revisionId: row.revision_id }),
    ...(row.kind === "page.created" || row.kind === "page.updated" ? { parentId: row.parent_id } : {}),
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.attachment_id === null ? {} : { attachmentId: row.attachment_id }),
  };
}

export const changeCursorOf = (workspaceId: string, seq: number): string => encodeCursor("c", workspaceId, String(seq));

type Listener = (hint: { cursor?: string }) => void;

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

/**
 * Receives the `thoth_changes` NOTIFY messages on one dedicated connection and fans them out to the
 * SSE streams of this process. Every server instance runs one, so a write on any instance reaches the
 * subscribers of all instances. A hint is only a hint: after a reconnect the hub tells every
 * subscriber that it may have missed something, and clients recover by reading the feed.
 */
export class ChangeHub {
  readonly #connectionString: string;
  readonly #log: Logger;
  readonly #subscribers = new Map<string, Set<Listener>>();
  #client: pg.Client | null = null;
  #closed = false;
  #retry: NodeJS.Timeout | null = null;
  #attempt = 0;

  constructor(connectionString: string, log: Logger) {
    this.#connectionString = connectionString;
    this.#log = log;
  }

  /** Connects and starts listening. Resolves when LISTEN is active; throws if the database is unreachable. */
  async start(): Promise<void> {
    await this.#connect();
  }

  async #connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.#connectionString, keepAlive: true });
    client.on("notification", (msg) => this.#dispatch(msg.payload));
    const lost = (error?: Error) => {
      if (this.#client !== client) return;
      this.#client = null;
      client.removeAllListeners();
      client.on("error", () => undefined);
      void client.end().catch(() => undefined);
      if (!this.#closed) {
        this.#log.warn({ err: error?.message }, "change listener connection lost; reconnecting");
        this.#scheduleReconnect();
      }
    };
    client.on("error", lost);
    client.on("end", () => lost());
    await client.connect();
    this.#client = client;
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    this.#attempt = 0;
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#retry) return;
    const delay = Math.min(10_000, 250 * 2 ** this.#attempt++);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#connect().then(
        () => {
          // Notifications sent while we were disconnected are gone: tell everyone to look at the feed.
          for (const set of this.#subscribers.values()) for (const listener of set) listener({});
        },
        (error: Error) => {
          this.#log.warn({ err: error.message }, "change listener reconnect failed");
          this.#scheduleReconnect();
        },
      );
    }, delay);
    this.#retry.unref();
  }

  #dispatch(payload: string | undefined): void {
    let parsed: { w?: unknown; s?: unknown };
    try {
      parsed = JSON.parse(payload ?? "") as { w?: unknown; s?: unknown };
    } catch {
      return;
    }
    if (typeof parsed.w !== "string" || typeof parsed.s !== "number") return;
    const set = this.#subscribers.get(parsed.w);
    if (!set) return;
    const cursor = changeCursorOf(parsed.w, parsed.s);
    for (const listener of [...set]) {
      try {
        listener({ cursor });
      } catch (error) {
        this.#log.error({ err: error instanceof Error ? error.message : String(error) }, "change listener failed");
      }
    }
  }

  subscribe(workspaceId: string, listener: Listener): () => void {
    let set = this.#subscribers.get(workspaceId);
    if (!set) this.#subscribers.set(workspaceId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#subscribers.delete(workspaceId);
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#subscribers.clear();
    const client = this.#client;
    this.#client = null;
    if (client) {
      client.removeAllListeners();
      client.on("error", () => undefined);
      await client.end().catch(() => undefined);
    }
  }
}

export function sseFrame(workspaceId: string, cursor: string | undefined): string {
  return `event: ${SSE_EVENT_NAME}\ndata: ${JSON.stringify({ type: "changes.available", workspaceId, ...(cursor === undefined ? {} : { cursor }) })}\n\n`;
}
