import { Vault } from "@thoth/local-store";
import { sha256Hex } from "@thoth/domain";
import { vi, type MockInstance } from "vitest";

export interface WriteCall {
  path: string;
  expectedHash: string | null;
  /** Hash of the file on disk at the moment `writePage` was called. */
  diskHash: string | null;
}

/** Spies on `Vault.writePage` (calling through) and records the disk hash at call time. */
export function guardWrites(): { calls: WriteCall[]; stale(): WriteCall[]; spy: MockInstance } {
  const calls: WriteCall[] = [];
  const original = Vault.prototype.writePage;
  const spy = vi.spyOn(Vault.prototype, "writePage").mockImplementation(async function (this: Vault, path, source, options) {
    const stat = await this.fs.stat(path);
    const diskHash = stat ? sha256Hex(await this.fs.readFile(path)) : null;
    calls.push({ path, expectedHash: options.expectedHash, diskHash });
    return original.call(this, path, source, options);
  });
  return { calls, spy, stale: () => calls.filter((c) => c.expectedHash !== c.diskHash) };
}
