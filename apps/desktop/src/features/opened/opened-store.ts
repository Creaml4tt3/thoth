/** A Markdown file the system handed to a file window (ADR-0057), as the shared editor's `PageStore`: read and written
 * through the window's token, never a path. */
import { sha256Hex } from "@thoth/domain";
import { decodeText } from "@thoth/content";
import type { OpenedFiles } from "@thoth/platform";
import { conflictCopyPath, type PageStore } from "@thoth/app-ui/editor/page-session.ts";

const codeOf = (error: unknown): unknown => (typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined);

/** The file's sha256: the platform's native one (about 10x faster than the JS one on 16 MiB in Node), else the JS one. */
async function hashOf(bytes: Uint8Array): Promise<string> {
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return sha256Hex(bytes);
  }
}

export function openedFileStore(files: OpenedFiles, token: string, name: string): PageStore {
  return {
    kind: "file",
    async read() {
      try {
        const [bytes, info] = await Promise.all([files.read(token), files.stat(token)]);
        const { text, editable } = decodeText(bytes);
        return { source: text, hash: await hashOf(bytes), editable, dates: { updated: info.mtimeMs } };
      } catch (error) {
        if (codeOf(error) === "ENOENT" || codeOf(error) === "NOT_A_REGULAR_FILE") return null;
        throw error;
      }
    },
    async write(source, expected) {
      // The file existed when it was opened; one that is gone is not made again here (Keep both makes a copy).
      if (expected === null) throw Object.assign(new Error(`${name} is gone`), { code: "CONFLICT" });
      return (await files.write(token, new TextEncoder().encode(source), expected)).hash;
    },
    async writeCopy(source, now) {
      for (let attempt = 1; attempt <= 50; attempt++) {
        const copy = conflictCopyPath(name, now, attempt);
        try {
          await files.copy(token, copy, new TextEncoder().encode(source));
          return { ref: copy, label: copy };
        } catch (error) {
          if (codeOf(error) !== "EEXIST") throw error;
        }
      }
      throw new Error("Could not find a free name for the conflict copy");
    },
    isConflict: (error) => codeOf(error) === "CONFLICT",
  };
}
