# thoth-ocr

The OCR program of Thoth's OCR module ([ADR-0055](../../docs/adr/0055-ocr-module.md)). It is not in the installer:
the app downloads it, with ONNX Runtime and the models, when a person clicks Download in Settings → Modules.
`.github/workflows/release-ocr.yml` builds and uploads it.

It has its own Cargo workspace, so `cargo` commands take `--manifest-path crates/thoth-ocr/Cargo.toml`.

## Protocol 1

The host starts one process per job:

```
ORT_DYLIB_PATH=<libonnxruntime> thoth-ocr serve --models <dir> --preset openthai|pp5
```

- stdin: one JSON line, `{"op":"image","len":N}` or `{"op":"pdf","len":N,"maxPages":M}`, then exactly N bytes.
  Images are PNG or JPEG, up to 20 MB and 40 megapixels; PDFs up to 50 MB.
- stdout, one JSON line each: `{"page":i,"pages":n,"source":"ocr"|"text","text":"…"}` per page, then
  `{"done":true}`. A PDF page uses its own text when `textcheck` finds it good, otherwise it is rendered at scale 2.0
  and read by OCR. Text is NFC, one line per row.
- On failure: one `{"error":"too-large"|"bad-image"|"bad-pdf"|"bad-request"|"failed","message":"…"}` and exit
  code 1. Messages never contain document text.

`thoth-ocr --version` prints `thoth-ocr <version> protocol 1`.

Presets: `openthai` = OpenThai 2.1 Text (`det.onnx`, `rec.onnx`, `rec2.onnx`, `rec_dict.txt`, `config.json`);
`pp5` = PP-OCRv5 mobile detection + `th_PP-OCRv5_mobile_rec` (`det.onnx`, `rec.onnx`, `dict.txt`).

## Tests

```
cargo test --manifest-path crates/thoth-ocr/Cargo.toml
```

`tests/serve.rs` runs the program on `tools/ocr-spike/corpus` only when `THOTH_OCR_MODELS` (a folder holding
`openthai/` and `pp5/`) and `ORT_DYLIB_PATH` (ONNX Runtime 1.28.0) are set; otherwise it skips.
