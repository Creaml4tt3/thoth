import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps.ts";
import { ApiError } from "../errors.ts";
import { jsonReply } from "../errors.ts";
import { send } from "../http.ts";
import { bearerMatches, runMaintenance } from "../maintenance.ts";

/**
 * `GET /internal/maintenance`, outside `/api/v1`, for a scheduler that can only make HTTP calls (Vercel Cron
 * calls with GET and `Authorization: Bearer $CRON_SECRET`). Not registered unless `CRON_SECRET` is set, so a
 * server without it answers 404 like any unknown route. The secret is compared in constant time and never logged.
 */
export function registerMaintenanceRoutes(app: FastifyInstance, deps: Deps): void {
  const secret = deps.config.cronSecret;
  if (secret === undefined) return;
  app.get("/internal/maintenance", async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, secret)) throw new ApiError("unauthenticated", "a valid bearer credential is required");
    const result = await runMaintenance(deps.db, { revisionRetentionDays: deps.config.revisionRetentionDays });
    return send(reply, jsonReply(200, result));
  });
}
