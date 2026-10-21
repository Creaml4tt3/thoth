/** Archive and directory scan limits (ADR-010). All are configurable per job. */
export interface ScanLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Maximum uncompressed:compressed ratio, applied to entries above `ratioThresholdBytes`. */
  maxCompressionRatio: number;
  ratioThresholdBytes: number;
  /** Whole-archive uncompressed:compressed ratio, so many medium entries cannot add up to a bomb. */
  maxArchiveRatio: number;
  /** The archive-wide ratio applies only once the expanded total exceeds this many bytes. */
  archiveRatioThresholdBytes: number;
  /** Nested archive depth (Notion multi-part exports only). */
  maxNestingDepth: number;
  /**
   * Largest nested archive part (uncompressed bytes) that is opened. Parts are
   * never buffered in memory: STORED parts are read in place and compressed
   * parts are stream-extracted to a private temp file, so this bounds temp
   * disk use and extraction time per part. The effective cap is
   * min(maxEntryBytes, maxNestedArchiveBytes); a part over it rejects the archive.
   */
  maxNestedArchiveBytes: number;
}

export const DEFAULT_LIMITS: ScanLimits = {
  maxEntries: 50_000,
  maxEntryBytes: 1024 ** 3,
  maxTotalBytes: 10 * 1024 ** 3,
  maxCompressionRatio: 200,
  ratioThresholdBytes: 1024 ** 2,
  maxArchiveRatio: 100,
  archiveRatioThresholdBytes: 64 * 1024 ** 2,
  maxNestingDepth: 1,
  maxNestedArchiveBytes: 1024 ** 3,
};

export class ArchiveRejectedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArchiveRejectedError";
    this.code = code;
  }
}
