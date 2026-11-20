import { describe, expect, it, vi } from "vitest";
import type { Modules, ModuleStatus } from "@thoth/platform";
import { pageOcr } from "../src/features/modules/page-ocr.ts";

const status = (ids: ("fast" | "second")[]): ModuleStatus => ({
  available: true,
  runtime: "1",
  autoUpdate: true,
  job: { state: "idle" },
  models: (["fast", "second"] as const).map((id) => ({ id, installed: ids.includes(id) ? "1" : null, update: null, downloadSize: 0, size: 0, offered: true })),
});
const fail = (code: string) => Object.assign(new Error(code), { code });
const host = (read: Modules["read"]): Modules => ({ read, status: async () => status(["fast", "second"]), cancelRead: vi.fn(async () => {}) }) as unknown as Modules;

describe("pageOcr", () => {
  it("joins the pages' text and learns which models are there", async () => {
    const o = pageOcr(host(async () => ({ model: "fast", pages: [{ text: "a", source: "ocr" }, { text: "b", source: "ocr" }] })));
    expect(o.ocrModels()).toEqual([]);
    expect(await o.ocr({ bytes: new Uint8Array([1]) })).toEqual({ state: "done", model: "fast", text: "a\nb" });
    expect(o.ocrModels()).toEqual(["fast", "second"]);
  });

  it("maps the host's codes", async () => {
    const cases = [
      ["OCR_NOT_INSTALLED", { state: "not-installed" }],
      ["OCR_CANCELLED", { state: "cancelled" }],
      ["OCR_TOO_LARGE", { state: "failed", reason: "too-large" }],
      ["OCR_BAD_FILE", { state: "failed", reason: "bad-file" }],
      ["OCR_TIMEOUT", { state: "failed", reason: "timeout" }],
      ["OCR_BUSY", { state: "failed", reason: "failed" }],
      ["EIO", { state: "failed", reason: "failed" }],
    ] as const;
    for (const [code, result] of cases) expect(await pageOcr(host(async () => Promise.reject(fail(code)))).ocr({ bytes: new Uint8Array() })).toEqual(result);
  });
});
