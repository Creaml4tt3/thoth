import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CapabilitiesSchema,
  CapabilityIdSchema,
  ChangeEntrySchema,
  ERROR_CODES,
  ERROR_CODE_LIST,
  ProblemDetailsSchema,
  PROTOCOL_SCHEMAS,
  PageWriteSchema,
  RevisionIdSchema,
  TransferCreateRequestSchema,
  checkProblemConsistency,
  formatEtag,
  isCompatibleProtocolVersion,
  paginated,
  parseEtag,
  problem,
  CursorSchema,
} from "@thoth/workspace-protocol";
import { SAMPLES } from "./samples.ts";

describe("protocol schemas: JSON Schema round trip", () => {
  it("has unique component names and file stems", () => {
    expect(new Set(PROTOCOL_SCHEMAS.map((s) => s.name)).size).toBe(PROTOCOL_SCHEMAS.length);
    expect(new Set(PROTOCOL_SCHEMAS.map((s) => s.file)).size).toBe(PROTOCOL_SCHEMAS.length);
  });

  it("has a valid sample for every schema", () => {
    for (const { name } of PROTOCOL_SCHEMAS) expect(SAMPLES, `missing sample for ${name}`).toHaveProperty(name);
  });

  for (const entry of PROTOCOL_SCHEMAS) {
    describe(entry.name, () => {
      it("accepts its sample", () => {
        expect(entry.schema.safeParse(SAMPLES[entry.name]).success).toBe(true);
      });

      for (const io of ["input", "output"] as const) {
        it(`converts with z.toJSONSchema (${io}) without unrepresentable fallbacks`, () => {
          // Default `unrepresentable: "throw"`: the generator may fall back to "any", the contract may not need it.
          const json = z.toJSONSchema(entry.schema, { target: "draft-2020-12", io });
          expect(typeof json).toBe("object");
          expect(json).not.toBeNull();
        });
      }

      it("round-trips through JSON Schema: the sample stays valid, a non-object stays invalid", () => {
        const json = z.toJSONSchema(entry.schema, { target: "draft-2020-12", io: "input" });
        const back = z.fromJSONSchema(json);
        expect(back.safeParse(SAMPLES[entry.name]).success, "sample must validate against the round-tripped schema").toBe(true);
        expect(back.safeParse(42).success).toBe(false);
        expect(entry.schema.safeParse(42).success).toBe(false);
      });
    });
  }

  it("rejects samples that break a required constraint after the round trip too", () => {
    const sample = structuredClone(SAMPLES.PageResource) as { revision: { contentHash: string } };
    sample.revision.contentHash = "not-a-digest";
    const original = PROTOCOL_SCHEMAS.find((s) => s.name === "PageResource")!.schema;
    const back = z.fromJSONSchema(z.toJSONSchema(original, { target: "draft-2020-12", io: "input" }));
    expect(original.safeParse(sample).success).toBe(false);
    expect(back.safeParse(sample).success).toBe(false);
  });
});

