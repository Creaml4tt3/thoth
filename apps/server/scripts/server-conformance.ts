/**
 * Builds and starts the container setup (compose.yaml: postgres + server) under Podman, provisions a
 * test user, workspace and token with the admin CLI, runs the conformance suite against it, and tears
 * everything down. Run with `pnpm server:conformance`.
 *
 * The token is created inside the server container and copied to a 0600 file in a private temporary
 * directory; it reaches the suite through an environment variable. It is never printed, never on a
 * command line, and the directory is removed at the end.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = new URL("../../../", import.meta.url).pathname;
const project = `thoth-conf-${randomBytes(3).toString("hex")}`;
const server = `${project}-server-1`;
const password = randomBytes(18).toString("base64url");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

const composeEnv = (port: number) => ({ ...process.env, THOTH_DB_PASSWORD: password, THOTH_PORT: String(port) });

async function podman(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { stdout } = await run("podman", args, { env, cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** Admin CLI inside the server container (it already has DATABASE_URL). Only IDs are ever on stdout. */
const adminCli = (...args: string[]) => podman(["exec", server, "node", "src/cli.ts", ...args]);

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/v1/capabilities`);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`the server did not become ready within 120 s (${last})`);
}

async function main(): Promise<number> {
  try {
    await podman(["info", "--format", "{{.Host.Arch}}"]);
  } catch {
    console.error("Podman is not available or its machine is not running. Fix: `podman machine start` (once: `podman machine init`).");
    return 2;
  }
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(join(tmpdir(), "thoth-conformance-"));
  await chmod(dir, 0o700);
  const compose = (...args: string[]) => run("podman", ["compose", "-f", "compose.yaml", "-p", project, ...args], { cwd: ROOT, env: composeEnv(port), maxBuffer: 64 * 1024 * 1024 });
  let code = 1;
  try {
    console.log(`[server:conformance] starting ${project} (build + postgres + server) on ${url}`);
    await compose("up", "--build", "-d");
    await waitForServer(url);

    const userId = await adminCli("create-user", "--name", "Conformance Owner");
    const workspaceId = await adminCli("create-workspace", "--name", "Conformance");
    await adminCli("add-member", "--workspace", workspaceId, "--user", userId, "--role", "owner");
    await adminCli("create-token", "--user", userId, "--out", "/tmp/conformance.token", "--label", "server:conformance", "--expires-days", "1");
    const tokenFile = join(dir, "token");
    await podman(["cp", `${server}:/tmp/conformance.token`, tokenFile]);
    await podman(["exec", server, "rm", "-f", "/tmp/conformance.token"]);
    await chmod(tokenFile, 0o600);
    const mode = (await stat(tokenFile)).mode & 0o777;
    if (mode !== 0o600) throw new Error(`token file has mode ${mode.toString(8)}, expected 600`);
    const token = (await readFile(tokenFile, "utf8")).trim();
    console.log(`[server:conformance] provisioned user ${userId}, workspace ${workspaceId}; token file mode 600`);

    code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["protocol/conformance/src/cli.ts", "--url", url, "--workspace", workspaceId], {
        cwd: ROOT,
        env: { ...process.env, THOTH_TOKEN: token },
        stdio: "inherit",
      });
      child.on("error", reject);
      child.on("exit", (c) => resolve(c ?? 1));
    });
  } catch (error) {
    // Messages from child processes can quote the command line; the password is in the environment only, but redact anyway.
    const message = (error instanceof Error ? error.message : String(error)).split(password).join("[redacted]");
    console.error(`[server:conformance] failed: ${message}`);
    code = 1;
  } finally {
    console.log(`[server:conformance] tearing down ${project}`);
    await compose("down", "--volumes", "--remove-orphans", "--timeout", "3").catch(() => undefined);
    await podman(["rmi", "-f", "localhost/thoth-server:dev"]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
  return code;
}

process.exitCode = await main();
