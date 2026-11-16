# OCR in Thoth: review of the handoff, and a plan

- **Status:** Proposal for the owner. Nothing is built yet.
- **Date:** 2026-11-10, updated 2026-11-15 with iApp's OpenThai 2.0 OCR (§2a)
- **Input:** "Thoth Modules: OCR Module Architecture — Engineering Handoff" (another agent's proposal).
- **Next step:** the Phase 0 spike, then ADR-0054. The owner's decisions are in §7 (all made by 2026-11-16).

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
   `ort` crate. With it, OCR becomes a small Rust program built in our own pipeline. The model files are the only
   downloads, plus ONNX Runtime if the pure-Rust engine isn't good enough (§4). The handoff itself names Rust as the
   long-term target; starting there skips one rewrite.
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
| A Rust/ONNX path exists | `oar-ocr` (GreatV) runs PaddleOCR det/rec and layout models on ONNX Runtime through `ort`. It is Apache-2.0 and active (v0.10.2 on 2026-10-26), but small: about 200 stars and one main author. It prepares images with the Rust `image` crates, without OpenCV, and pins `ort` 2.0.0-rc.13. [docs.rs][oar], [GitHub][oar-gh] |
| The model files exist as ONNX | Yes, in oar-ocr's v0.3.0 release: detection 4.6 MB, the Thai recognizer 7.5 MB, and the Thai dictionary (a small text file). That is three files and about 12 MB. They are conversions made by the oar-ocr project, not files published by PaddlePaddle. [models list][oar-models] |
| ONNX Runtime runs on every platform Thoth ships | **No.** ONNX Runtime 1.31.1 publishes a macOS build for Apple Silicon only, and none for Intel Macs. Thoth's Mac app is universal (Apple Silicon and Intel). [releases][ort-rel] |
| OCR needs ONNX Runtime | Not necessarily. `ort` can run on a pure-Rust engine instead (`ort-tract`), with no native library. That backend is young (0.1.0), so its speed and its support for these models are unknown. [ort release notes][ort-alt] |
| Surya is a candidate | Its code is Apache-2.0, but the weights use a modified OpenRAIL-M license with a revenue limit. That doesn't fit an Apache-2.0 app anyone may use. **Drop it.** [model card][surya] |
| The OS's built-in OCR could help | Not reliable for Thai. On macOS, Vision lists its languages at runtime. A user reported `th-TH` in that list on macOS 14, and another reported Thai missing in a later Vision version; Apple publishes no list. On Windows, `Windows.Media.Ocr` has no documented Thai pack. To be checked in Phase 0, not relied on. [MacScripter][vision-th], [Apple forum][vision-26], [winocr][winocr] |
| A PDF renderer with a usable license | Two candidates. pdfium has prebuilt libraries for every platform, including a universal Mac build (3.4–7 MB). `hayro` is a pure-Rust PDF renderer (Apache-2.0, active), with no native library. [pdfium-binaries][pdfium], [hayro][hayro] |

For scale, today's installers are 5.7 MB (Windows), 14.5 MB (macOS) and 8.3 MB (Linux .deb). The models alone are
12 MB, so downloading OCR on demand is right whichever engine runs them.

Still unverified: the PaddleOCR model licenses (expected Apache-2.0), the size of the ONNX Runtime library alone on
each platform (its release archives are 10–79 MB and hold more than the library), and the installed sizes. Phase 0
settles them.

## 2a. Update 2026-11-15: OpenThai 2.0 OCR (iApp)

The owner found iApp's guide ([blog][ot-blog]). iApp released two Thai OCR models in November 2026. One of them fits
this plan better than the stock PaddleOCR Thai model, and changes the recommended model, not the design.

| | OpenThai2.0-OCR-Text | OpenThai2.0-OCR-Markdown |
| --- | --- | --- |
| What | PP-OCRv6-tiny detector (unchanged) + PP-OCRv6-tiny recognizer fine-tuned for Thai with a new 528-character Thai+English output layer; CTC line recognizer | Thai fine-tune of NVIDIA Nemotron 3.5 Parse (631M parameters, vision encoder + mBART decoder) |
| Output | Lines in reading order, a box and a confidence each; page rotation. No tables, no Markdown | Markdown, tables as HTML, a box and class per block |
| Licence | **Apache-2.0** (NOTICE: derived from PaddlePaddle's PP-OCRv6 tiny models, Apache-2.0) | OpenMDW-1.1 (NVIDIA's model licence), tokenizer MIT |
| Files | `det.onnx` 1.8 MB, `rec.onnx` 2.4 MB, `rec_dict.txt` 2 KB: **about 4.2 MB**, with `SHA256SUMS` in the repo | `model.safetensors` 2.52 GB (fp32) |
| Runs on | CPU, ONNX Runtime or OpenVINO | vLLM on an NVIDIA GPU; on Apple silicon through PyTorch MPS at 15–27 s a page |
| Printed Thai (iApp's 12 sets, 100×(1−CER)) | 87.8 | 90.3 |
| Handwriting | 10.3: printed text only | 78.9 |

For comparison, on the same table: Typhoon OCR V2 2B 89.6, Google Cloud Vision 83.6, **PaddleOCR PP-OCRv5 Thai 81.1**
(the model this plan picked), Tesseract `tha+eng` 75.4. iApp measured all of these themselves, so Phase 0 still uses
our own corpus. [Text card][ot-text], [Markdown card][ot-md]

**Checked here (2026-11-15):**
- The three files' SHA-256 match the repo's `SHA256SUMS`.
- Both are plain ONNX (detector opset 14, recognizer opset 17), input `x` as N×3×H×W, recognizer height 48. They use
  only common operators: Conv, ConvTranspose, Resize, Erf, HardSigmoid, HardSwish, MatMul, Softmax, pooling and
  element-wise ops. Nothing custom, so `ort-tract` has a fair chance of running them (Phase 0 confirms).
- iApp's own Python runtime with ONNX Runtime fp32, one thread, on an Apple M4: a synthetic four-line Thai+English
  page (Ayuthaya font) read with **0 wrong characters in 0.13 s**. One clean image is a smoke test, not a benchmark.
- `oar-ocr` 0.10.2 already runs PP-OCRv6 tiny det/rec models with a custom dictionary, so the Rust path in §4 needs no
  new engine, only these files and our own pre- and post-processing settings.

**What changes in the plan:**
- **The Phase 0 primary model becomes OpenThai2.0-OCR-Text.** `th_PP-OCRv5_mobile_rec` stays as the comparison.
  The download shrinks from about 12 MB to about 4.2 MB.
- **Pre- and post-processing matter as much as the weights.** iApp's runtime (Python, about 1,000 lines) does
  orientation from the text, deskew above 2.5°, reading order for two and three columns, background flattening for
  coloured and light-on-dark text, dropping detached-mark fragments and Thai/Latin look-alike fixes (a lone `W` glued
  to Thai becomes `พ`). `oar-ocr` does detection, cropping and CTC decoding but not all of this. Phase 0 measures the
  gap on our corpus and ports only the steps that pay off. The runtime's own licence must be confirmed before any
  code is ported (the repo's licence is Apache-2.0; confirm it covers `runtime/`).
- **The Thai line-joining rule in §4 matches iApp's default** (`join.thai_no_space`), which Phase 0 checks.
- **OCR Markdown is not for the desktop app now.** 2.5 GB, a GPU for usable speed and a separate model licence rule
  it out of an on-demand CPU module. It is the candidate for "Later: layout and tables", and is noted for a possible
  server-side option, which would need its own decision (it breaks "images never leave the computer").
- **No iApp API.** It would send documents to a third party; the plan stays local.
- Handwriting stays out of scope (the Text model scores 10.3).

Caveats: the models are from November 2026 (v1.0.0) by one company; iApp's speed comparisons on its own pages
disagree with each other (its model page still uses an outdated Typhoon figure). Pin by SHA-256 and host on R2 as
§4 says, so an upstream change can't reach users.

## 3. What OCR should do in Thoth

| Feature | What the user does | Fit |
| --- | --- | --- |
| **A. Text from an image** | Right-click an image in a page → "Copy text" or "Insert text below". | Smallest. The user starts it and sees the result, and nothing runs in the background. **First (Phase 1).** |
| **B. Search inside images** | Search finds a page by the words in its screenshots. | The most useful long term, but it OCRs every image in the background (CPU and battery), and the text has to be stored in the search index (`.thoth`, ADR-0046), never in the Markdown. Later. |
| **C. Scanned PDF to a page** | Import a PDF or an image as a new page of text. | Needs a PDF renderer and reading order. PDFs that already contain text need no OCR at all. **Second (Phase 2).** |
| D. Agents read image text | MCP `read_page` includes the text of the page's images. | Comes for free after B. |

Desktop only. The web app stays trial-only and gets no OCR. Workspace images are OCR'd on the desktop when the user
asks; the server doesn't change.

## 4. Proposed design

- **The OCR program:** a small Rust binary, `thoth-ocr`, built from this repo and shipped in the installer next to
  `thoth-mcp`, the same way (Tauri `externalBin`).
  - A crash or a stuck model can't take the app down, because the host runs it as a child process. The host already
    supervises agent CLIs this way (`crates/thoth-host/src/agent`): process groups, a timeout, and a kill when the
    window closes.
- **The inference engine: two candidates, and Phase 0 picks one.**

  | | A. ONNX Runtime, downloaded | B. Pure Rust (`ort-tract`), compiled in |
  | --- | --- | --- |
  | What is downloaded | The three model files and a native library | The three model files only: data, never code |
  | Intel Macs | No official build. OCR would be Apple Silicon only, or we build the library ourselves | Works |
  | macOS hardened runtime | The downloaded library must be signed, or needs an exception | No issue |
  | Speed | The reference | Unknown, probably slower |
  | Risk | Low: it is what oar-ocr is tested on | The backend is young and may not support these models |

  B is preferred if it reads the corpus correctly and is fast enough, because it removes three problems at once. A is
  the fallback.
- **Talking to it:** over stdin and stdout. There is no port, as the handoff prefers.
  - Each request is one line of JSON followed by exactly the number of bytes it names. Nothing is base64, so a large
    PDF costs no extra memory.
  - Requests carry the file's bytes, never a path. The host reads them itself: a Private Space file through `VaultFs`,
    a workspace image from the server. The OCR program never opens the vault.
  - Limits: image size in megapixels, a page count for PDFs, a timeout per job, and one job at a time.
- **The download:** an "OCR (Thai and English)" card in Settings → Modules, with Download, Remove, and the space
  it uses. The host:
  1. downloads the three model files (detection, Thai recognition and the Thai dictionary), and the native libraries
     if the engine needs any, from R2 into `<app-data>/modules/ocr/<version>/`;
  2. checks each file against the SHA-256 compiled into the app;
  3. switches over by renaming a folder;
  4. deletes the old version after a test image reads correctly.

  Removing it deletes only that folder. The host checks the hashes again each time it starts the program, which
  takes well under a second for files this size.
- **Where the model files come from:** iApp's published ONNX files (§2a), pinned by SHA-256 and copied to R2. For the
  PP-OCRv5 comparison, PaddlePaddle's weights converted by a script in the repo, or oar-ocr's converted files.
  Either way the files are hosted on R2, and the app's licenses page names the models, their license and their source.
- **PDF pages** are rendered inside `thoth-ocr`, so a malformed PDF can only crash the child process. The renderer is
  pdfium (a native library, downloaded with the module) or `hayro` (pure Rust, compiled in). Phase 0 picks, for the
  same reasons as the engine.
- **Output:** text lines with a bounding box and a confidence each, plus plain text in reading order. Tables and layout
  come later. Two Thai rules apply:
  - a wrapped line is joined to the next without a space when both sides are Thai, and with a space otherwise;
  - the text is Unicode-normalized (NFC), so a vowel or tone mark is stored the same way every time.
- **When OCR isn't downloaded yet,** "Copy text" on an image explains that and offers the download. Nothing is
  downloaded without the user asking.
- **macOS:** today's ad-hoc signed app can load a downloaded library. Once the app is signed with a Developer ID and the
  hardened runtime, a downloaded library must be signed too, or the app needs a library-validation exception. This
  matters only for engine A or pdfium.

## 5. Modules: what is shared now, what waits

Other big local features would follow the same pattern: download large files, check them, and run them in a child
process. Examples are speech-to-text for voice notes (Whisper), embeddings for search by meaning, and a local model for
summaries. So OCR is built as the first module, with only the parts every module needs:
- **Module store (host, Rust).** It downloads to `<app-data>/modules/<id>/<version>/`, checks each file's SHA-256,
  renames the folder to switch versions, keeps the last good version until the new one passes its self-test, removes a
  module, and reports the space used.
- **Module runner (host, Rust).** It starts the module's program as a child process, one job at a time. It talks to
  it over stdio (§4), enforces a time limit and Cancel, and kills the process when the app quits. It reuses the
  agent-run supervision.
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

**Phase 0 — spike (about a week), ending in ADR-0054.**
- Build a command-line `thoth-ocr` on `oar-ocr` with OpenThai2.0-OCR-Text (§2a). Compare it with PP-OCRv5 mobile
  detection + `th_PP-OCRv5_mobile_rec`, and with iApp's Python runtime on the same files as the reference output.
- Run it on both engines (§4): ONNX Runtime, and pure Rust through `ort-tract`. Compare accuracy, speed and size.
- Render PDF pages with pdfium and with `hayro`. Use the PDF's own text where a page has some.
- Platforms: macOS (Apple Silicon and Intel), Windows x64 and Linux x64, built in CI like the app.
- Test corpus: 40–60 images with checked text, plus a held-out part. It covers Thai, English, mixed lines, app
  screenshots, phone photos, scanned PDFs and two-column pages. Its sources:
  - the owner's own images, kept outside the repo;
  - public images whose license allows it, such as Thai Wikipedia screenshots (CC BY-SA) and public-domain scans;
  - synthetic pages: Thai and English text rendered in free fonts (Noto Sans Thai, Sarabun), then blurred, skewed and
    compressed. Their text is known exactly.
- Measure: CER (the share of wrong characters) on Thai, English and mixed text separately; p50/p95 time per image and
  per PDF page; peak memory; download size and installed size; cold start; and how much `thoth-ocr` adds to each
  installer. No word error rate: Thai has no spaces between words, so it would measure the word splitter.
- Compare against the Tesseract `tha` model as a baseline, and macOS Vision if it lists Thai.
- Check every license: the OpenThai and PaddleOCR models, iApp's runtime (before porting any of it), oar-ocr, ONNX Runtime (MIT), pdfium and hayro.
- Exit criteria. The numbers are targets set before measuring; the ADR records what was reached:
  - Thai CER of at most 5% on screenshots and synthetic pages, and at most 10% on scans and phone photos;
  - better than Tesseract `tha` on every group of images;
  - the owner reads ten outputs next to their images and finds them usable;
  - p95 of at most 3 seconds for a screenshot on a laptop without a GPU;
  - a download of at most 50 MB, and no more than about 5 MB added to an installer;
  - no license blocker.

  If Rust fails on a hard blocker, only then try Python.

**Phase 1 — the module store and runner, Settings → Modules, and text from an image.**
- On an image in a page: "Copy text" and "Insert text below". The editor has no menu on images today, so this phase
  adds one.
- The licenses page lists the models and libraries. The privacy notice says what the download request reveals (the
  same as an update download) and that images never leave the computer.
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

Left out of the handoff on purpose:
- The install wizard's language and quality choices. There is one pack, Thai and English Lite, so there is nothing to
  choose yet.
- A Repair action. Remove and Download do the same.
- Resumable downloads. At 50 MB or less, a failed download starts again.
- A test set of 100–200 pages for the spike. It starts at 40–60 and grows before Phase 1 ships.
- Table and layout scores, until those models are in the plan.

Decided by the owner on 2026-11-16:
- Test first: Phase 0 runs, and its numbers decide, before any of Phase 1 is built.
- OCR is a separate download (§5: the first module, with a shared store and runner and Settings → Modules, no
  registry yet), not part of the installer.
- Every platform Thoth ships gets it, Intel Macs included. If Phase 0 picks ONNX Runtime, we build the library for
  Intel Macs ourselves rather than leave them out.
- OpenThai2.0-OCR-Text is the Thai model to try first (§2a).

[pp5-multi]: https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.html
[th-card]: https://huggingface.co/PaddlePaddle/th_PP-OCRv5_mobile_rec
[pp6]: https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv6/PP-OCRv6.html
[oar]: https://docs.rs/crate/oar-ocr
[surya]: https://huggingface.co/datalab-to/surya-ocr-2
[oar-gh]: https://github.com/GreatV/oar-ocr
[oar-models]: https://docs.rs/crate/oar-ocr/0.6.3/source/docs/models.md
[ort-rel]: https://github.com/microsoft/onnxruntime/releases/tag/v1.31.1
[ort-alt]: https://newreleases.io/project/github/pykeio/ort/release/v2.0.0-rc.10
[vision-th]: https://www.macscripter.net/t/image-png-to-text-through-applescript/74490/27
[vision-26]: https://developer.apple.com/forums/thread/850452
[pdfium]: https://github.com/bblanchon/pdfium-binaries
[hayro]: https://github.com/LaurenzV/hayro
[winocr]: https://pypi.org/project/winocr/0.0.13
[ot-blog]: https://iapp.co.th/blog/openthai2p0-ocr-how-to-run
[ot-text]: https://huggingface.co/iapp/OpenThai2.0-OCR-Text
[ot-md]: https://huggingface.co/iapp/OpenThai2.0-OCR-Markdown
