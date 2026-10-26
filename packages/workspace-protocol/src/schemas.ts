import type { z } from "zod";
import { CapabilitiesSchema, LimitsSchema } from "./capabilities.ts";
import { ProblemDetailsSchema, QuotaExceededProblemSchema } from "./errors.ts";
import { MemberSchema, MeSchema, WorkspaceListSchema, WorkspaceSchema } from "./identity.ts";
import { PageMetadataSchema, PageMoveSchema, PageResourceSchema, PageWriteSchema, RevisionConflictProblemSchema, RevisionListSchema, RevisionSummarySchema } from "./pages.ts";
import { TreeNodeSchema, TreePageSchema } from "./tree.ts";
import { SearchHitSchema, SearchRequestSchema, SearchResponseSchema } from "./search.ts";
import { AttachmentResourceSchema } from "./attachments.ts";
import { ChangeEntrySchema, ChangeHintEventSchema, ChangesResponseSchema } from "./changes.ts";
import { TransferCommitRequestSchema, TransferCreateRequestSchema, TransferItemSchema, TransferResourceSchema } from "./transfers.ts";
import { ShareLinkCreateRequestSchema, ShareLinkCreatedSchema, ShareLinkListSchema, ShareLinkSchema } from "./shares.ts";
import { DeletedWorkspaceListSchema, DeletedWorkspaceSchema, WorkspaceCreateRequestSchema, WorkspaceRenameSchema } from "./workspaces.ts";
import { InviteAcceptRequestSchema, InviteAcceptedSchema, InviteLinkCreateRequestSchema, InviteLinkCreatedSchema, InviteLinkListSchema, InviteLinkSchema, MemberListSchema, MemberRoleChangeSchema } from "./members.ts";

export interface ProtocolSchemaEntry {
  /** OpenAPI component name. */
  name: string;
  /** File stem under `protocol/schemas/` (`<file>.json`). */
  file: string;
  schema: z.ZodType;
}

/**
 * Every named protocol schema. Drives both the OpenAPI `components.schemas` section and
 * the standalone JSON Schema files in `protocol/schemas/`.
 */
export const PROTOCOL_SCHEMAS: readonly ProtocolSchemaEntry[] = [
  { name: "Capabilities", file: "capabilities.v1", schema: CapabilitiesSchema },
  { name: "Limits", file: "limits.v1", schema: LimitsSchema },
  { name: "ProblemDetails", file: "problem-details.v1", schema: ProblemDetailsSchema },
  { name: "RevisionConflictProblem", file: "revision-conflict-problem.v1", schema: RevisionConflictProblemSchema },
  { name: "QuotaExceededProblem", file: "quota-exceeded-problem.v1", schema: QuotaExceededProblemSchema },
  { name: "Me", file: "me.v1", schema: MeSchema },
  { name: "Member", file: "member.v1", schema: MemberSchema },
  { name: "Workspace", file: "workspace.v1", schema: WorkspaceSchema },
  { name: "WorkspaceList", file: "workspace-list.v1", schema: WorkspaceListSchema },
  { name: "TreeNode", file: "tree-node.v1", schema: TreeNodeSchema },
  { name: "TreePage", file: "tree-page.v1", schema: TreePageSchema },
  { name: "RevisionSummary", file: "revision-summary.v1", schema: RevisionSummarySchema },
  { name: "RevisionList", file: "revision-list.v1", schema: RevisionListSchema },
  { name: "PageMetadata", file: "page-metadata.v1", schema: PageMetadataSchema },
  { name: "PageResource", file: "page-resource.v1", schema: PageResourceSchema },
  { name: "PageWrite", file: "page-write.v1", schema: PageWriteSchema },
  { name: "PageMove", file: "page-move.v1", schema: PageMoveSchema },
  { name: "SearchRequest", file: "search-request.v1", schema: SearchRequestSchema },
  { name: "SearchHit", file: "search-hit.v1", schema: SearchHitSchema },
  { name: "SearchResponse", file: "search-response.v1", schema: SearchResponseSchema },
  { name: "AttachmentResource", file: "attachment-resource.v1", schema: AttachmentResourceSchema },
  { name: "ChangeEntry", file: "change-entry.v1", schema: ChangeEntrySchema },
  { name: "ChangesResponse", file: "changes-response.v1", schema: ChangesResponseSchema },
  { name: "ChangeHintEvent", file: "change-hint-event.v1", schema: ChangeHintEventSchema },
  { name: "TransferCreateRequest", file: "transfer-create-request.v1", schema: TransferCreateRequestSchema },
  { name: "TransferCommitRequest", file: "transfer-commit-request.v1", schema: TransferCommitRequestSchema },
  { name: "TransferItem", file: "transfer-item.v1", schema: TransferItemSchema },
  { name: "TransferResource", file: "transfer-resource.v1", schema: TransferResourceSchema },
  { name: "ShareLinkCreateRequest", file: "share-link-create-request.v1", schema: ShareLinkCreateRequestSchema },
  { name: "ShareLink", file: "share-link.v1", schema: ShareLinkSchema },
  { name: "ShareLinkCreated", file: "share-link-created.v1", schema: ShareLinkCreatedSchema },
  { name: "ShareLinkList", file: "share-link-list.v1", schema: ShareLinkListSchema },
  { name: "MemberList", file: "member-list.v1", schema: MemberListSchema },
  { name: "MemberRoleChange", file: "member-role-change.v1", schema: MemberRoleChangeSchema },
  { name: "InviteLinkCreateRequest", file: "invite-link-create-request.v1", schema: InviteLinkCreateRequestSchema },
  { name: "InviteLink", file: "invite-link.v1", schema: InviteLinkSchema },
  { name: "InviteLinkCreated", file: "invite-link-created.v1", schema: InviteLinkCreatedSchema },
  { name: "InviteLinkList", file: "invite-link-list.v1", schema: InviteLinkListSchema },
  { name: "InviteAcceptRequest", file: "invite-accept-request.v1", schema: InviteAcceptRequestSchema },
  { name: "InviteAccepted", file: "invite-accepted.v1", schema: InviteAcceptedSchema },
  { name: "WorkspaceCreateRequest", file: "workspace-create-request.v1", schema: WorkspaceCreateRequestSchema },
  { name: "WorkspaceRename", file: "workspace-rename.v1", schema: WorkspaceRenameSchema },
  { name: "DeletedWorkspace", file: "deleted-workspace.v1", schema: DeletedWorkspaceSchema },
  { name: "DeletedWorkspaceList", file: "deleted-workspace-list.v1", schema: DeletedWorkspaceListSchema },
];
