/**
 * A workspace page's images (ADR-0028). `thoth:attachment/<id>` (the link form transfers write) is loaded through the
 * authorised download; an added image is uploaded as an attachment of the workspace and written as that link. A
 * workspace page has no folder, so a relative `src` there is not found. Web images are never fetched.
 */
import { newStableId } from "@thoth/domain";
import type { WorkspaceClient } from "@thoth/workspace-client";
import { MAX_IMAGE_BYTES, altFromFileName, imageFileName, imageMimeType, isImageMimeType, resolveImageSrc, type PageMedia } from "../editor/media.ts";

export function workspacePageMedia(client: Pick<WorkspaceClient, "getAttachment" | "uploadAttachment">, workspace: string, options: { canWrite: boolean }): PageMedia {
  return {
    async load(src) {
      const target = resolveImageSrc(src, null);
      if (target.kind === "remote") return { state: "remote", url: target.url };
      if (target.kind !== "attachment") return { state: target.kind === "refused" && target.reason === "no-folder" ? "missing" : "refused" };
      let got: { bytes: Uint8Array; mimeType: string };
      try {
        got = await client.getAttachment(workspace, target.id);
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        return { state: status === 404 ? "missing" : "unreadable" };
      }
      if (!isImageMimeType(got.mimeType)) return { state: "not-image" };
      if (got.bytes.length > MAX_IMAGE_BYTES) return { state: "too-large" };
      return { state: "ready", bytes: got.bytes, mimeType: got.mimeType };
    },
    ...(options.canWrite
      ? {
          async add(file) {
            const name = imageFileName(file);
            // A retry after a lost response replays the first upload instead of storing a second attachment.
            const made = await client.uploadAttachment(workspace, file.bytes, imageMimeType(name)!, { fileName: name, idempotencyKey: newStableId() });
            return { src: `thoth:attachment/${made.id}`, alt: altFromFileName(name) };
          },
        }
      : {}),
  };
}
