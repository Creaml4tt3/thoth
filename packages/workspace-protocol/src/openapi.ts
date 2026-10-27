import { z } from "zod";
import { parse, stringify } from "yaml";
import { API_BASE_PATH, IdempotencyKeySchema, IfMatchSchema, IfNoneMatchSchema, PROTOCOL_VERSION } from "./common.ts";
import { ERROR_CODES, type ErrorCode } from "./errors.ts";
import { KNOWN_CAPABILITIES } from "./capabilities.ts";
import { PROTOCOL_SCHEMAS } from "./schemas.ts";
import { ROUTES, pathParamNames, type RequestHeaderSpec, type RouteDefinition } from "./routes.ts";

type Json = Record<string, unknown>;

/**
 * Generates the OpenAPI 3.1 document from the route registry and the Zod schemas.
 * The output is deterministic: same registry in, same bytes out.
 */

const componentRegistry = z.registry<{ id: string }>();
for (const entry of PROTOCOL_SCHEMAS) componentRegistry.add(entry.schema, { id: entry.name });

/** Zod reads descriptions from the global registry; component ids come from ours. Merge both. */
const metadata = {
  get(schema: z.ZodType) {
    const global = z.globalRegistry.get(schema);
    const own = componentRegistry.get(schema);
    return global || own ? { ...global, ...own } : undefined;
  },
} as unknown as typeof z.globalRegistry;

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const [key, inner] of Object.entries(value as Json)) {
      out[key] = key === "$ref" && typeof inner === "string" ? inner.replace("#/$defs/", "#/components/schemas/") : rewriteRefs(inner);
    }
    return out;
  }
  return value;
}

interface Rendered {
  schema: Json;
  defs: Record<string, Json>;
}

function render(schema: z.ZodType): Rendered {
  const raw = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any", metadata }) as Json;
  const { $schema: _dialect, $defs, ...rest } = raw;
  void _dialect;
  return { schema: rewriteRefs(rest) as Json, defs: rewriteRefs($defs ?? {}) as Record<string, Json> };
}

const HEADER_VALUE_SCHEMAS: Record<RequestHeaderSpec["name"], z.ZodType> = {
  "If-Match": IfMatchSchema,
  "If-None-Match": IfNoneMatchSchema,
  "Idempotency-Key": IdempotencyKeySchema,
};

const SCHEMA_REF = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const schemaNameOf = (schema: z.ZodType): string | undefined => componentRegistry.get(schema)?.id;

const PROVISIONAL_AUTH =
  "HTTP bearer credentials are used as a placeholder because the authentication scheme for third-party servers is an open question in ADR-0004 (OAuth 2.1 / OIDC versus session tokens). " +
  "This scheme may change before the protocol is finalized. Thoth clients obtain the credential through the sign-in broker (docs/protocol/sign-in.md, advertised as `signIn` in /capabilities); its /auth endpoints are not part of this document.";

