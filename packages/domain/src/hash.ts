import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** Content revision for local files (ADR-003): sha256 of the exact bytes. */
export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === "string" ? utf8ToBytes(data) : data));
}

export interface Sha256Hasher {
  update(chunk: Uint8Array): void;
  digestHex(): string;
}

/** Incremental sha256 for streamed content; same digest as `sha256Hex`. */
export function createSha256(): Sha256Hasher {
  const h = sha256.create();
  return {
    update: (chunk) => void h.update(chunk),
    digestHex: () => bytesToHex(h.digest()),
  };
}
