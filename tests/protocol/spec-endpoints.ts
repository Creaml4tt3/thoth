/** The endpoints of spec section 8 (`GET .../attachments/{attachmentId}` is a documented addition and not listed here). */
export const SPEC_ENDPOINTS: [method: string, path: string][] = [
  ["get", "/capabilities"],
  ["get", "/me"],
  ["get", "/workspaces"],
  ["get", "/workspaces/{workspaceId}/tree"],
  ["get", "/workspaces/{workspaceId}/pages/{pageId}"],
  ["put", "/workspaces/{workspaceId}/pages/{pageId}"],
  ["delete", "/workspaces/{workspaceId}/pages/{pageId}"],
  ["get", "/workspaces/{workspaceId}/pages/{pageId}/revisions"],
  ["post", "/workspaces/{workspaceId}/search"],
  ["post", "/workspaces/{workspaceId}/attachments"],
  ["get", "/workspaces/{workspaceId}/changes"],
  ["get", "/workspaces/{workspaceId}/events"],
  ["post", "/workspaces/{workspaceId}/transfers"],
  ["get", "/transfers/{operationId}"],
  ["post", "/transfers/{operationId}/commit"],
  ["post", "/transfers/{operationId}/abort"],
];
