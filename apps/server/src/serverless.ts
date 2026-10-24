import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.ts";
import { PatAuthenticator } from "./auth.ts";
import { FsBlobStore, PgBlobStore } from "./blob.ts";
import { ConfigError, loadConfig, type ServerConfig } from "./config.ts";
import { createDatabase } from "./db.ts";
import type { Deps } from "./deps.ts";
import { ApiError, problemReply } from "./errors.ts";

/**
 * A request handler for a serverless Node host (Vercel Functions, docs/deploy/trial.md): no listener, no
 * migrations and no LISTEN connection. The app is built once per instance, on the first request, and reused.
 * Configuration rules for such hosts (ADR-0014): `MIGRATE_ON_START=false` (migrate with the CLI and a direct
 * URL) and `EVENTS=off` (nothing may hold a connection open). Either one missing is a startup error, not a
 * silently different server.
 */
export function serverlessConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const config = loadConfig(env);
  if (config.migrateOnStart) throw new ConfigError("MIGRATE_ON_START must be false on a serverless host: run `node src/cli.ts migrate` with a direct URL instead");
  if (config.capabilities.includes("events.sse")) throw new ConfigError("EVENTS must be off on a serverless host (THOTH_PROFILE=trial sets it)");
  return config;
}

export function createHandler(env: NodeJS.ProcessEnv = process.env): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let ready: Promise<FastifyInstance> | null = null;
  const boot = async (): Promise<FastifyInstance> => {
    const config = serverlessConfig(env);
    let log: Deps["log"] | undefined;
    const db = createDatabase(config.databaseUrl, { max: config.databasePoolMax, onError: (error) => log?.error({ err: error.message }, "idle database client error") });
    const deps: Deps = {
      config,
      db,
      authenticator: new PatAuthenticator(db),
      blobs: config.blobStore === "postgres" ? new PgBlobStore(db) : new FsBlobStore(config.blobDir),
      hub: null,
      log: { info: (...a) => log?.info(...a), warn: (...a) => log?.warn(...a), error: (...a) => log?.error(...a) },
    };
    const app = buildApp(deps);
    log = app.log;
    await app.ready();
    return app;
  };
  return async (req, res) => {
    let app: FastifyInstance;
    try {
      app = await (ready ??= boot());
    } catch (error) {
      // A failed boot is retried on the next request (the database may have been waking up). Never echo the
      // configuration: DATABASE_URL carries a password.
      ready = null;
      console.error(`thoth-server: failed to start: ${error instanceof ConfigError ? error.message : error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, "postgres://[redacted]") : "unknown error"}`);
      const reply = problemReply(new ApiError("service_unavailable", "the server is temporarily unable to handle the request", {}, { "retry-after": "5" }));
      res.writeHead(reply.status, { ...reply.headers, "cache-control": "no-store" });
      res.end(reply.body);
      return;
    }
    app.server.emit("request", req, res);
  };
}
