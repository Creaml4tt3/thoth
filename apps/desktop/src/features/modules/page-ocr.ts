/**
 * The image menu's OCR (ADR-0055) on the desktop: `ocr.read` through the host, its `OCR_*` codes as the editor's
 * results. Nothing here downloads: a model that is not there answers "not installed" and the editor offers Settings.
 */
import type { OcrResult } from "@thoth/app-ui/editor/context.ts";
import type { Modules, OcrModel } from "@thoth/platform";

const REASONS = { OCR_TOO_LARGE: "too-large", OCR_BAD_FILE: "bad-file", OCR_TIMEOUT: "timeout" } as const;

export function pageOcr(modules: Modules): { ocr(image: { bytes: Uint8Array }, model?: OcrModel): Promise<OcrResult>; cancelOcr(): void; ocrModels(): OcrModel[] } {
  let installed: OcrModel[] = [];
  return {
    async ocr(image, model) {
      try {
        const read = await modules.read("image", image.bytes, model);
        // Which models "Try the other model" can offer: asked after each read, so a download since then counts.
        installed = (await modules.status().catch(() => null))?.models.filter((m) => m.installed).map((m) => m.id) ?? [read.model];
        return { state: "done", model: read.model, text: read.pages.map((p) => p.text).join("\n") };
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "OCR_NOT_INSTALLED") return { state: "not-installed" };
        if (code === "OCR_CANCELLED") return { state: "cancelled" };
        return { state: "failed", reason: (typeof code === "string" && code in REASONS ? REASONS[code as keyof typeof REASONS] : "failed") };
      }
    },
    cancelOcr: () => void modules.cancelRead().catch(() => {}),
    ocrModels: () => installed,
  };
}
