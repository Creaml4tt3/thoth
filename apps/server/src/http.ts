import type { FastifyReply, FastifyRequest } from "fastify";
import type { Principal } from "./auth.ts";
import type { Deps } from "./deps.ts";
import { ApiError, type Reply } from "./errors.ts";
import { runMutation, type MutationInfo } from "./idempotency.ts";
import type { Tx } from "./db.ts";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) throw new ApiError("unauthenticated", "a valid bearer credential is required");
  return request.principal;
}

export function headerOf(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

export function bodyOf(request: FastifyRequest): Buffer {
  return Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
}

export function parseJsonBody(request: FastifyRequest, options: { optional?: boolean } = {}): unknown {
  const body = bodyOf(request);
  if (body.length === 0 && options.optional) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError("validation_failed", "request body is not valid JSON");
  }
}

export function send(reply: FastifyReply, result: Reply): FastifyReply {
  reply.code(result.status);
  for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
  return result.body === undefined ? reply.send() : reply.send(result.body);
}

/** Runs a mutating handler through the transaction + idempotency machinery and sends its reply. */
export async function mutate(deps: Deps, request: FastifyRequest, reply: FastifyReply, run: (tx: Tx, info: MutationInfo, now: Date) => Promise<Reply>): Promise<FastifyReply> {
  const principal = principalOf(request);
  const result = await runMutation(
    deps.db,
    {
      method: request.method,
      target: request.url,
      idempotencyKey: headerOf(request, "idempotency-key"),
      ifMatch: headerOf(request, "if-match"),
      ifNoneMatch: headerOf(request, "if-none-match"),
      body: bodyOf(request),
      principalId: principal.id,
      requestId: request.id,
    },
    (tx, info) => run(tx, info, new Date()),
  );
  return send(reply, result);
}

/** Records an ADR-0009 audit event. Never content or secrets. */
export async function audit(q: { query(text: string, values?: unknown[]): Promise<unknown> }, event: { actorId: string | null; workspaceId?: string | null; action: string; detail?: Record<string, unknown> }): Promise<void> {
  await q.query("INSERT INTO audit_events (actor_id, workspace_id, action, detail) VALUES ($1, $2, $3, $4)", [event.actorId, event.workspaceId ?? null, event.action, JSON.stringify(event.detail ?? {})]);
}
