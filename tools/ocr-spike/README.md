# OCR spike (Phase 0)

A throwaway measurement harness for [the OCR plan](../../docs/architecture/ocr-plan.md) §6. It is a standalone Cargo
project, not part of the main workspace, so CI never builds it. Results and the decision are in
[ADR-0055](../../docs/adr/0055-ocr-module.md); the measured tables are in [`results/`](results/).

Nothing here is product code. The binary is called `thoth-ocr` because it is the shape the product's program would
have: one Rust binary on [`oar-ocr`](https://crates.io/crates/oar-ocr) 0.10.3, with the engine chosen at build time.

## What is here

| Path | What |
|---|---|
| `src/main.rs` | `thoth-ocr ocr` (images and PDFs to JSONL), `pdftext` (a PDF's text layer + broken-text verdict), `render` (PDF pages to PNG), `probe` (does the engine load a model?) |
| `src/textcheck.rs` | The broken-Thai-text-layer check, with unit tests |
| `src/pdf.rs` | PDF rendering (hayro or pdfium) and text-layer extraction |
| `scripts/gen_corpus.py` | Generates `corpus/` (39 items: images, PDFs, exact ground truth) |
| `scripts/tract_patch.py` | Rewrites the two detectors' `Resize`/`ConvTranspose` into ops tract can analyse; checks equality on ONNX Runtime |
| `scripts/bench.py` | Runs every engine and baseline on a folder; writes JSONL into the folder you name |
| `scripts/score.py`, `table.py`, `timing.py` | CER (strict and order-free), tables, speed |
| `scripts/vision_ocr.swift`, `iapp_ref.py` | macOS Vision baseline; iApp's own Python runtime as the reference |
| `models.lock` | SHA-256 of every downloaded file |
| `corpus/` | The synthetic corpus (OFL fonts, original text) |
| `results/` | Scores and timing for the synthetic corpus, and aggregate-only numbers for the owner's files |

## Rerun

Downloads go to `~/Library/Caches/thoth-ocr-spike/` (never the repo). Check them against `models.lock`:
`(cd ~/Library/Caches/thoth-ocr-spike && grep -v '^#' <repo>/tools/ocr-spike/models.lock | shasum -a 256 -c)`.

1. **Models** (Hugging Face, at the revisions in `models.lock`): OpenThai 2.1 Text into `models/openthai21/`
   (`det.onnx rec.onnx rec2.onnx rec_dict.txt config.json NOTICE runtime/*`), the PP-OCRv5 Thai recognizer into
   `models/pp5th/`, PP-OCRv5 mobile detection into `models/pp5det/`. Then:
   - `models/pp5/`: `det.onnx -> ../pp5det/inference.onnx`, `rec.onnx -> ../pp5th/inference.onnx`, and `dict.txt` =
     the `PostProcess.character_dict` list of `pp5th/inference.yml`, one per line.
   - tract detectors: `uv run --no-project --with onnx --with onnxruntime python -I scripts/tract_patch.py <in> <out>`
     for both detectors, then pin the input to a square (1280 for OpenThai, 960 for PP-OCRv5) with `onnx`; link them
     as `det.onnx` in `models/openthai21-tract/` and `models/pp5-tract/` next to the unchanged recognizers.
2. **Fonts** (`fonts/`, google/fonts `ofl/`), **pdfium** (`pdfium/`, bblanchon chromium/8125, macOS arm64) and
   **Tesseract** (`brew install tesseract`; `tessdata/` from tessdata_best).
3. **Build:**
   ```sh
   cargo build --release --features pdfium                                                    # ONNX Runtime
   cargo build --release --no-default-features --features tract,pdfium --target-dir target/tract   # pure Rust
   swiftc -O scripts/vision_ocr.swift -o target/vision_ocr
   cargo test --release                                                                       # textcheck
   ```
4. **Corpus:** `uv run --no-project --with pillow --with numpy --with fpdf2 --with uharfbuzz python -I scripts/gen_corpus.py`
   (needs Google Chrome for rendering).
5. **Run and score:**
   ```sh
   python3 -I scripts/bench.py results/synthetic corpus/img corpus/pdf
   (cd results/synthetic && python3 -I ../../scripts/score.py ../../corpus/manifest.json *.jsonl --csv per-item.csv > summary.txt)
   python3 -I scripts/table.py results/synthetic/summary.txt
   python3 -I scripts/timing.py results/synthetic
   ```
   For private files, give `bench.py` an output folder **outside the repo** and score against a ground-truth JSON
   kept there too (`{"items": {"<file name>": {"group", "lang", "lines": [...]}}}`).

## Rules for private test files

The owner's test images are private. They, their ground truth and every output that contains their text stay outside
the repo, in a folder of the owner's choosing. Only aggregate numbers are committed (`results/owner-aggregate.md`).
