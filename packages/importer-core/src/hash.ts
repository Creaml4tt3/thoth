import { createSha256 } from "@thoth/domain";

/** Hashes a chunk stream without buffering it; returns the digest and the exact byte count. */
export async function hashStream(chunks: AsyncIterable<Uint8Array>): Promise<{ hash: string; size: number }> {
  const hasher = createSha256();
  let size = 0;
  for await (const chunk of chunks) {
    hasher.update(chunk);
    size += chunk.length;
  }
  return { hash: hasher.digestHex(), size };
}
