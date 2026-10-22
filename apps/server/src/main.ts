import { ConfigError, loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

/** Process entry point: `node src/main.ts`. Configuration comes from the environment. */
try {
  const config = loadConfig();
  const server = await startServer(config);
  server.app.log.info({ host: config.host, port: config.port, capabilities: config.capabilities }, "thoth server listening");
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    server.app.log.info({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
} catch (error) {
  // Never print the configuration: DATABASE_URL carries a password.
  const message = error instanceof ConfigError ? error.message : error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, "postgres://[redacted]") : "unknown error";
  console.error(`thoth-server: failed to start: ${message}`);
  process.exit(1);
}
