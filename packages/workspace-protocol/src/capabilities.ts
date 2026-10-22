import { z } from "zod";
import { PROTOCOL_VERSION } from "./common.ts";

/**
 * Capability registry (ADR-0004). Core routes (capabilities, me, workspaces, tree,
 * pages, revisions, changes) are always present and are not listed.
 *
 * - `attachments`      routes: uploadAttachment, getAttachment
 * - `search`           routes: searchWorkspace
 * - `events.sse`       routes: streamWorkspaceEvents
 * - `transfers`        routes: createTransfer, getTransfer, commitTransfer, abortTransfer
 * - `databases`        reserved, no routes defined in protocol 1.0
 * - `realtime-collab`  reserved, no routes defined in protocol 1.0
 */
export const KNOWN_CAPABILITIES = ["attachments", "search", "events.sse", "transfers", "databases", "realtime-collab"] as const;
export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];

export const VENDOR_CAPABILITY_PATTERN = /^x-[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** A registered capability ID, or a vendor extension prefixed with `x-`. */
export const CapabilityIdSchema = z.union([z.enum(KNOWN_CAPABILITIES), z.string().regex(VENDOR_CAPABILITY_PATTERN)]);
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

export const LimitsSchema = z.object({
  maxMarkdownBytes: z.number().int().positive().optional(),
  maxAttachmentBytes: z.number().int().positive().optional(),
  maxPageSize: z.number().int().positive().optional(),
  /** How long idempotency records are retained. Servers MUST retain them for at least 86400 seconds. */
  idempotencyWindowSeconds: z.number().int().min(86_400).optional(),
  /** Pages a workspace may hold (deleted pages do not count). Creating one more is 409 `quota_exceeded`. */
  maxPagesPerWorkspace: z.number().int().positive().optional(),
  /** Sum of the sizes of a workspace's attachments, in bytes. An upload that would exceed it is 409 `quota_exceeded`. */
  maxWorkspaceAttachmentBytes: z.number().int().positive().optional(),
  /** Members a workspace may have. */
  maxMembersPerWorkspace: z.number().int().positive().optional(),
  /** Workspaces one account may own. */
  maxWorkspacesPerAccount: z.number().int().positive().optional(),
  /** Non-current revisions older than this many days are removed; `GET ?revision=` of a removed revision is 404. */
  revisionRetentionDays: z.number().int().positive().optional(),
});
export type Limits = z.infer<typeof LimitsSchema>;

export const CapabilitiesSchema = z.object({
  protocolVersion: z.string().regex(/^\d+\.\d+$/, "Expected MAJOR.MINOR"),
  capabilities: z.array(CapabilityIdSchema).meta({ uniqueItems: true }).refine((ids) => new Set(ids).size === ids.length, "Capability IDs must be unique"),
  limits: LimitsSchema.optional(),
  server: z.object({ name: z.string(), version: z.string().optional() }).optional(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export function hasCapability(capabilities: Pick<Capabilities, "capabilities">, id: CapabilityId): boolean {
  return capabilities.capabilities.includes(id);
}

export function isCompatibleProtocolVersion(version: string): boolean {
  return version.split(".")[0] === PROTOCOL_VERSION.split(".")[0];
}
