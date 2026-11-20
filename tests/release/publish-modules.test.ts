/**
 * scripts/publish-modules.ts (ADR-0055, plan §5a): the OCR module's files are gzip, listed with the size and SHA-256 of
 * the `.gz` as downloaded, hosted only under download.thothnotes.com/modules/, and the model list is signed with a key
 * that only ever travels in the environment.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import { fillList, gzipTo, type ModelList, signList } from "../../scripts/publish-modules.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "thoth-modules-"));
  dirs.push(dir);
  return dir;
};

const BASE = "https://download.thothnotes.com/modules/";
const list = (serial: number, url = `${BASE}models/fast/v1/det.onnx.gz`): ModelList => ({
  serial,
  models: [{ id: "fast", version: "v1", preset: "openthai", minApp: "0.12.0", protocol: 1, files: [{ name: "det.onnx", url, size: 0, sha256: "" }] }],
  test: { file: { name: "ocr-test.png", url: `${BASE}test/ocr-test.png.gz`, size: 0, sha256: "" }, expect: ["Q4"] },
});

/** The `.gz` files where the list's URLs say, under `<root>/modules/...`. */
const staged = async () => {
  const root = await tmp();
  for (const [key, body] of [["modules/models/fast/v1/det.onnx", "detector"], ["modules/test/ocr-test.png", "png"]] as const) {
    await mkdir(dirname(join(root, key)), { recursive: true });
    await writeFile(join(root, key), body);
    await gzipTo(join(root, key), join(root, `${key}.gz`));
  }
  return root;
};

describe("publish-modules", () => {
  it("fills size and sha256 of each gz", async () => {
    const root = await staged();
    const filled = fillList(list(2), root, 1);
    const gz = await readFile(join(root, "modules/models/fast/v1/det.onnx.gz"));
    expect(gunzipSync(gz).toString()).toBe("detector");
    expect(filled.models[0]!.files[0]).toEqual({ name: "det.onnx", url: `${BASE}models/fast/v1/det.onnx.gz`, size: gz.length, sha256: createHash("sha256").update(gz).digest("hex") });
    expect(filled.test.file.size).toBeGreaterThan(0);
  });

  it("refuses a url outside download.thothnotes.com/modules/", async () => {
    const root = await staged();
    for (const url of ["https://download.thothnotes.com/v0.12.0/det.onnx.gz", "https://evil.example/modules/det.onnx.gz", "http://download.thothnotes.com/modules/det.onnx.gz", `${BASE}../latest.json`]) {
      expect(() => fillList(list(2, url), root, 1), url).toThrow(/download\.thothnotes\.com\/modules\//);
    }
  });

  it("refuses a serial not above the published one", async () => {
    const root = await staged();
    expect(() => fillList(list(3), root, 3)).toThrow(/serial 3 must be above the published 3/);
    expect(() => fillList(list(2), root, 3)).toThrow(/serial/);
    expect(fillList(list(4), root, 3).serial).toBe(4);
  });

  it("signs with the key from the environment and never prints it", async () => {
    const KEY = "dW50cnVzdGVkIGNvbW1lbnQ6IHNlY3JldCBrZXk=";
    const logged: string[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.join(" "))));
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const run = (args: string[], env: NodeJS.ProcessEnv) => void calls.push({ args, env });
    try {
      signList("/out/models.json", { THOTH_MODULES_SIGNING_KEY: KEY, THOTH_MODULES_SIGNING_KEY_PASSWORD: "pw", PATH: "/bin" }, run);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toContain("/out/models.json");
      expect(calls[0]!.args.join(" ")).not.toContain(KEY);
      expect(calls[0]!.env).toMatchObject({ TAURI_SIGNING_PRIVATE_KEY: KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "pw", PATH: "/bin" });
      // A missing key stops before anything runs.
      expect(() => signList("/out/models.json", { PATH: "/bin" }, run)).toThrow(/THOTH_MODULES_SIGNING_KEY/);
      expect(calls).toHaveLength(1);
      expect(logged.join("\n")).not.toContain(KEY);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
