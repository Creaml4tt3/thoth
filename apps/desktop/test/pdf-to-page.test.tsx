// @vitest-environment jsdom
/**
 * Page from PDF… (ADR-0055): pick a PDF, the host reads it (its own text, or OCR), and a new page holds one `## Page N`
 * per PDF page under "Imported from `<file>`". Past 50 pages the page says only the first 50 were read; Cancel creates
 * nothing; "not installed" offers Settings and creates nothing. OCR is a fake that answers like `ocr.read`.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModuleStatus, Modules, OcrModel } from "@thoth/platform";
import { cleanup, openApp, screen, waitFor, within, type Harness } from "./support/render.tsx";
import { createNodePlatform, tempDirs } from "./support/node-platform.ts";
import { seed } from "./support/fixtures.ts";

type Read = Awaited<ReturnType<Modules["read"]>>;

class FakeOcr implements Modules {
  reads: { kind: string; bytes: Uint8Array }[] = [];
  cancels = 0;
  answer: () => Promise<Read> = async () => ({ model: "fast", pages: [] });
  progress = new Set<(p: { page: number; pages: number }) => void>();
  async status(): Promise<ModuleStatus> {
    return { available: true, runtime: "1", models: [], autoUpdate: false, job: { state: "idle" } };
  }
  async install(_m: OcrModel) {
    return this.status();
  }
  async cancel() {
    return this.status();
  }
  async remove(_m: OcrModel) {
    return this.status();
  }
  async setAutoUpdate() {
    return this.status();
  }
  async read(kind: "image" | "pdf", bytes: Uint8Array) {
    this.reads.push({ kind, bytes });
    return this.answer();
  }
  async cancelRead() {
    this.cancels++;
  }
  async onProgress() {
    return () => undefined;
  }
  async onReadProgress(listener: (p: { page: number; pages: number }) => void) {
    this.progress.add(listener);
    return () => void this.progress.delete(listener);
  }
}

const dirs = tempDirs();
let root: string;
let pdf: string;
let ocr: FakeOcr;

beforeEach(async () => {
  localStorage.clear();
  root = await dirs.dir();
  await seed(root, { "Notes.md": "# Notes\n" });
  const outside = await dirs.dir();
  pdf = join(outside, "Bank statement.pdf");
  await writeFile(pdf, "%PDF-1.7 synthetic");
  ocr = new FakeOcr();
});
afterEach(async () => {
  cleanup();
  await dirs.cleanup();
});

async function start(): Promise<Harness> {
  const platform = createNodePlatform({ vault: root, modules: ocr });
  platform.pickedSource = pdf;
  const app = await openApp(root, {}, platform);
  await screen.findByRole("tree");
  return app;
}

/** Runs "Page from PDF…" from the command palette. */
async function pageFromPdf(app: Harness) {
  await app.user.keyboard("{Control>}k{/Control}");
  await screen.findByRole("dialog", { name: "Search" });
  await app.user.keyboard("> Page from PDF");
  await app.user.keyboard("{Enter}");
}

const page = (n: number) => ({ text: `Text of page ${n}`, source: n % 2 ? ("text" as const) : ("ocr" as const) });

describe("Page from PDF…", () => {
  it("makes a page with one heading per PDF page", async () => {
    ocr.answer = async () => ({ model: "fast", pages: [page(1), page(2)], total: 2 });
    const app = await start();
    await pageFromPdf(app);
    // Every new page gets its `thoth_id`, as New page does.
    await waitFor(async () => expect((await app.read("Bank statement.md")).replace(/^---\nthoth_id: \S+\n---\n/, "")).toBe("# Bank statement\n\nImported from `Bank statement.pdf`\n\n## Page 1\n\nText of page 1\n\n## Page 2\n\nText of page 2\n"));
    expect(ocr.reads).toHaveLength(1);
    expect(ocr.reads[0]!.kind).toBe("pdf");
    expect(new TextDecoder().decode(ocr.reads[0]!.bytes)).toBe("%PDF-1.7 synthetic");
  });

  it("stops at 50 pages and says so", async () => {
    ocr.answer = async () => ({ model: "fast", pages: Array.from({ length: 50 }, (_, i) => page(i + 1)), total: 72 });
    const app = await start();
    await pageFromPdf(app);
    await waitFor(async () => expect(await app.read("Bank statement.md")).toContain("## Page 50"));
    const text = await app.read("Bank statement.md");
    expect(text).toContain("Only the first 50 of 72 pages were read.");
    expect(text).not.toContain("## Page 51");
  });

  it("shows progress, and cancel creates no page", async () => {
    let finish: (r: Read) => void = () => {};
    ocr.answer = () => new Promise<Read>((resolve) => (finish = resolve));
    ocr.cancelRead = async () => {
      ocr.cancels++;
      finish(Promise.reject(Object.assign(new Error("cancelled"), { code: "OCR_CANCELLED" })) as never);
    };
    const app = await start();
    await pageFromPdf(app);
    const dialog = await screen.findByRole("dialog", { name: "Page from PDF" });
    await waitFor(() => expect(ocr.progress.size).toBe(1));
    for (const l of ocr.progress) l({ page: 3, pages: 12 });
    await within(dialog).findByText("Page 3 of 12");
    await app.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(ocr.cancels).toBe(1);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Page from PDF" })).toBeNull());
    await expect(app.read("Bank statement.md")).rejects.toThrow();
  });

  it("not installed offers Settings", async () => {
    ocr.answer = () => Promise.reject(Object.assign(new Error("no"), { code: "OCR_NOT_INSTALLED" }));
    const app = await start();
    await pageFromPdf(app);
    const dialog = await screen.findByRole("dialog", { name: "Page from PDF" });
    await within(dialog).findByText(/OCR isn't downloaded yet/);
    await app.user.click(within(dialog).getByRole("button", { name: "Open Settings" }));
    await screen.findByRole("heading", { name: "OCR (Thai and English)" });
    await expect(app.read("Bank statement.md")).rejects.toThrow();
  });
});
