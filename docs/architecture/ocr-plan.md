# OCR in Thoth: review of the handoff, and a plan

- **Status:** Proposal for the owner. Nothing is built yet.
- **Date:** 2026-11-10
- **Input:** "Thoth Modules: OCR Module Architecture — Engineering Handoff" (another agent's proposal).
- **Next step:** the owner's answers to "Decisions for the owner" below. After that comes the Phase 0 spike, then
  ADR-0053.

## 1. Verdict on the handoff

The handoff gets the important rules right:
- OCR stays out of the installer and is downloaded on demand.
- It works offline, sends no document anywhere, and has no telemetry.
- Every download is verified, installed into a staging area, then activated in one step.
- It keeps the Thai+English Lite default, and warns not to trust benchmark numbers.
- It is CPU-first and does not start with VLMs.

All of that fits Thoth's existing rules (ADR-0008 webview without file or network access, ADR-0034 verified downloads,
no telemetry).

Four things should change before anyone builds it.

1. **It never says what OCR does inside Thoth.** It specifies an OCR engine, but not one feature a user would see.
   Thoth is a notes app of Markdown pages. Its images live next to pages (ADR-0028), and PDFs are attachments. The
   plan must start from features: "turn this image into text", "find a page by the words in its screenshots",
   "import a scanned PDF as a page". See §3.
2. **Python is the wrong first runtime for this project.** Thoth's code is Rust and TypeScript. A Python sidecar would
   add:
   - a third language and a PyInstaller build on three operating systems;
   - a runtime of roughly 150–300 MB (numpy, OpenCV and ONNX Runtime, to be measured);
   - native-library problems on each platform.

   A Rust library already exists that runs the same PaddleOCR models through ONNX Runtime: `oar-ocr`, built on the
   `ort` crate. With it, OCR becomes a small Rust program built in our own pipeline. ONNX Runtime and the model files
   are the only downloads. The handoff itself names Rust as the long-term target; starting there skips one rewrite.
3. **A general "Thoth Modules" system is premature.** There is one module. A registry, dependency resolver, signed
   remote manifests and a Modules page are the machinery of a marketplace, and the handoff rules out a marketplace for
   now. Build one OCR download. Give it a design that a second module could reuse, but no framework.
4. **Signing infrastructure can be replaced by hashes compiled into the app.** The app version that offers the
   download already knows the exact files and their SHA-256 hashes. So:
   - there is no remote manifest to sign, and no new key to protect;
   - new models or languages arrive with an app update, which in-app updates (ADR-0034) already deliver safely;
   - the files are hosted on the R2 bucket we already have, under `download.thothnotes.com/ocr/<version>/`.

## 2. Facts checked (2026-11-10)

| Claim in the handoff | What upstream says |
| --- | --- |
| PP-OCRv5 has a Thai recognizer | Yes: `th_PP-OCRv5_mobile_rec`. It reads Thai, English and digits. Line accuracy is 82.68% (strict: one wrong character fails the line). About 7.5 MB. [PaddleOCR docs][pp5-multi], [model card][th-card] |
| "PP-OCRv6 Small should not be assumed to support Thai" | Confirmed: PP-OCRv6 covers about 50 languages (Chinese, English, Japanese and Latin scripts), and Thai is not among them. Thai stays on PP-OCRv5. [PP-OCRv6 docs][pp6] |
| A Rust/ONNX path exists | `oar-ocr` (GreatV) runs PaddleOCR det/rec and layout models on ONNX Runtime through `ort`. Its license and how active it is still need checking. [docs.rs][oar] |
| Surya is a candidate | Its code is Apache-2.0, but the weights use a modified OpenRAIL-M license with a revenue limit. That doesn't fit an Apache-2.0 app anyone may use. **Drop it.** [model card][surya] |
| The OS's built-in OCR could help | Not confirmed for Thai on either system. On macOS, Vision lists its languages at runtime, and no official list includes Thai. On Windows, `Windows.Media.Ocr` has no documented Thai pack. To be checked in Phase 0, not relied on. [Apple forum][vision], [winocr][winocr] |

Still unverified: the exact download and installed sizes, the PaddleOCR model licenses (expected Apache-2.0),
`oar-ocr`'s license, and the size of the ONNX Runtime library on each platform. Phase 0 settles them.

## 3. What OCR should do in Thoth (the owner chooses the first)

| Feature | What the user does | Fit |
| --- | --- | --- |
| **A. Text from an image** | Right-click an image in a page → "Copy text" or "Insert text below". | Smallest. The user starts it and sees the result, and nothing runs in the background. **Recommended first.** |
| **B. Search inside images** | Search finds a page by the words in its screenshots. | The most useful long term, but it OCRs every image in the background (CPU and battery), and the text has to be stored in the search index (`.thoth`, ADR-0046), never in the Markdown. Second. |
| **C. Scanned PDF to a page** | Import a PDF or an image as a new page of text. | Needs a PDF renderer (pdfium) and reading order. PDFs that already contain text need no OCR at all. Third. |
| D. Agents read image text | MCP `read_page` includes the text of the page's images. | Comes for free after B. |

