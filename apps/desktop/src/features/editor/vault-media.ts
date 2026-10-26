/**
 * A Private Space page's images (ADR-0028): read through the vault's host-backed filesystem (paths inside the vault
 * only), and added next to the page through the vault's compare-and-swap write, so an existing file is never replaced.
 */
import { addPageImage, loadPageImage, type ImageSpace, type PageMedia } from "@thoth/app-ui/editor/media.ts";
import { ConflictError, type Vault } from "@thoth/local-store";

export function vaultImageSpace(vault: Vault): ImageSpace {
  return {
    async size(path) {
      const stat = await vault.fs.stat(path);
      return stat?.kind === "file" ? stat.size : undefined;
    },
    read: (path) => vault.fs.readFile(path),
    async create(path, bytes) {
      try {
        await vault.writeFileAtomic(path, bytes, { expectedHash: null });
        return true;
      } catch (error) {
        if (error instanceof ConflictError) return false;
        throw error;
      }
    },
  };
}

/** The images of the page at vault path `page`. */
export function vaultPageMedia(vault: Vault, page: string): PageMedia {
  const space = vaultImageSpace(vault);
  return {
    load: (src) => loadPageImage(space, page, src),
    async add(file) {
      const { src, alt } = await addPageImage(space, page, file);
      return { src, alt };
    },
  };
}
