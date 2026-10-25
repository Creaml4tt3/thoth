/**
 * `thoth-mcp` (ADR-0021) against the official MCP JSON schemas (`tests/fixtures/mcp-schema`): a 2025-11-25 session
 * (the `initialize` handshake) and 2026-07-28 requests (per-request `_meta`), every answer checked against the
 * schema's own definition of it. The running app is a local socket that answers as Thoth would.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { REPO, buildMcpServer } from "../ports/harness.ts";
import { McpClient as Client } from "../helpers/mcp-client.ts";

const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";

function validator(version: string) {
  const schema = JSON.parse(readFileSync(join(REPO, "tests", "fixtures", "mcp-schema", `${version}.json`), "utf8")) as { $defs: Record<string, unknown> };
  // `strict: false`: the official schema carries annotations (such as `x-mcp-header` mentions) Ajv does not know.
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(schema, version);
  return (definition: string, value: unknown) => {
    const validate = ajv.getSchema(`${version}#/$defs/${definition}`);
    if (!validate) throw new Error(`No ${definition} in the ${version} schema`);
    const ok = validate(value);
    return ok ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
  };
}

/** The app's socket: answers every tool call as Thoth does (`{ ok, result: { text, structured } }`). */
async function fakeApp(dir: string): Promise<{ socket: string; server: Server; seen: unknown[] }> {
  const socket = join(dir, "thoth.sock");
  const seen: unknown[] = [];
  const server = createServer((connection) => {
    createInterface({ input: connection }).once("line", (line) => {
      const request = JSON.parse(line) as { tool: string };
      seen.push(request);
      const answer =
        request.tool === "read_page"
          ? { ok: true, result: { text: "# Plan\n\nแผนงาน 2027\n", structured: { space: "Notes", path: "Plan.md", id: "p1", title: "Plan", attachments: [] } } }
          : request.tool === "backlinks"
            ? { ok: false, error: { code: "NOT_FOUND", message: "No page Nope.md in Notes" } }
            : { ok: true, result: { text: "{}", structured: { results: [{ space: "Notes", path: "Plan.md", title: "Plan", id: "p1", snippet: "[แผน]งาน" }] } } };
      connection.end(`${JSON.stringify(answer)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return { socket, server, seen };
}

const meta = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": { name: "ExampleClient", version: "1.0.0" }, "io.modelcontextprotocol/clientCapabilities": {} };

let binary: string;
let dir: string;
let app: Awaited<ReturnType<typeof fakeApp>>;

beforeAll(async () => {
  binary = await buildMcpServer();
  dir = await mkdtemp("/tmp/thoth-mcp-schema-");
  app = await fakeApp(dir);
}, 300_000);

afterAll(async () => {
  await new Promise<void>((resolve) => app.server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("thoth-mcp, 2025-11-25 session", () => {
  it("answers the handshake, the tool list and tool calls as the schema defines them", async () => {
    const check = validator(LEGACY);
    const client = new Client(binary, app.socket);
    const init = await client.request(1, "initialize", { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "ExampleClient", version: "1.0.0" } });
    expect(check("JSONRPCResultResponse", init)).toEqual([]);
    expect(check("InitializeResult", init.result)).toEqual([]);
    client.notify("notifications/initialized");

    const list = await client.request(2, "tools/list", {});
    expect(check("ListToolsResult", list.result)).toEqual([]);
    for (const tool of (list.result as { tools: unknown[] }).tools) expect(check("Tool", tool)).toEqual([]);

    const read = await client.request(3, "tools/call", { name: "read_page", arguments: { path: "Plan.md" } });
    expect(check("CallToolResult", read.result)).toEqual([]);
    const failed = await client.request(4, "tools/call", { name: "backlinks", arguments: { path: "Nope.md" } });
    expect(check("CallToolResult", failed.result)).toEqual([]);
    expect((failed.result as { isError: boolean }).isError).toBe(true);

    const unknown = await client.request(5, "tools/call", { name: "write_page", arguments: {} });
    expect(check("JSONRPCErrorResponse", unknown)).toEqual([]);
    expect((unknown.error as { code: number }).code).toBe(-32602);
    const ping = await client.request(6, "ping");
    expect(check("JSONRPCResultResponse", ping)).toEqual([]);
    await client.close();
    // Nothing but MCP messages on stdout.
    for (const line of client.lines) expect(check("JSONRPCMessage", JSON.parse(line))).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("thoth-mcp, 2026-07-28 requests", () => {
  it("answers discovery, the tool list and tool calls as the schema defines them", async () => {
    const check = validator(MODERN);
    const client = new Client(binary, app.socket);
    const discover = await client.request("discover-1", "server/discover", { _meta: meta });
    expect(check("DiscoverResultResponse", discover)).toEqual([]);

    const list = await client.request(2, "tools/list", { _meta: meta });
    expect(check("ListToolsResultResponse", list)).toEqual([]);

    const search = await client.request(3, "tools/call", { _meta: meta, name: "search", arguments: { query: "แผน" } });
    expect(check("CallToolResultResponse", search)).toEqual([]);
    expect((search.result as { structuredContent: unknown }).structuredContent).toEqual({ results: [{ space: "Notes", path: "Plan.md", title: "Plan", id: "p1", snippet: "[แผน]งาน" }] });

    const unsupported = await client.request(4, "tools/list", { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } });
    expect(check("UnsupportedProtocolVersionError", unsupported)).toEqual([]);
    await client.close();
    for (const line of client.lines) expect(check("JSONRPCMessage", JSON.parse(line))).toEqual([]);
    // The app heard who asked, from the request's own metadata.
    expect(app.seen).toContainEqual({ v: 1, app: "ExampleClient", tool: "search", arguments: { query: "แผน" } });
  });
});