Desktop only. The web app stays trial-only and gets no OCR. Workspace images are OCR'd on the desktop when the user
asks; the server doesn't change.

## 4. Proposed design

- **The OCR program:** a small Rust binary, `thoth-ocr`, built from this repo and shipped in the installer. Without ONNX
  Runtime it is a few MB.
  - It loads ONNX Runtime dynamically (`ort` with `load-dynamic`) from the downloaded files.
  - A crash or a stuck model can't take the app down, because the host runs it as a child process. The host already
    supervises agent CLIs this way: process groups, a timeout, and a kill when the window closes.
- **Talking to it:** newline-delimited JSON over stdin and stdout. There is no port, as the handoff prefers.
  - Requests carry image bytes the host has already read through `VaultFs`, never a path. The OCR program never opens
    the vault.
  - Limits: image size in megapixels, a page count for PDFs, a timeout per job, and one job at a time.
- **The download:** "OCR (Thai and English)" in Settings, with Download, Remove, and the space it uses. The host:
  1. downloads ONNX Runtime and the two PP-OCRv5 models (detection and Thai recognition) from R2 into
     `<app-data>/ocr/<version>/`;
  2. checks each file against the SHA-256 compiled into the app;
  3. switches over by renaming a folder;
  4. deletes the old version after a test image reads correctly.

  Removing it deletes only that folder.
- **Output:** text lines with a bounding box and a confidence each, plus plain text in reading order. Tables and layout
  come later.
- **macOS:** today's ad-hoc signed app can load a downloaded library. Once the app is signed with a Developer ID and the
  hardened runtime, the downloaded ONNX Runtime library must be signed too, or the app needs a library-validation
  exception. Phase 0 tests this.

## 5. Phases

**Phase 0 — spike (about 2–3 days), ending in ADR-0053.**
- Build a command-line `thoth-ocr` on `oar-ocr`, with PP-OCRv5 mobile detection and `th_PP-OCRv5_mobile_rec`.
- Platforms: macOS arm64, Windows x64 and Linux x64, built in CI like the app.
- Test corpus: 40–60 images from the owner's real use, each with checked text, plus a held-out part. It covers Thai,
  English, mixed lines, app screenshots, phone photos and scans. That's smaller than the handoff's 100–200, to start.
- Measure: CER on Thai, English and mixed text separately; p50/p95 time; peak memory; download size and installed
  size; cold start.
- Compare against the Tesseract `tha` model as a baseline, and macOS Vision if it lists Thai.
- Check every license: the PaddleOCR models, oar-ocr, ONNX Runtime (MIT) and pdfium.
- Exit criteria: readable Thai on screenshots, a total download under about 40 MB, and no license blocker.
  If Rust fails on a hard blocker, only then try Python.

**Phase 1 — Feature A.** The OCR download in Settings, and "Copy text" / "Insert text below" on images. Also a job
with progress and Cancel, and errors in plain words. The new strings come in English and Thai (marked REVIEW). Tests
cover the hash check, an interrupted download, removal, the limits, and a stuck child process being killed.

**Phase 2 — Feature B.** Image text in the local search index, built in the background while the app is idle.
It follows a switch that is off by default, and indexed text is cleared when OCR is removed.

**Phase 3 — Feature C and more.**
- PDF import with pdfium, using the PDF's own text where it has some.
- More languages from PP-OCRv6 (Latin scripts, Japanese, Chinese).
- Optional layout and table models, each a separate download.

## 6. Decisions for the owner

1. Which feature first: A (text from an image), B (search inside images) or C (scanned PDF)? Recommended: A.
2. Rust only (no Python), unless Phase 0 hits a blocker? Recommended: yes.
3. One OCR download now, rather than a general "Thoth Modules" system? Recommended: yes.
4. Model files on our R2 under `download.thothnotes.com/ocr/`, with hashes compiled into the app? Recommended: yes.
5. Will you provide 40–60 real images (screenshots, photos, scans) for the test set? Phase 0 needs them.

[pp5-multi]: https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.html
[th-card]: https://huggingface.co/PaddlePaddle/th_PP-OCRv5_mobile_rec
[pp6]: https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv6/PP-OCRv6.html
[oar]: https://docs.rs/crate/oar-ocr
[surya]: https://huggingface.co/datalab-to/surya-ocr-2
[vision]: https://developer.apple.com/forums/thread/121048
[winocr]: https://pypi.org/project/winocr/0.0.13
