/**
 * The real reference server for e2e tests: PostgreSQL in Podman (the server's own test-db setup), the Fastify server on
 * a free 127.0.0.1 port, and optionally the local OIDC test issuer behind "Sign in with Google". Also what a test needs
 * to talk to it as someone else (a personal access token over plain HTTP) and to play the system browser during a
 * desktop sign-in. Shared by workspace-server.e2e.ts, transfer.e2e.ts, web-client.e2e.ts and mvp.e2e.ts.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { REPO } from "../ports/harness.ts";
import { createServer, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import type { TestProject } from "vitest/node";
import { loadConfig } from "../../apps/server/src/config.ts";
import { createDatabase, type Database } from "../../apps/server/src/db.ts";
import { startServer, type RunningServer } from "../../apps/server/src/server.ts";
import startPostgres from "../../apps/server/test-db/global-setup.ts";
import { startFakeIssuer, type FakeIssuer } from "../../apps/server/test-db/fakes.ts";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = netServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

export interface ReferenceServer {
  url: string;
  db: Database;
  /** The test issuer behind "Sign in with Google", when started with `issuer: true`. */
  issuer: FakeIssuer | undefined;
  close(): Promise<void>;
}

/**
 * Starts PostgreSQL, then the server. `issuer`: also start the OIDC test issuer and point the Google provider at it.
 * `env`: more server configuration (CORS origins, profile, rate limits); `port`: the server's port (a free one by default).
 */
export async function startReferenceServer(options: { issuer?: boolean; env?: Record<string, string>; port?: number } = {}): Promise<ReferenceServer> {
  let databaseUrl = "";
  const stopPostgres = await startPostgres({ provide: (_key: string, value: string) => void (databaseUrl = value) } as unknown as TestProject);
  let issuer: FakeIssuer | undefined;
  let server: RunningServer | undefined;
  let db: Database | undefined;
  try {
    issuer = options.issuer ? await startFakeIssuer() : undefined;
    const port = options.port ?? (await freePort());
    const url = `http://127.0.0.1:${port}`;
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOG_LEVEL: "silent",
      BLOB_STORE: "postgres",
      PUBLIC_URL: url,
      ...(issuer ? { OIDC_GOOGLE_CLIENT_ID: issuer.clientId, OIDC_GOOGLE_CLIENT_SECRET: issuer.clientSecret } : {}),
      ...options.env,
    });
    // Google's issuer is fixed in configuration; point it at the local test issuer.
    if (issuer) for (const p of config.signIn!.providers) if (p.kind === "oidc") p.issuer = issuer.url;
    server = await startServer(config);
    db = createDatabase(databaseUrl, { max: 2 });
    const [s, d, i] = [server, db, issuer];
    return {
      url,
      db: d,
      issuer: i,
      async close() {
        await d.close().catch(() => undefined);
        await s.close().catch(() => undefined);
        await i?.close().catch(() => undefined);
        await stopPostgres();
      },
    };
  } catch (error) {
    await db?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await issuer?.close().catch(() => undefined);
    await stopPostgres();
    throw error;
  }
}

/** One protocol call with a bearer token, as another client would make it (not through the app). */
export async function apiAs(serverUrl: string, token: string, method: string, path: string, init: { headers?: Record<string, string>; json?: unknown } = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${serverUrl}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(init.json === undefined ? {} : { "content-type": "application/json" }), ...(init.headers ?? {}) },
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** Follows an authorization URL like a browser would: manual redirects, cookies per origin, down to the host's loopback callback. */
export async function actAsBrowser(start: string): Promise<void> {
  const jar = new Map<string, Map<string, string>>();
  let url = start;
  for (let hop = 0; hop < 20; hop++) {
    const origin = new URL(url).origin;
    const cookies = jar.get(origin);
    const res = await fetch(url, { redirect: "manual", headers: cookies && cookies.size > 0 ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {} });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = pair!.indexOf("=");
      const forOrigin = jar.get(origin) ?? new Map<string, string>();
      forOrigin.set(pair!.slice(0, at), pair!.slice(at + 1));
      jar.set(origin, forOrigin);
    }
    const location = res.headers.get("location");
    await res.arrayBuffer();
    if (res.status < 300 || res.status >= 400 || !location) {
      if (new URL(url).pathname === "/callback") return; // the host's loopback listener answered
      throw new Error(`Sign-in stopped at ${new URL(url).origin}${new URL(url).pathname} with HTTP ${res.status}`);
    }
    url = new URL(location, url).toString();
  }
  throw new Error("Too many redirects during sign-in");
}

const STATIC_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

/**
 * Builds the web client for one test file, into a folder of its own: the server address is fixed at build time, so
 * files that ran side by side and shared `apps/web/dist` could serve each other's build (another server's address).
 */
export async function buildWebClient(env: Record<string, string>): Promise<string> {
  const out = await mkdtemp(join(tmpdir(), "thoth-web-e2e-"));
  execFileSync("pnpm", ["exec", "vite", "build", "--logLevel", "warn", "--outDir", out, "--emptyOutDir"], { cwd: join(REPO, "apps", "web"), stdio: "inherit", env: { ...process.env, ...env } });
  process.once("exit", () => rmSync(out, { recursive: true, force: true }));
  return out;
}

/** A built web client (`buildWebClient`) under /app/, with the SPA fallback a static host gives it (/app/callback serves index.html). */
export async function serveWebClient(dist: string, port: number): Promise<Server> {
  const http = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (!path.startsWith("/app/")) {
      res.writeHead(404).end();
      return;
    }
    const rel = normalize(path.slice("/app/".length));
    const file = rel === "." || rel === "" || !extname(rel) ? "index.html" : rel;
    if (file.split(sep).includes("..")) {
      res.writeHead(400).end();
      return;
    }
    readFile(join(dist, file))
      .then((body) => res.writeHead(200, { "content-type": STATIC_TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body))
      .catch(() => res.writeHead(404).end());
  });
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  return http;
}
