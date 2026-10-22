import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import type { TestProject } from "vitest/node";

const run = promisify(execFile);

export const POSTGRES_IMAGE = "docker.io/library/postgres:18-alpine";

declare module "vitest" {
  interface ProvidedContext {
    /** Admin connection URL of the shared PostgreSQL container (throwaway; bound to 127.0.0.1). */
    pgAdminUrl: string;
  }
}

const FIX_PODMAN = `PostgreSQL tests need Podman. Fix: install Podman (https://podman.io), then run \`podman machine init\` (once) and \`podman machine start\`, and make sure ${POSTGRES_IMAGE} can be pulled (\`podman pull ${POSTGRES_IMAGE}\`).`;

async function podman(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run("podman", args, { env: { ...process.env, ...env }, timeout: 180_000 });
  return stdout.trim();
}

async function waitUntilReady(url: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = "";
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    client.on("error", () => undefined);
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await client.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`PostgreSQL did not become ready within 90 s (last error: ${lastError})`);
}

/**
 * Starts ONE postgres:18-alpine container on a random 127.0.0.1 port with its data on tmpfs, waits for
 * it, and removes it afterwards, also when the run fails or is interrupted. If Podman or its machine is
 * unavailable the run fails with a single message saying how to fix it. Tests are never skipped.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  try {
    await podman(["info", "--format", "{{.Host.Arch}}"]);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n").find((l) => l.trim().length > 0) : "";
    throw new Error(`Podman is not available or its machine is not running (${reason ?? "podman info failed"}).\n${FIX_PODMAN}`);
  }

  // The password is generated per run and handed to Podman through its own environment (not argv).
  const password = randomBytes(18).toString("base64url");
  let containerId: string;
  try {
    containerId = await podman(
      [
        "run", "--rm", "-d",
        "-p", "127.0.0.1::5432",
        // PostgreSQL 18 images keep PGDATA under /var/lib/postgresql/18/docker, so the tmpfs is the volume root.
        "--tmpfs", "/var/lib/postgresql",
        "-e", "POSTGRES_PASSWORD",
        "--label", "io.thoth.test=server",
        POSTGRES_IMAGE,
        // Throwaway database: trade durability for speed.
        "postgres", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "max_connections=200",
      ],
      { POSTGRES_PASSWORD: password },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n").find((l) => l.trim().length > 0) : "";
    throw new Error(`Could not start ${POSTGRES_IMAGE} with Podman (${reason ?? "podman run failed"}).\n${FIX_PODMAN}`);
  }

  // Last-resort cleanup, also on a hard exit of this process.
  const removeSync = () => {
    try {
      execFileSync("podman", ["rm", "-f", "-t", "0", containerId], { stdio: "ignore", timeout: 30_000 });
    } catch {
      /* already gone */
    }
  };
  process.once("exit", removeSync);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => (removeSync(), process.exit(130)));

  const teardown = async () => {
    process.off("exit", removeSync);
    await podman(["rm", "-f", "-t", "0", containerId]).catch(() => undefined);
  };

  try {
    const mapping = await podman(["port", containerId, "5432/tcp"]);
    const port = /:(\d+)\s*$/m.exec(mapping)?.[1];
    if (!port) throw new Error(`could not read the published port from "${mapping}"`);
    const url = `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`;
    await waitUntilReady(url);
    project.provide("pgAdminUrl", url);
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
