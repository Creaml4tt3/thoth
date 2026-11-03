import type { OutgoingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";
import { API_BASE_PATH } from "@thoth/workspace-protocol";
import { workspaceAccess } from "../access.ts";
import { changeCursorOf, sseFrame } from "../changes.ts";
import type { Queryable } from "../db.ts";
import type { Deps } from "../deps.ts";
import { ApiError } from "../errors.ts";
import { principalOf } from "../http.ts";
import { HIDDEN } from "../visibility.ts";

const KEEPALIVE_MS = 15_000;
const REVALIDATE_MS = 30_000;

/** Open streams, so shutdown can end them instead of waiting for clients to leave. */
export const openStreams = new Set<() => void>();

export function registerEventRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, hub, authenticator } = deps;

  app.addHook("preClose", async () => {
    for (const end of [...openStreams]) end();
  });

  /**
   * Server-sent change hints. The stream is authorized when it opens and again every 30 seconds: a
   * revoked token or a removed member loses it. A hint carries no content; on reconnect a client
   * reads the change feed from its own cursor. A hint whose new entries are all of pages hidden from the member
   * (ADR-0042) is not sent, so its timing does not tell them a hidden page changed.
   */
  app.get<{ Params: { workspaceId: string } }>(`${API_BASE_PATH}/workspaces/:workspaceId/events`, async (request, reply) => {
    const me = principalOf(request);
    if (!hub) throw new ApiError("capability_not_supported", "capability events.sse is not supported");
    const ws = await workspaceAccess(db, request.params.workspaceId, me.id, "read");

    reply.hijack();
    const raw = reply.raw;
    // A hijacked reply bypasses Fastify's header handling: carry over what the onRequest hook set (CORS, nosniff).
    raw.writeHead(200, {
      ...(reply.getHeaders() as OutgoingHttpHeaders),
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    // Subscribe before telling the client it is connected, so no hint falls into the gap.
    let ended = false;
    const timers: NodeJS.Timeout[] = [];
    // Entries up to `seen` were already looked at; checks run one at a time so `seen` only moves forward.
    let seen: number | undefined;
    let queue = Promise.resolve();
    const unsubscribe = hub.subscribe(ws.id, (hint) => {
      if (ended) return;
      if (hint.seq === undefined) return void raw.write(sseFrame(ws.id, hint.cursor));
      const to = hint.seq;
      queue = queue
        .then(async () => {
          const from = seen ?? to - 1;
          if (to <= from) return;
          seen = to;
          if (!ended && (await anyVisible(db, ws.id, me.id, from, to))) raw.write(sseFrame(ws.id, hint.cursor));
        })
        // A database hiccup sends the hint: a hint carries nothing, and a missed one only delays a client.
        .catch(() => void (!ended && raw.write(sseFrame(ws.id, hint.cursor))));
    });
    const end = () => {
      if (ended) return;
      ended = true;
      unsubscribe();
      for (const t of timers) clearInterval(t);
      openStreams.delete(end);
      raw.end();
    };
    openStreams.add(end);
    raw.on("close", end);
    raw.on("error", end);
    raw.write(": connected\n\n");
    // A hint on connect: the feed head right now, so a client that reconnects reads from its own cursor at once.
    const head = await db.query<{ change_seq: number }>("SELECT change_seq FROM workspaces WHERE id = $1", [ws.id]).then((r) => r.rows[0]?.change_seq, () => undefined);
    if (head !== undefined) seen = Math.max(seen ?? 0, head);
    if (!ended && head !== undefined && head > 0) raw.write(sseFrame(ws.id, changeCursorOf(ws.id, head)));

    timers.push(setInterval(() => !ended && raw.write(": keep-alive\n\n"), KEEPALIVE_MS));
    timers.push(
      setInterval(() => {
        void (async () => {
          const valid = authenticator.revalidate ? await authenticator.revalidate(me) : true;
          if (valid) await workspaceAccess(db, ws.id, me.id, "read");
        })().catch((error: unknown) => {
          // Only a definite loss of access ends the stream; a database hiccup does not.
          if (error instanceof Error && error.name === "ApiError") end();
        });
      }, REVALIDATE_MS),
    );
    for (const t of timers) t.unref();
  });
}

/** Whether any entry in (from, to] is one the member may see: of no page (an attachment, a visibility change) or of a page not hidden from them. */
async function anyVisible(db: Queryable, workspaceId: string, userId: string, from: number, to: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM changes WHERE workspace_id = $1 AND seq > $3 AND seq <= $4 AND (page_id IS NULL OR page_id NOT IN ${HIDDEN("$1", "$2")}) LIMIT 1`,
    [workspaceId, userId, from, to],
  );
  return (rowCount ?? 0) > 0;
}
