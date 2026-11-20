import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WATCHED, applyChanges, decide, modelChanged, nextVersion, parseScores } from "../../scripts/model-watch.ts";

const repo = join(import.meta.dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(repo, ...p), "utf8");

describe("the OCR model watch", () => {
  it("proposes only when no group is worse", () => {
    const base = { "synthetic-clean": 1.2, pdf: 3.0, ALL: 2.0 };
    expect(decide(base, { "synthetic-clean": 1.0, pdf: 3.0, ALL: 1.9 }).propose).toBe(true);
    const worse = decide(base, { "synthetic-clean": 0.5, pdf: 3.1, ALL: 1.0 });
    expect(worse.propose).toBe(false);
    expect(worse.table).toContain("| pdf | 3.00 % | 3.10 % | **worse** |");
    // A group the new model was not scored on is not "no worse".
    expect(decide(base, { "synthetic-clean": 1.0, ALL: 1.0 }).propose).toBe(false);
    expect(decide({}, {}).propose).toBe(false);
  });

  it("ignores an unchanged commit", () => {
    const pinned = [
      { path: "README.md", oid: "a" },
      { path: "inference.onnx", oid: "b", lfs: { oid: "sha-1" } },
    ];
    // Only the README changed (its git oid), and the model's LFS hash is the same.
    expect(modelChanged(pinned, [{ path: "README.md", oid: "z" }, { path: "inference.onnx", oid: "c", lfs: { oid: "sha-1" } }], ["inference.onnx"])).toBe(false);
    expect(modelChanged(pinned, [{ path: "inference.onnx", oid: "b", lfs: { oid: "sha-2" } }], ["inference.onnx"])).toBe(true);
    expect(modelChanged(pinned, [], ["inference.onnx"])).toBe(true);
  });

  it("reads score.py's group lines", () => {
    const out = `fast                         pdf                  all    items=  9 CER=  4.00% oCER=  2.50%
fast                         pdf                  th     items=  5 CER=  4.00% oCER=  9.99%
fast                         ALL                  all    items= 39 CER=  3.00% oCER=  1.25%`;
    expect(parseScores(out)).toEqual({ pdf: 2.5, ALL: 1.25 });
  });

  it("watches the revisions stage-models.sh pins", () => {
    const stage = read("scripts", "ocr", "stage-models.sh");
    for (const w of WATCHED) expect(stage).toContain(`${w.repo}/resolve/${w.revision}`);
  });

  it("switches the model's version everywhere and raises the serial", () => {
    expect(nextVersion("openthai-2.1-20261118", "20270102")).toBe("openthai-2.1-20270102");
    const texts = { list: read("modules", "models.json"), stage: read("scripts", "ocr", "stage-models.sh"), release: read(".github", "workflows", "release-ocr.yml") };
    const fast = WATCHED.find((w) => w.model === "fast")!;
    const next = applyChanges(texts, [{ model: "fast", repo: fast.repo, from: fast.revision, to: "f".repeat(40), date: "20270102" }]);
    const list = JSON.parse(next.list) as { serial: number; models: { id: string; version: string; files: { url: string }[] }[] };
    expect(list.serial).toBe(JSON.parse(texts.list).serial + 1);
    const entry = list.models.find((m) => m.id === "fast")!;
    expect(entry.version).toBe("openthai-2.1-20270102");
    expect(entry.files.every((f) => f.url.includes("/openthai-2.1-20270102/"))).toBe(true);
    expect(list.models.find((m) => m.id === "second")!.version).toBe("pp-ocrv5-th-20250821");
    expect(next.stage).toContain(`${fast.repo}/resolve/${"f".repeat(40)}`);
    expect(next.stage).not.toContain("openthai-2.1-20261118");
    expect(next.release).not.toContain("openthai-2.1-20261118");
  });
});