export function buildOpenApiDocument(): Json {
  const components: Record<string, Json> = {};
  const addDefs = (defs: Record<string, Json>) => {
    for (const [name, def] of Object.entries(defs)) {
      const existing = components[name];
      if (existing && JSON.stringify(existing) !== JSON.stringify(def)) throw new Error(`Component ${name} rendered two different ways`);
      components[name] = def;
    }
  };

  for (const entry of PROTOCOL_SCHEMAS) addDefs(render(entry.schema).defs);

  const schemaFor = (schema: z.ZodType): Json => {
    const name = schemaNameOf(schema);
    if (name) return SCHEMA_REF(name);
    const rendered = render(schema);
    addDefs(rendered.defs);
    return rendered.schema;
  };

  const parameters: Record<string, Json> = {};
  const parameterRef = (key: string, definition: Json): Json => {
    const existing = parameters[key];
    if (existing && JSON.stringify(existing) !== JSON.stringify(definition)) throw new Error(`Parameter ${key} defined two ways`);
    parameters[key] = definition;
    return { $ref: `#/components/parameters/${key}` };
  };

  const buildOperation = (route: RouteDefinition): Json => {
    const params: Json[] = [];
    for (const name of pathParamNames(route.path)) {
      const schema = route.pathParams[name];
      if (!schema) throw new Error(`${route.operationId}: path parameter {${name}} has no schema`);
      const key = name.charAt(0).toUpperCase() + name.slice(1);
      params.push(parameterRef(key, { name, in: "path", required: true, schema: schemaFor(schema) }));
    }
    if (route.query) {
      const rendered = render(route.query);
      const props = (rendered.schema.properties ?? {}) as Record<string, Json>;
      const required = new Set((rendered.schema.required ?? []) as string[]);
      for (const [name, schema] of Object.entries(props)) {
        const definition: Json = { name, in: "query", required: required.has(name), schema };
        params.push(name === "cursor" || name === "limit" ? parameterRef(name === "cursor" ? "Cursor" : "Limit", definition) : definition);
      }
    }
    for (const header of route.requestHeaders) {
      const conditional = header.requirement === "conditional";
      params.push({
        name: header.name,
        in: "header",
        required: header.requirement === "required",
        description: conditional ? `${header.description} Conditionally required: see the operation description.` : header.description,
        schema: schemaFor(HEADER_VALUE_SCHEMAS[header.name]),
        ...(conditional ? { "x-thoth-requirement": "conditional" } : {}),
      });
    }

    const responses: Record<string, Json> = {};
    for (const spec of route.responses) {
      const response: Json = { description: spec.description };
      if (spec.headers.length) response.headers = Object.fromEntries(spec.headers.map((h) => [h.name, { $ref: `#/components/headers/${h.name}` }]));
      if (spec.schema && spec.contentType) response.content = { [spec.contentType]: { schema: schemaFor(spec.schema) } };
      else if (spec.contentType === "text/event-stream") response.content = { "text/event-stream": { schema: { type: "string" } } };
      else if (spec.status !== 204) response.content = { "*/*": { schema: { type: "string", contentMediaType: "application/octet-stream" } } };
      responses[String(spec.status)] = response;
    }
    if (route.operationId === "streamWorkspaceEvents") {
      (responses["200"] as Json)["x-thoth-sse"] = { event: "changes", data: SCHEMA_REF("ChangeHintEvent") };
    }

    const byStatus = new Map<number, ErrorCode[]>();
    for (const code of route.errors) {
      const status = ERROR_CODES[code].status;
      byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
    }
    for (const [status, codes] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
      responses[String(status)] = {
        $ref: `#/components/responses/Problem${status}`,
        description: codes.map((c) => `\`${c}\`: ${ERROR_CODES[c].description}`).join(" "),
      };
    }

    const operation: Json = {
      operationId: route.operationId,
      tags: [route.tag],
      summary: route.summary,
      description: route.capability ? `${route.description}\n\nRequires capability \`${route.capability}\`.` : route.description,
      ...(params.length ? { parameters: params } : {}),
    };
    if (route.requestBody) {
      const body = route.requestBody;
      operation.requestBody = {
        required: body.required,
        description: body.description,
        content: { [body.contentType]: { schema: body.schema ? schemaFor(body.schema) : { type: "string", contentMediaType: "application/octet-stream" } } },
      };
    }
    operation.responses = responses;
    // An empty requirement object means "no credentials"; listing it with the bearer one makes the bearer optional.
    if (route.public) operation.security = route.optionalAuth ? [{}, { bearerAuth: [] }] : [];
    if (route.capability) operation["x-thoth-capability"] = route.capability;
    operation["x-thoth-error-codes"] = [...route.errors];
    return operation;
  };

  const paths: Record<string, Json> = {};
  for (const route of ROUTES) {
    const key = `${API_BASE_PATH}${route.path}`;
    (paths[key] ??= {})[route.method] = buildOperation(route);
  }

  const problemContent = (name: string): Json => ({ "application/problem+json": { schema: SCHEMA_REF(name) } });
  const problemResponses: Record<string, Json> = {};
  const statuses = [...new Set(Object.values(ERROR_CODES).map((c) => c.status))].sort((a, b) => a - b);
  for (const status of statuses) {
    const response: Json = {
      description: `Problem details (RFC 9457). The \`code\` member is a stable machine-readable identifier; see the \`x-thoth-error-codes\` list of the operation.`,
      content: problemContent(status === 412 ? "RevisionConflictProblem" : "ProblemDetails"),
    };
    if (status === 401) response.headers = { "WWW-Authenticate": { description: 'Challenge, for example `Bearer`. Provisional, see the bearerAuth scheme.', schema: { type: "string" } } };
    if (status === 429) response.headers = { "Retry-After": { description: "Seconds to wait before retrying.", schema: { type: "integer", minimum: 0 } } };
    if (status === 405) response.headers = { Allow: { description: "Methods supported by the route.", schema: { type: "string" } } };
    problemResponses[`Problem${status}`] = response;
  }

  const sortedComponents = Object.fromEntries(Object.entries(components).sort(([a], [b]) => a.localeCompare(b)));
  const tags = [...new Set(ROUTES.map((r) => r.tag))].map((name) => ({ name }));

  return {
    openapi: "3.1.0",
    info: {
      title: "Thoth Workspace Protocol",
      version: PROTOCOL_VERSION,
      summary: "Open, versioned REST protocol between Thoth clients and any compatible workspace server.",
      description:
        "DRAFT, Proposed per ADR-0004. Generated from `packages/workspace-protocol` (route registry and Zod schemas); do not edit by hand.\n\n" +
        `Authentication is PROVISIONAL. ${PROVISIONAL_AUTH}\n\n` +
        "Normative semantics (versioning, capabilities, conditional writes, idempotency, change feed, transfers) are in docs/protocol/README.md.",
    },
    servers: [{ url: "https://workspace.example.invalid", description: "Placeholder. Servers are self-hosted; use the base URL of the workspace server you connect to." }],
    security: [{ bearerAuth: [] }],
    tags,
    paths,
    components: {
      schemas: sortedComponents,
      parameters,
      responses: problemResponses,
      headers: {
        ETag: { description: "Strong entity tag: the revision ID in double quotes.", schema: { type: "string" } },
        Location: { description: "Absolute path of the created resource.", schema: { type: "string" } },
      },
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: `PROVISIONAL. ${PROVISIONAL_AUTH}` },
      },
    },
    "x-thoth-protocol-status": "draft",
    "x-thoth-capabilities": [...KNOWN_CAPABILITIES],
  };
}

const HEADER =
  "# GENERATED FILE. DRAFT: Proposed per ADR-0004.\n# Source: packages/workspace-protocol (route registry + Zod schemas).\n# Regenerate: pnpm openapi   Check: pnpm openapi:check\n";

export function renderOpenApiYaml(): string {
  return HEADER + stringify(buildOpenApiDocument(), { lineWidth: 0, aliasDuplicateObjects: false });
}

/** YAML parsing helper so consumers need not depend on `yaml` themselves. */
export function parseYaml(text: string): unknown {
  return parse(text);
}
