import { z } from "zod";
import { OpaqueIdSchema } from "./common.ts";

/**
 * Presence (ADR-0041, capability `presence`): who else has a page open. A client sends `heartbeatPresence` for the page
 * it shows, at least every `PRESENCE_HEARTBEAT_SECONDS`, and `leavePresence` when it closes the page. A server forgets
 * a heartbeat `PRESENCE_TTL_SECONDS` after it arrived. Only a member who can read the workspace sends or reads it, and
 * an entry holds nothing but an opaque ID and a display name.
 */
export const PRESENCE_HEARTBEAT_SECONDS = 15;
export const PRESENCE_TTL_SECONDS = 45;

export const PresenceEntrySchema = z.object({
  /** The member's user ID, the same ID as `actorId` in the change feed and `userId` in the member list. */
  userId: OpaqueIdSchema,
  displayName: z.string(),
});
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

/** The other members who have the page open now (never the caller), by display name. */
export const PresenceListSchema = z.object({ items: z.array(PresenceEntrySchema).max(50) });
export type PresenceList = z.infer<typeof PresenceListSchema>;
