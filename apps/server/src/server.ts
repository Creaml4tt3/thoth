import type { FastifyInstance } from "fastify";
import { PatAuthenticator, type Authenticator } from "./auth.ts";
import { buildApp, type BuildOptions } from "./app.ts";
import { FsBlobStore, type BlobStore } from "./blob.ts";
import { ChangeHub } from "./changes.ts";
import type { ServerConfig } from "./config.ts";
import { createDatabase, type Database } from "./db.ts";
import type { Deps } from "./deps.ts";
import { migrate } from "./migrate.ts";

export interface RunningServer {
  app: FastifyInstance;
  deps: Deps;
  /** Base URL, `http://host:port`. */
  url: string;
  close(): Promise<void>;
}

export interface StartOptions extends BuildOptions {
  /** Replaces the PAT authenticator (OIDC in phase 2b). */
  authenticator?: Authenticator;
  blobs?: BlobStore;
  /** Apply pending migrations before listening. Default true. */
  migrate?: boolean;
}

/** Connects to PostgreSQL, applies migrations, starts the LISTEN connection and the HTTP listener. */
export async function startServer(config: ServerConfig, options: StartOptions = {}): Promise<RunningServer> {
  let log: Deps["log"] | undefined;
  const db: Database = createDatabase(config.databaseUrl, { onError: (error) => log?.error({ err: error.message }, "idle database client error") });
  const hubLog: Deps["log"] = { info: (...a) => log?.info(...a), warn: (...a) => log?.warn(...a), error: (...a) => log?.error(...a) };
  const hub = new ChangeHub(config.databaseUrl, hubLog);
  try {
    if (options.migrate !== false) await migrate(db.pool);
    await hub.start();
  } catch (error) {
    await hub.close();
    await db.close();
    throw error;
  }
  const deps: Deps = {
    config,
    db,
    authenticator: options.authenticator ?? new PatAuthenticator(db),
    blobs: options.blobs ?? new FsBlobStore(config.blobDir),
    hub,
    log: hubLog,
  };
  const app = buildApp(deps, options);
  log = app.log;
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close().catch(() => undefined);
    await hub.close();
    await db.close();
    throw error;
  }
  let closed = false;
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  return {
    app,
    deps,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      await hub.close();
      await db.close();
    },
  };
}
