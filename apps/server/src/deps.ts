import type { Authenticator } from "./auth.ts";
import type { BlobStore } from "./blob.ts";
import type { ChangeHub, Logger } from "./changes.ts";
import type { ServerConfig } from "./config.ts";
import type { Database } from "./db.ts";

/** Everything a route needs, passed explicitly so tests can substitute any part. */
export interface Deps {
  config: ServerConfig;
  db: Database;
  authenticator: Authenticator;
  blobs: BlobStore;
  /** `null` when `EVENTS=off`: no LISTEN connection exists. */
  hub: ChangeHub | null;
  log: Logger;
}
