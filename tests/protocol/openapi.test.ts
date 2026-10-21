import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { API_BASE_PATH, ERROR_CODES, PROBLEM_CONTENT_TYPE, PROTOCOL_SCHEMAS, ROUTES, buildOpenApiDocument, parseYaml, renderOpenApiYaml } from "@thoth/workspace-protocol";
import { SPEC_ENDPOINTS } from "./spec-endpoints.ts";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const OPENAPI_PATH = join(ROOT, "protocol", "openapi.yaml");

type Json = Record<string, any>;
let doc: Json;
let text: string;

beforeAll(async () => {
  text = await readFile(OPENAPI_PATH, "utf8");
  doc = parseYaml(text) as Json;
});

function resolvePointer(root: Json, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error(`external or malformed $ref: ${ref}`);
  let node: any = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    if (node === null || typeof node !== "object" || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
}

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) collectRefs(n, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
function operations(): { path: string; method: string; op: Json }[] {
  const found: { path: string; method: string; op: Json }[] = [];
  for (const [path, item] of Object.entries<Json>(doc.paths)) for (const method of METHODS) if (item[method]) found.push({ path, method, op: item[method] });
  return found;
}

describe("protocol/openapi.yaml", () => {
  it("is OpenAPI 3.1.x and parses as YAML", () => {
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
    expect(doc.info.title).toBeTruthy();
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
  });

  it("is exactly what the generator produces from the route registry (no drift)", () => {
    expect(text).toBe(renderOpenApiYaml());
  });

  it("generation is deterministic", () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(buildOpenApiDocument()));
  });

  it("contains every spec section 8 endpoint and nothing without a registry entry", () => {
    for (const [method, path] of SPEC_ENDPOINTS) {
      const item = doc.paths[`${API_BASE_PATH}${path}`];
      expect(item, `${method.toUpperCase()} ${API_BASE_PATH}${path}`).toBeDefined();
      expect(item[method], `${method.toUpperCase()} ${path}`).toBeDefined();
    }
    expect(operations().length).toBe(ROUTES.length);
  });

  it("has unique operationIds that match the registry", () => {
    const ids = operations().map((o) => o.op.operationId as string);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ROUTES.map((r) => r.operationId).sort());
  });

  it("resolves every $ref", () => {
    const refs = collectRefs(doc);
    expect(refs.length).toBeGreaterThan(50);
    for (const ref of refs) expect(resolvePointer(doc, ref), ref).toBeDefined();
  });

  it("declares every path parameter as a required in:path parameter", () => {
    for (const { path, method, op } of operations()) {
      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
      const params: Json[] = [...(doc.paths[path].parameters ?? []), ...(op.parameters ?? [])].map((p: Json) => (p.$ref ? (resolvePointer(doc, p.$ref) as Json) : p));
      const declared = params.filter((p) => p.in === "path");
      for (const name of placeholders) {
        const p = declared.find((d) => d.name === name);
        expect(p, `${method.toUpperCase()} ${path}: {${name}}`).toBeDefined();
        expect(p!.required, `${path}: {${name}} must be required`).toBe(true);
      }
      for (const p of declared) expect(placeholders, `${path}: declares unused path parameter ${p.name}`).toContain(p.name);
    }
  });

  it("returns application/problem+json, and only that, for every 4xx and 5xx response", () => {
    let checked = 0;
    for (const { path, method, op } of operations()) {
      for (const [status, raw] of Object.entries<Json>(op.responses)) {
        if (!/^[45]\d\d$/.test(status)) continue;
        const response = (raw.$ref ? resolvePointer(doc, raw.$ref) : raw) as Json;
        expect(Object.keys(response.content ?? {}), `${method.toUpperCase()} ${path} ${status}`).toEqual([PROBLEM_CONTENT_TYPE]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("documents each declared error code under the status the registry gives it", () => {
    for (const route of ROUTES) {
      const op = doc.paths[`${API_BASE_PATH}${route.path}`][route.method] as Json;
      expect(op["x-thoth-error-codes"]).toEqual(route.errors);
      for (const code of route.errors) expect(op.responses, `${route.operationId}: ${code}`).toHaveProperty(String(ERROR_CODES[code].status));
    }
  });

  it("models conditional writes and idempotency as header parameters", () => {
    const header = (opId: string, name: string): Json | undefined => {
      const op = operations().find((o) => o.op.operationId === opId)!.op;
      return (op.parameters ?? []).find((p: Json) => p.in === "header" && p.name === name);
    };
    expect(header("putPage", "If-Match")).toMatchObject({ required: false, "x-thoth-requirement": "conditional" });
    expect(header("putPage", "If-None-Match")).toMatchObject({ required: false });
    expect(header("putPage", "Idempotency-Key")).toMatchObject({ required: false });
    expect(header("deletePage", "If-Match")).toMatchObject({ required: true });
    expect(header("createTransfer", "Idempotency-Key")).toMatchObject({ required: true });
    expect(header("uploadAttachment", "Idempotency-Key")).toBeDefined();
    for (const opId of ["getPage", "putPage"]) {
      const op = operations().find((o) => o.op.operationId === opId)!.op;
      for (const status of ["200", "201"]) if (op.responses[status]) expect(op.responses[status].headers.ETag.$ref).toBe("#/components/headers/ETag");
    }
  });

  it("marks authentication as a provisional HTTP bearer scheme and defines no OAuth flow", () => {
    const scheme = doc.components.securitySchemes.bearerAuth;
    expect(scheme).toMatchObject({ type: "http", scheme: "bearer" });
    expect(scheme.description).toMatch(/PROVISIONAL/);
    expect(doc.info.description).toMatch(/PROVISIONAL/);
    expect(doc.info.description).toMatch(/DRAFT/);
    expect(Object.values<Json>(doc.components.securitySchemes).map((s) => s.type)).toEqual(["http"]);
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(text).not.toMatch(/authorizationCode|clientCredentials|openIdConnect|oauth2/);
    const open = operations().filter((o) => Array.isArray(o.op.security) && o.op.security.length === 0).map((o) => o.op.operationId);
    expect(open).toEqual(["getCapabilities"]);
  });

  it("names the capability every gated operation requires", () => {
    for (const route of ROUTES) {
      const op = doc.paths[`${API_BASE_PATH}${route.path}`][route.method] as Json;
      expect(op["x-thoth-capability"]).toBe(route.capability ?? undefined);
    }
  });

  it("publishes every named schema as a component", () => {
    for (const { name } of PROTOCOL_SCHEMAS) expect(doc.components.schemas, name).toHaveProperty(name);
  });

  it("describes the SSE route as text/event-stream with the hint payload", () => {
    const op = operations().find((o) => o.op.operationId === "streamWorkspaceEvents")!.op;
    expect(Object.keys(op.responses["200"].content)).toEqual(["text/event-stream"]);
    expect(op.responses["200"]["x-thoth-sse"].data.$ref).toBe("#/components/schemas/ChangeHintEvent");
  });
});

describe("pnpm openapi:check (drift check)", () => {
  it("passes for an up-to-date file and fails for a stale one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thoth-openapi-"));
    const scratch = join(dir, "openapi.yaml");
    const script = join(ROOT, "scripts", "generate-openapi.ts");
    const env = { ...process.env, THOTH_OPENAPI_PATH: scratch };
    try {
      await writeFile(scratch, renderOpenApiYaml());
      const ok = await run(process.execPath, [script, "--check"], { env, cwd: ROOT });
      expect(ok.stdout).toMatch(/up to date/);

      await writeFile(scratch, renderOpenApiYaml().replace("operationId: getMe", "operationId: getMeStale"));
      await expect(run(process.execPath, [script, "--check"], { env, cwd: ROOT })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("stale") });

      await rm(scratch);
      await expect(run(process.execPath, [script, "--check"], { env, cwd: ROOT })).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
