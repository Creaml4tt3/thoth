/**
 * E2E dev bridge (test infrastructure only). Serves the built desktop UI
 * (`apps/desktop/dist`) and relays `/call` to the real Rust host harness
 * (`thoth-host-stdio`) over JSON lines, so a real browser drives the real UI
 * against the real Rust ports. Listens on 127.0.0.1 only and requires a
 * per-run random token on every call and event stream.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { StdioTransport, type StdioTransportOptions } from "@thoth/platform/stdio";
import { HostCallError, encodeBase64, decodeBase64 } from "@thoth/platform/remote";
import type { CommandName, VaultChangedEvent } from "@thoth/platform";

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const BYTE_RESULTS = new Set<string>(["fs.read", "source.file.read"]);

export interface Bridge {
  url: string;
  token: string;
  /** The page script that injects the bridge platform before the app starts. */
  initScript: string;
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startBridge(options: { dist: string; bridgeDir: string; host: StdioTransportOptions }): Promise<Bridge> {
  const transport = new StdioTransport(options.host);
  const token = randomBytes(24).toString("hex");
  const streams = new Set<ServerResponse>();
  const unlisten = await transport.listen("vault.changed", (event: VaultChangedEvent) => {
    for (const res of streams) res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/call" && req.method === "POST") {
        if (req.headers["x-thoth-bridge"] !== token) return void res.writeHead(403).end();
        const { command, args, bytes } = JSON.parse(await body(req)) as { command: CommandName; args: never; bytes?: string };
        try {
          const result = await transport.call(command, args, bytes === undefined ? undefined : decodeBase64(bytes));
          const payload = BYTE_RESULTS.has(command) ? { ok: true, bytes: encodeBase64(result as Uint8Array) } : { ok: true, result };
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
        } catch (error) {
          const e = error instanceof HostCallError ? { code: error.code, message: error.message } : { code: "INTERNAL", message: String(error) };
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: e }));
        }
        return;
      }
      if (url.pathname === "/events") {
        if (url.searchParams.get("token") !== token) return void res.writeHead(403).end();
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.write(": ready\n\n");
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      }
      if (url.pathname === "/__bridge__.js") {
        return void res.writeHead(200, { "content-type": "text/javascript" }).end(await readFile(join(options.bridgeDir, "__bridge__.js")));
      }
      // Static files from dist only; anything else falls back to index.html.
      const file = normalize(join(options.dist, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
      const safe = file.startsWith(options.dist + sep) ? file : join(options.dist, "index.html");
      const data = await readFile(safe).catch(() => readFile(join(options.dist, "index.html")));
      res.writeHead(200, { "content-type": TYPES[extname(safe)] ?? "application/octet-stream" }).end(data);
    })().catch((error: unknown) => res.writeHead(500).end(String(error)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Bridge failed to listen");
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    token,
    initScript: `window.__THOTH_PLATFORM__ = async () => (await import("/__bridge__.js")).createHttpPlatform(${JSON.stringify(url)}, ${JSON.stringify(token)});`,
    async close() {
      unlisten();
      for (const res of streams) res.end();
      // The page may still hold keep-alive or event-stream sockets; don't wait for them.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await transport.close();
    },
  };
}
