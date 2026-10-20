import type { SourceRange } from "./schema.ts";

/** Maps UTF-16 offsets to 1-based line numbers. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(source: string) {
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }

  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  range(start: number, end: number): SourceRange {
    return { start, end, startLine: this.lineOf(start), endLine: this.lineOf(Math.max(start, end - 1)) };
  }
}
