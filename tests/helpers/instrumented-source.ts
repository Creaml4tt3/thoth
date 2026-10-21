import type { ImportSource } from "@thoth/importer-core";

/**
 * Wraps a real source and records how it is read, so tests can prove which
 * entries were read whole (`read`) versus streamed (`openReadStream`).
 * `rewrite` lets a test change what a given read returns (simulated edits).
 */
export class InstrumentedSource implements ImportSource {
  readonly inner: ImportSource;
  readonly reads: string[] = [];
  readonly streams: string[] = [];
  maxChunk = 0;
  rewrite: ((path: string, bytes: Uint8Array, readNumber: number) => Uint8Array) | undefined;
  private readonly readCounts = new Map<string, number>();

  constructor(inner: ImportSource) {
    this.inner = inner;
  }

  get label(): string {
    return this.inner.label;
  }
  get location(): string {
    return this.inner.location;
  }
  get entries() {
    return this.inner.entries;
  }
  get rejected() {
    return this.inner.rejected;
  }

  async read(path: string): Promise<Uint8Array> {
    this.reads.push(path);
    const n = (this.readCounts.get(path) ?? 0) + 1;
    this.readCounts.set(path, n);
    const bytes = await this.inner.read(path);
    return this.rewrite ? this.rewrite(path, bytes, n) : bytes;
  }

  async *openReadStream(path: string): AsyncIterable<Uint8Array> {
    this.streams.push(path);
    for await (const chunk of this.inner.openReadStream(path)) {
      this.maxChunk = Math.max(this.maxChunk, chunk.length);
      yield chunk;
    }
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
