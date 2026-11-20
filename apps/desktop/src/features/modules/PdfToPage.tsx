/**
 * Page from PDF… (ADR-0055): the person picks a PDF (the host's picker, so only that file can be opened), the host
 * reads it (each page's own text when it is good, else OCR) and a new page holds it: the file's name as its title,
 * "Imported from `<file>`", then one `## Page N` per PDF page. At most 50 pages; past that the page says so. Progress
 * "Page 3 of 12" with Cancel; nothing is created unless the read finished. OCR not downloaded: Open Settings.
 */
import { useEffect, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import { docToMarkdown } from "@thoth/editor";
import { ConflictError } from "@thoth/local-store";
import type { Modules } from "@thoth/platform";
import { Button } from "@thoth/app-ui/ui/Button.tsx";
import { Modal } from "@thoth/app-ui/ui/Modal.tsx";
import { useSession } from "../../app/context.ts";
import { useDesktopStrings } from "../../strings/index.ts";
import { targetFolder } from "../shell/target-folder.ts";

/** The host's own limits (crates/thoth-host/src/modules/runner.rs). */
const MAX_PDF_BYTES = 50_000_000;
const MAX_PDF_PAGES = 50;

type Strings = ReturnType<typeof useDesktopStrings>["pdfToPage"];
type State = { step: "picking" } | { step: "reading"; page: number; pages: number } | { step: "failed"; text: string; settings?: boolean };

const text = (t: string): JSONContent[] => (t === "" ? [] : [{ type: "text", text: t }]);
const paragraph = (t: string): JSONContent => ({ type: "paragraph", content: text(t) });
const heading = (level: number, t: string): JSONContent => ({ type: "heading", attrs: { level }, content: text(t) });

/** The new page's Markdown: escaped like typed text, so a PDF's `#` or `*` stays text. */
export function pdfPageMarkdown(t: Strings, title: string, file: string, pages: readonly { text: string }[], total: number): string {
  const content: JSONContent[] = [
    heading(1, title),
    { type: "paragraph", content: [{ type: "text", text: t.importedFrom }, { type: "text", text: file, marks: [{ type: "inlineCode" }] }] },
  ];
  if (total > pages.length) content.push(paragraph(t.firstPages(pages.length, total)));
  pages.forEach((p, i) => {
    content.push(heading(2, t.pageHeading(i + 1)));
    // One paragraph per line, as Insert text below does; an empty page keeps its heading.
    for (const line of p.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")) content.push(paragraph(line));
  });
  return docToMarkdown({ type: "doc", content });
}

export function PdfToPage({ modules, onClose }: { modules: Modules; onClose(): void }) {
  const t = useDesktopStrings().pdfToPage;
  const { platform, vault, refresh, openPage, openSettings } = useSession();
  const [state, setState] = useState<State>({ step: "picking" });
  const cancelled = useRef(false);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const fail = (text: string, settings?: boolean) => live && setState({ step: "failed", text, ...(settings ? { settings } : {}) });
    void (async () => {
      const location = await platform.pickImportSource("pdf").catch(() => null);
      if (!live) return;
      if (!location) return onClose();
      const host = await platform.openImportSource(location);
      let bytes: Uint8Array;
      try {
        const file = await host.open("");
        try {
          if (file.size > MAX_PDF_BYTES) return fail(t.tooLarge);
          bytes = await file.read(0, file.size);
        } finally {
          await file.close();
        }
      } finally {
        await host.close();
      }
      if (!live) return;
      const name = host.label;
      const title = name.replace(/\.pdf$/i, "").trim() || t.untitled;
      setState({ step: "reading", page: 0, pages: 0 });
      const off = await modules.onReadProgress((p) => live && setState({ step: "reading", page: p.page, pages: p.pages }));
      if (!live) return off();
      stop = off;
      let read: Awaited<ReturnType<Modules["read"]>>;
      try {
        read = await modules.read("pdf", bytes);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "OCR_CANCELLED" || cancelled.current) return live && onClose();
        if (code === "OCR_NOT_INSTALLED") return fail(t.notInstalled, true);
        return fail(code === "OCR_TOO_LARGE" ? t.tooLarge : code === "OCR_BAD_FILE" ? t.badFile : code === "OCR_TIMEOUT" ? t.timeout : t.failed);
      }
      if (!live) return;
      // Cancel pressed as the last page came back: still nothing is created.
      if (cancelled.current) return onClose();
      const markdown = pdfPageMarkdown(t, title, name, read.pages, Math.max(read.total ?? read.pages.length, read.pages.length));
      // In the selected folder, as New page does; a name already taken gets " 2", " 3"….
      const folder = targetFolder();
      const base = folder === "" ? "" : `${folder}/`;
      for (let n = 1; n < 1000; n++) {
        const path = `${base}${n === 1 ? title : `${title} ${n}`}.md`;
        try {
          await vault.createPage(path, markdown);
        } catch (failure) {
          if (failure instanceof ConflictError) continue;
          return fail(t.failed);
        }
        await refresh([path]);
        openPage(path);
        return live && onClose();
      }
      fail(t.failed);
    })().catch(() => fail(t.failed));
    return () => {
      live = false;
      stop?.();
    };
    // Runs once per dialog: the dialog is the run.
  }, []);

  const cancel = () => {
    cancelled.current = true;
    void modules.cancelRead().catch(() => undefined);
  };

  if (state.step === "picking") return null;
  return (
    <Modal title={t.title} {...(state.step === "failed" ? { onClose } : {})}>
      {state.step === "reading" ? (
        <>
          <p role="status" aria-live="polite">
            {state.pages > 0 ? t.progress(state.page, state.pages) : t.reading}
          </p>
          {state.pages > 0 && <progress max={state.pages} value={state.page} aria-label={t.title} />}
          <p className="muted small">{t.limit}</p>
          <div className="modal-actions">
            <Button variant="quiet" data-autofocus onClick={cancel}>
              {t.cancel}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p role="alert">{state.text}</p>
          <div className="modal-actions">
            {state.settings && (
              <Button
                variant="primary"
                data-autofocus
                onClick={() => {
                  onClose();
                  openSettings("modules");
                }}
              >
                {t.openSettings}
              </Button>
            )}
            <Button variant="quiet" onClick={onClose}>
              {t.close}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