describe("capabilities", () => {
  it("accepts registered IDs and x- vendor IDs", () => {
    for (const id of ["attachments", "search", "events.sse", "transfers", "page-order", "databases", "realtime-collab", "x-acme", "x-acme.graph-view"]) {
      expect(CapabilityIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("rejects unregistered IDs without the x- prefix, and malformed vendor IDs", () => {
    for (const id of ["graphs", "X-acme", "x-", "x-Acme", "x- spaced", ""]) expect(CapabilityIdSchema.safeParse(id).success, id).toBe(false);
  });

  it("requires protocolVersion MAJOR.MINOR and unique capabilities", () => {
    expect(CapabilitiesSchema.safeParse({ protocolVersion: "1.0", capabilities: [] }).success).toBe(true);
    expect(CapabilitiesSchema.safeParse({ protocolVersion: "1", capabilities: [] }).success).toBe(false);
    expect(CapabilitiesSchema.safeParse({ protocolVersion: "1.0", capabilities: ["search", "search"] }).success).toBe(false);
    expect(CapabilitiesSchema.safeParse({ protocolVersion: "1.0" }).success).toBe(false);
  });

  it("enforces the idempotency window floor of 24 hours", () => {
    expect(CapabilitiesSchema.safeParse({ protocolVersion: "1.0", capabilities: [], limits: { idempotencyWindowSeconds: 3600 } }).success).toBe(false);
  });

  it("treats only the same major version as compatible", () => {
    expect(isCompatibleProtocolVersion("1.7")).toBe(true);
    expect(isCompatibleProtocolVersion("2.0")).toBe(false);
  });
});

describe("error-code registry", () => {
  const REQUIRED: Record<string, number> = {
    revision_conflict: 412,
    precondition_required: 428,
    not_found: 404,
    forbidden: 403,
    unauthenticated: 401,
    validation_failed: 400,
    idempotency_key_reused: 422,
    capability_not_supported: 501,
    export_restricted: 403,
    cursor_invalid: 400,
    payload_too_large: 413,
    rate_limited: 429,
  };

  it("contains every required code with its HTTP status", () => {
    for (const [code, status] of Object.entries(REQUIRED)) {
      expect(ERROR_CODES[code as keyof typeof ERROR_CODES]?.status, code).toBe(status);
    }
  });

  it("uses only 4xx and 5xx statuses and snake_case identifiers", () => {
    for (const code of ERROR_CODE_LIST) {
      expect(ERROR_CODES[code].status).toBeGreaterThanOrEqual(400);
      expect(ERROR_CODES[code].status).toBeLessThan(600);
      expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    }
  });

  it("builds RFC 9457 documents that validate and are status-consistent", () => {
    for (const code of ERROR_CODE_LIST) {
      const doc = problem(code, { detail: "d", requestId: "r1", errors: [{ pointer: "/x", detail: "bad" }] });
      expect(ProblemDetailsSchema.safeParse(doc).success, code).toBe(true);
      expect(checkProblemConsistency(doc, ERROR_CODES[code].status), code).toEqual([]);
    }
  });

  it("accepts x- vendor codes and rejects unregistered bare codes", () => {
    const base = { type: "about:blank", title: "t", status: 400 };
    expect(ProblemDetailsSchema.safeParse({ ...base, code: "x-acme.quota" }).success).toBe(true);
    expect(ProblemDetailsSchema.safeParse({ ...base, code: "quota_exceeded_soon" }).success).toBe(false);
    expect(ProblemDetailsSchema.safeParse({ ...base }).success).toBe(false);
  });

  it("keeps unknown extension members (RFC 9457)", () => {
    const doc = ProblemDetailsSchema.parse({ type: "about:blank", title: "t", status: 400, code: "validation_failed", trace: "abc" });
    expect((doc as Record<string, unknown>).trace).toBe("abc");
  });

  it("flags a body status that differs from the registry or the HTTP status", () => {
    expect(checkProblemConsistency(problem("not_found"), 500)).not.toEqual([]);
    expect(checkProblemConsistency({ ...problem("not_found"), status: 400 }, 404)).not.toEqual([]);
    expect(checkProblemConsistency({ type: "about:blank", title: "t", status: 400, code: "x-acme" }, 400)).toEqual([]);
  });
});

describe("primitives", () => {
  it("round-trips entity tags and rejects weak, wildcard and list values", () => {
    expect(formatEtag("rev_1")).toBe('"rev_1"');
    expect(parseEtag('"rev_1"')).toBe("rev_1");
    for (const bad of ['W/"rev_1"', "*", '"a", "b"', "rev_1", '""', null, undefined]) expect(parseEtag(bad), String(bad)).toBeNull();
    expect(RevisionIdSchema.safeParse('rev"quote').success).toBe(false);
  });

  it("requires cursors to be URL-unreserved and bounded", () => {
    expect(CursorSchema.safeParse("c_abc-123.~").success).toBe(true);
    expect(CursorSchema.safeParse("has space").success).toBe(false);
    expect(CursorSchema.safeParse("a/b").success).toBe(false);
    expect(CursorSchema.safeParse("x".repeat(2049)).success).toBe(false);
  });

  it("builds a pagination envelope with a nullable next cursor", () => {
    const envelope = paginated(z.string());
    expect(envelope.safeParse({ items: ["a"], nextCursor: null }).success).toBe(true);
    expect(envelope.safeParse({ items: ["a"], nextCursor: "n_1" }).success).toBe(true);
    expect(envelope.safeParse({ items: ["a"] }).success).toBe(false);
  });
});

describe("resource rules the type system cannot express", () => {
  it("requires pageId and revisionId on created and updated change entries", () => {
    const base = { id: "c1", occurredAt: "2026-10-21T10:00:00Z", actorId: null };
    expect(ChangeEntrySchema.safeParse({ ...base, kind: "page.created", pageId: SAMPLE_ID }).success).toBe(false);
    expect(ChangeEntrySchema.safeParse({ ...base, kind: "page.deleted", pageId: SAMPLE_ID }).success).toBe(true);
    expect(ChangeEntrySchema.safeParse({ ...base, kind: "attachment.created" }).success).toBe(false);
    expect(ChangeEntrySchema.safeParse({ ...base, kind: "x-acme.event" }).success).toBe(true);
  });

  it("limits page titles and distinguishes an omitted parent from a null parent", () => {
    expect(PageWriteSchema.safeParse({ title: "", markdown: "" }).success).toBe(false);
    expect(PageWriteSchema.safeParse({ title: "t", markdown: "" }).success).toBe(true);
    expect(PageWriteSchema.parse({ title: "t", markdown: "" })).not.toHaveProperty("parentId");
    expect(PageWriteSchema.parse({ title: "t", markdown: "", parentId: null }).parentId).toBeNull();
  });

  it("discriminates transfer creation by direction", () => {
    const op = SAMPLE_ID;
    expect(TransferCreateRequestSchema.safeParse({ operationId: op, direction: "from_workspace", mode: "copy", pages: [{ pageId: SAMPLE_ID }] }).success).toBe(true);
    expect(TransferCreateRequestSchema.safeParse({ operationId: op, direction: "from_workspace", mode: "copy", pages: [] }).success).toBe(false);
    expect(TransferCreateRequestSchema.safeParse({ operationId: op, direction: "sideways", mode: "copy", pages: [{ pageId: SAMPLE_ID }] }).success).toBe(false);
    expect(TransferCreateRequestSchema.safeParse({ operationId: "not-a-uuid", direction: "from_workspace", mode: "copy", pages: [{ pageId: SAMPLE_ID }] }).success).toBe(false);
  });
});

const SAMPLE_ID = "01a15cc9-7d0d-7982-a22a-e5ae3df6b019";
