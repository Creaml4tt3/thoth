# ADR-0055: The OCR module: engine, models, PDF renderer and the broken-text check

- **Status:** Proposed (Phase 0 spike, 2026-11-19). The owner decides; §"Decisions for the owner" lists what is open.
- **Date:** 2026-11-19
- **Deciders:** project owner
- **Builds on:** [the OCR plan](../architecture/ocr-plan.md) §2b, §4, §5, §5a, §6; ADR-0008, ADR-0034.
- **Evidence:** [`tools/ocr-spike/`](../../tools/ocr-spike/) (code, corpus, `models.lock`) and its
  [`results/`](../../tools/ocr-spike/results/): [synthetic](../../tools/ocr-spike/results/synthetic.md),
  [owner's files, aggregate only](../../tools/ocr-spike/results/owner-aggregate.md).

## Context

Phase 0 had to answer, with measured numbers, whether a small Rust `thoth-ocr` on `oar-ocr` reads Thai and English
well and fast enough on a laptop CPU, which engine and PDF renderer to use, and whether a broken Thai PDF text layer
can be detected. Measured on an Apple M4 (10 cores, 16 GB, macOS 15.8.3), CPU only:
- a 39-item synthetic corpus (OFL fonts, original text, exact ground truth; clean, degraded, two-column, PDFs);
- the owner's 19 private files (14 screenshots, 3 phone photos, a 2-page PDF), transcribed by hand.

Baselines: Tesseract 5.5.4 `tha+eng` (tessdata_best), macOS Vision (`VNRecognizeTextRequest` lists `th-TH` on this
Mac), and iApp's own Python runtime for OpenThai 2.1 as the reference.

**Two scores.**
- **oCER** is order-free: each ground-truth line is matched to its best place in the output. Missing and wrong
  characters count; reading order does not.
- **CER** is strict: the whole page in order.

The owner's ground truth leaves out status bars, logos and thumbnails on purpose, so strict CER counts that extra
output as errors. oCER is the number for "did it read the text". Both are scored after the plan's Thai line-joining
rule and NFC.

## Results against the exit criteria (plan §6)

"Fast" = OpenThai 2.1 Text through oar-ocr 0.10.3's preset; "Second opinion" = PP-OCRv5 mobile det +
`th_PP-OCRv5_mobile_rec`. Engine: ONNX Runtime unless noted. Thai oCER (CER).

| Criterion | Target | Fast (OpenThai 2.1) | Second opinion (PP-OCRv5) | Result |
|---|---|---|---|---|
| Thai CER, screenshots (owner, 5) | ≤ 5 % | 1.5 (9.4) | 2.1 (15.3) | **Pass** both on oCER; strict CER fails because of UI chrome left out of the ground truth |
| Thai CER, synthetic clean (6) | ≤ 5 % | 0.0 (0.0) | 3.5 (4.5) | **Pass** both |
| Thai CER, synthetic degraded (8) | ≤ 10 % | 0.1 (0.1) | 0.3 (0.3) | **Pass** both |
| Thai CER, phone photos (owner, 2) | ≤ 10 % | 18.4 (21.7) | 18.9 (23.4) | **Fail** both: a curved bottle label (7 of 30 lines missed); the skewed letter photo is 0.6 % |
| Thai CER, PDF pages (synthetic 6) | ≤ 10 % | 1.2 (1.2) | 1.1 (1.5) | **Pass** both |
| Better than Tesseract on every group | all groups | better on 7 of 8 groups (oCER) | better on 5 of 8 | **Fail** on two-column pages for both (reading order; see below) |
| Owner reads ten outputs next to the images | usable | not done | not done | **Open:** needs the owner |
| p95 per screenshot, laptop, no GPU | ≤ 3 s | 278 ms (ORT), 1.7 s (tract) | 732 ms (ORT), 8.6 s (tract) | **Pass** Fast on both engines; Second opinion passes on ORT only |
| Download ≤ 50 MB | ≤ 50 MB | 6.6 MB models | 12.7 MB models | **Pass** (+ 9.8 MB gzip if ONNX Runtime is downloaded) |
| ≤ ~5 MB added to an installer | ~5 MB | — | — | **Fail if bundled** (`thoth-ocr` is 8–30 MB; 3.8 MB gzip at best). **Pass** by shipping the program in the module download instead (Consequences) |
| No licence blocker | none | Apache-2.0 | Apache-2.0 | **Pass** |

Mixed Thai–English and English on the owner's files: Fast oCER 0.98 % (mixed, 12 items); synthetic English 1.3 %
(Fast), 0.15 % (Second opinion). macOS Vision is the most accurate engine on the owner's files (1.4 % overall), but
see Decision 5.

**Two-column pages.** All engines except Tesseract, iApp's Python runtime included, read a two-column page with a
90 px gutter row by row across both columns (strict CER ≈ 66 %). With a 260 px gutter, oar-ocr's preset reads the
columns correctly. This is a reading-order problem for Phase 2 (PDF to page), not a recognition one.

## Engines

| | ONNX Runtime (`ort`, native) | tract (`ort-tract` 0.4.1, pure Rust) |
|---|---|---|
| Reads the models | Yes, as published | Recognizers yes. **Detectors no** (tract-onnx 0.23.10 can't analyse their `Resize` and `ConvTranspose` with symbolic sizes). Works after a lossless rewrite (`tract_patch.py`: each becomes 1×1 Conv + DepthToSpace, max output difference 1.8e-7) **and** a fixed square input (1280 for OpenThai, 960 for PP-OCRv5) |
| Accuracy | reference | the same within noise (Fast synthetic 5.06 vs 5.20 oCER; owner 3.02 vs 3.12) |
| Speed, owner screenshots p50/p95 | Fast 145 / 278 ms; Second 245 / 732 ms | Fast 1093 / 1675 ms; Second 2897 / 8631 ms (**7–12× slower**) |
| Peak memory | 530–860 MB | 1.5–2.3 GB |
| Cold start | 140–240 ms | 0.6–1.5 s |
| Intel Mac (`x86_64-apple-darwin`) | **Does not build**: `ort-sys` has no prebuilt binary for it | **Builds** (cross-compile checked; not run) |
| Binary, stripped arm64 | 30.3 MB statically linked; 12.6 MB (5.6 MB gzip) with `load-dynamic` + a 35.3 MB `libonnxruntime.dylib` (9.8 MB gzip) to download; 8.0 MB (3.8 MB gzip) with `opt-level="s"`, fat LTO, `panic=abort` | 29.1 MB (11.9 MB gzip); 16.0 MB (7.0 MB gzip) size-optimised |

Versions are pinned to a set that works together: `oar-ocr` =0.10.3, `ort` =2.0.0-rc.13, `ort-tract` =0.4.1. 0.10.3 is
the last oar-ocr on ort rc.13, and rc.13 is the ort that ort-tract 0.4.1 implements. oar-ocr 0.11.0 moved to ort
rc.15, which no ort-tract release supports yet. **oar-ocr's `openthai_from_dir` preset already loads 2.1's `rec2.onnx`**
(routing `MixedThaiLatin`), with 2.1's settings (padded 1280 detection, flatten, `ThaiPrinted` post-processing, deskew
> 2.5°, column reading order, mark re-attachment). No manual wiring was needed. Its output matches iApp's Python
runtime within 0.1 point everywhere (5.20 vs 5.21 synthetic, 3.12 vs 2.98 owner), so **no iApp runtime code needs to
be ported**.

## PDF renderer and text layer

| | hayro 0.9.0 (pure Rust) | pdfium chromium/8125 (via `pdfium-render` 0.9.5) |
|---|---|---|
| OCR accuracy on its renders (synthetic 8 pages) | 1.16 % CER | 1.30 % CER |
| Render, owner brochure (photo background), 144 dpi | 395 ms/page | 249 ms/page |
| Render, synthetic pages | 4–6 ms/page | 5–6 ms/page |
| Size | compiled in (part of the binary above) | 7.4 MB dylib per platform (3.4 MB gzip), universal Mac 7.2 MB tgz |
| Intel Mac | builds | prebuilt `mac-x64` and `mac-univ` exist |
| Text layer, owner's brochure | marks lost **show as U+FFFD/NUL** → detected | marks lost come out **as separate characters in odd places, no tell-tale** → missed |

## The broken-text check

`tools/ocr-spike/src/textcheck.rs` calls a page's Thai text layer **broken** when either:
- it has an unreadable character (U+FFFD, NUL or another control character, or Thai PUA U+F700–F71F); or
- it has ≥ 0.5 orphan gaps per 100 Thai characters. An orphan gap is a space right after an upper vowel that always
  takes a final consonant (ั ึ ื ็, เ◌ิ), which is where a lost tone mark leaves a space (ตั ง, เริ ม).

Pages with fewer than 20 Thai characters are not judged.

| PDF page | Truth | hayro text | pdfium text |
|---|---|---|---|
| Owner brochure p1, p2 | broken | broken, broken | **ok, ok (missed)** |
| `broken-cmap` (tone marks removed from ToUnicode) | broken | broken | broken |
| `broken-invisible` (scanner-style hidden layer, marks → space) | broken | broken | broken |
| `chrome-print` (Chrome "Save as PDF", which drops shifted marks) | broken | broken | broken |
| `shaped-sara-am` (fpdf2 shaped sara am → U+FFFD) | broken | broken | broken |
| `good-text` p1 (Thai), p2 (mixed) | ok | ok, ok | ok, ok |
| `good-text-en` | not judged | not judged | not judged |
| `image-only` | no text → OCR | no text | no text |

**With hayro: precision 6/6, recall 6/6** on these 9 pages. With pdfium: recall 4/6. Two side findings matter for the
product. Chrome's own "Save as PDF" loses Thai tone marks in the text layer, so broken Thai PDFs are common, not rare.
And on a page judged broken, OCR read the owner's brochure at 1.0–3.6 % oCER, while hayro's text layer itself was
9.4 % and 3.2 % from the truth.

## Licences

| Component | Licence | Status |
|---|---|---|
| OpenThai 2.1 Text weights (`det.onnx` = PP-OCRv6 tiny as shipped; `rec`, `rec2` iApp fine-tunes) | Apache-2.0 (repo card, `NOTICE` names PaddlePaddle's Apache-2.0 work) | OK; ship `NOTICE` |
| iApp runtime (`runtime/*.py`) | Apache-2.0 (same repo) | Not ported: not needed |
| PaddleOCR `th_PP-OCRv5_mobile_rec_onnx`, `PP-OCRv5_mobile_det_onnx` | Apache-2.0 (official PaddlePaddle ONNX) | OK |
| `oar-ocr`, `oar-ocr-core` 0.10.3 | Apache-2.0 | OK |
| `ort` 2.0.0-rc.13, `ort-tract` 0.4.1, `tract-*` 0.23.10 | MIT OR Apache-2.0 | OK |
| ONNX Runtime library | MIT | OK |
| `hayro`, `hayro-interpret`, `vello_cpu` | Apache-2.0 OR MIT | OK |
| pdfium binaries (bblanchon) | MIT build scripts; pdfium BSD-3-Clause / Apache-2.0 with bundled third-party notices | OK; ship its notices |
| All 265 crates in the spike's tree | permissive (MIT, Apache-2.0, BSD, Zlib, ISC, Unicode, BSL-1.0, CDLA-Permissive-2.0); 2 dual-licensed with LGPL as one option | No blocker |

## Decision (proposed)

1. **Engine: ONNX Runtime**, loaded at run time (`ort` `load-dynamic`), as part of the module download. It is
   7–12× faster than tract, uses a third of the memory, and runs the models as published. tract is accurate, but
   Second opinion misses the p95 target on it (8.6 s), it needs patched detector models, and it needs a fixed
   square input.
2. **Intel Macs: build ONNX Runtime for `x86_64-apple-darwin` ourselves** (the owner's 2026-11-16 rule) in CI, from
   the same ONNX Runtime version, and sign it with the app. **Fallback if that build is not ready for 0.12.0: ship the
   tract engine for Intel Macs only.** It builds today and meets the Fast target (1.7 s p95). Second opinion is then
   slow there (p95 8.6 s), and the patched detectors become two more files in the model list.
3. **Both choices ship in 0.12.0.** Fast = OpenThai 2.1 Text (`oar-ocr` preset with `rec2`, 6.6 MB). Second opinion
   = PP-OCRv5 Thai (12.7 MB). Both meet the bar on screenshots, synthetic and PDF pages. Neither meets it on curved
   phone photos (one bottle label in the corpus), and Second opinion reads English and digit-heavy text slightly
   better than Fast, which justifies offering it.
4. **PDF: hayro**, compiled in, for both rendering and the text layer. It is pure Rust, so there is no extra native
   library to download and sign, it builds for Intel Macs, and it is the only one of the two whose text layer shows
   the owner's broken marks. pdfium renders the photo-heavy brochure faster (249 against 395 ms a page), which does not
   matter at Phase 2's page limits.
5. **Mac built-in (Vision) stays out of 0.12.0**, but deserves a decision. It lists `th-TH` here, and on the owner's
   files it is the most accurate engine overall (1.4 % oCER) and on Thai photos (2.2 %). On synthetic Thai it is level
   with Fast, and on PDF pages it is worse. It exists only on macOS, and Apple can change its language list. Offer it
   later as a third choice on Macs, "Mac built-in", if the owner wants it.
6. **The broken-text check ships as specified above**, run on hayro's text layer, page by page: use the text layer
   when it is ok, OCR when it is broken or empty.
7. **Pin `oar-ocr` =0.10.3, `ort` =2.0.0-rc.13**, and move together when oar-ocr and ort-tract (if kept for Intel)
   line up again.

## Decisions for the owner

- **Ship `thoth-ocr` in the module download** instead of the installer (plan §4 put it next to `thoth-mcp`). Measured,
  it would add 12.6–30 MB to every installer, against a 5 MB target. In the download, it updates only with the app.
- **Intel Macs:** our own ONNX Runtime build for x86_64 (Decision 2), or tract as the Intel-only fallback.
- **Mac built-in (Vision)** as a later third choice on Macs (Decision 5).
- **Read ten outputs next to their images** (exit criterion 3). The ten files whose ground truth to check are listed
  in the spike's private results folder, not here.

## Consequences

- `thoth-ocr` ships in the module download, not in the installer. Compressed, the download is the program
  (12.6 MB, 5.6 MB gzip) plus the ONNX Runtime library (35.3 MB, 9.8 MB gzip) per platform, plus the models
  (Fast 6.0 MB, Second opinion 11.8 MB gzip): about 21 MB for Fast and 27 MB for both. That is under the 50 MB
  limit, and the installer does not grow. Because the program is code,
  it updates only with the app (plan §5a), and the module list must give its version per app version.
- A downloaded library means the hardened-runtime question in plan §4 is real for ONNX Runtime once the app gets a
  Developer ID. The library is signed by us in CI.
- Reading order for two-column pages needs work in Phase 2 (or a newer oar-ocr), and so do curved photos (plan's
  2.2 dewarping branch, later).
- Peak memory of 0.5–0.9 GB per job is acceptable for one job at a time (plan §4 limits).

## What was not measured

- **Windows and Linux:** not built or run. CI must build both before Phase 1.
- **Intel Mac:** cross-compiled only, never run. Speed there is unknown and likely slower.
- **ONNX Runtime for x86_64 macOS from source:** not attempted.
- **A laptop other than an M4:** an M4 is a fast laptop; older or Intel laptops will be slower. The 3 s target has
  headroom on ORT (278 ms p95) but not much on tract.
- **The ten-output owner review:** not done; it needs the owner.
- **Handwriting and Typhoon OCR 2:** out of scope.
- **Installed size on disk per platform** and the final signed module archive.
- **Public images** (Thai Wikipedia screenshots, public-domain scans): not added. The synthetic set covers those
  conditions, but not real scanner noise.
- **Held-out set:** none. Nothing was tuned on the corpus; the models and presets ran as published.
