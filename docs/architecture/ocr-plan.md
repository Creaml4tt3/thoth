# OCR in Thoth: review of the handoff, and a plan

- **Status:** Proposal for the owner. Nothing is built yet.
- **Date:** 2026-11-10
- **Input:** "Thoth Modules: OCR Module Architecture — Engineering Handoff" (another agent's proposal).
- **Next step:** the Phase 0 spike, then ADR-0053. The owner's decisions are in §7.

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
   now. Build OCR as the first module, with only the shared parts every module needs (§5). Leave out the registry and
   the resolver.
4. **Signing infrastructure can be replaced by hashes compiled into the app.** The app version that offers the
   download already knows the exact files and their SHA-256 hashes. So:
   - there is no remote manifest to sign, and no new key to protect;
   - new models or languages arrive with an app update, which in-app updates (ADR-0034) already deliver safely;
   - the files are hosted on the R2 bucket we already have, under `download.thothnotes.com/modules/ocr/<version>/`.

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

## 3. What OCR should do in Thoth

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
- **The download:** an "OCR (Thai and English)" card in Settings → Modules, with Download, Remove, and the space
  it uses. The host:
  1. downloads ONNX Runtime and the two PP-OCRv5 models (detection and Thai recognition) from R2 into
     `<app-data>/modules/ocr/<version>/`;
  2. checks each file against the SHA-256 compiled into the app;
  3. switches over by renaming a folder;
  4. deletes the old version after a test image reads correctly.

  Removing it deletes only that folder.
- **Output:** text lines with a bounding box and a confidence each, plus plain text in reading order. Tables and layout
  come later.
- **macOS:** today's ad-hoc signed app can load a downloaded library. Once the app is signed with a Developer ID and the
  hardened runtime, the downloaded ONNX Runtime library must be signed too, or the app needs a library-validation
  exception. Phase 0 tests this.

## 5. Modules: what is shared now, what waits

Other big local features would follow the same pattern: download large files, check them, and run them in a child
process. Examples are speech-to-text for voice notes (Whisper), embeddings for search by meaning, and a local model for
summaries. So OCR is built as the first module, with only the parts every module needs:
- **Module store (host, Rust).** It downloads to `<app-data>/modules/<id>/<version>/`, checks each file's SHA-256,
  renames the folder to switch versions, keeps the last good version until the new one passes its self-test, removes a
  module, and reports the space used.
- **Module runner (host, Rust).** It starts the module's program as a child process, one job at a time. It sends
  newline-delimited JSON over stdio, enforces a time limit and Cancel, and kills the process when the app quits. It
  reuses the agent-run supervision.
- **A compiled-in list of modules.** Each entry gives an id, a version, its files per platform with URL, size and
  SHA-256, and the program to run. Adding a module, a language or a model is a new app version.
- **Settings → Modules.** One card per module, with what it does, its download size, Download, Remove and the space
  used.

These wait until a real need appears:
- **A remote, signed registry.** Needed when modules must update faster than the app.
- **A dependency resolver.** Needed when two modules share a runtime.
- **Third-party modules.** Never in the plan. They would mean running other people's code.

Each can be added behind the same store and runner without changing the modules.

## 6. Phases

**Phase 0 — spike (about 3–4 days), ending in ADR-0053.**
- Build a command-line `thoth-ocr` on `oar-ocr`, with PP-OCRv5 mobile detection and `th_PP-OCRv5_mobile_rec`.
- Render PDF pages with pdfium (prebuilt binaries, Apache-2.0/BSD). Use the PDF's own text where a page has some.
- Platforms: macOS arm64, Windows x64 and Linux x64, built in CI like the app.
- Test corpus: 40–60 images with checked text, plus a held-out part. It covers Thai, English, mixed lines, app
  screenshots, phone photos, scanned PDFs and two-column pages. Its sources:
  - the owner's own images, kept outside the repo;
  - public images whose license allows it, such as Thai Wikipedia screenshots (CC BY-SA) and public-domain scans;
  - synthetic pages: Thai and English text rendered in free fonts (Noto Sans Thai, Sarabun), then blurred, skewed and
    compressed. Their text is known exactly.
- Measure: CER on Thai, English and mixed text separately; p50/p95 time per image and per PDF page; peak memory;
  download size and installed size; cold start.
- Compare against the Tesseract `tha` model as a baseline, and macOS Vision if it lists Thai.
- Check every license: the PaddleOCR models, oar-ocr, ONNX Runtime (MIT) and pdfium.
- Exit criteria: readable Thai on screenshots and scans, a total download under about 50 MB, and no license blocker.
  If Rust fails on a hard blocker, only then try Python.

**Phase 1 — the module store and runner, Settings → Modules, and text from an image.**
- On an image in a page: "Copy text" and "Insert text below".
- The job shows progress, has Cancel, and reports errors in plain words.
- The new strings come in English and Thai (marked REVIEW).
- Tests cover the hash check, an interrupted download, removal, the limits, and a stuck child process being killed.

**Phase 2 — scanned PDF to a page.** "Import → PDF" makes a page of text from a PDF or an image:
- the PDF's own text where it has some, OCR elsewhere;
- page breaks kept, and a link to the original file;
- a limit on the page count, with progress per page.

**Later.**
- Search inside images: image text in the local search index, behind a switch that is off by default.
- More languages from PP-OCRv6 (Latin scripts, Japanese, Chinese).
- Layout and table models, each a separate download.

## 7. Decisions

Decided by the owner on 2026-11-10:
- First features: text from an image, and scanned PDF to a page.
- Rust only (no Python), unless Phase 0 hits a blocker.
- Files on R2 under `download.thothnotes.com/modules/`, with hashes compiled into the app.
- Test images: some from the owner, the rest public or synthetic.

Proposed in §5, waiting for the owner: build OCR as the first module, with a shared store and runner and Settings →
Modules, but no registry yet.

[pp5-multi]: https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.html
[th-card]: https://huggingface.co/PaddlePaddle/th_PP-OCRv5_mobile_rec
[pp6]: https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv6/PP-OCRv6.html
[oar]: https://docs.rs/crate/oar-ocr
[surya]: https://huggingface.co/datalab-to/surya-ocr-2
[vision]: https://developer.apple.com/forums/thread/121048
[winocr]: https://pypi.org/project/winocr/0.0.13
