# Synthetic corpus results (2026-11-19, Apple M4, 10 cores, 16 GB, macOS 15.8.3, CPU only)

39 items from `corpus/` (`scripts/gen_corpus.py`): 14 clean, 2 two-column, 15 degraded images and 8 PDF pages.
Each cell is **oCER (CER)** in percent; lower is better.
- **oCER** (order-free): each ground-truth line is matched to its best place in the output. Missing and wrong
  characters count; reading order does not.
- **CER** (strict): the whole page in order. Reading order counts.

Both are computed after the plan's §4 Thai line-joining rule and NFC (`scripts/score.py`).

Runs: `ort-*` = thoth-ocr on ONNX Runtime (oar-ocr 0.10.3), `tract-*` = thoth-ocr on tract (pure Rust; detector
rewritten by `tract_patch.py`, input padded to a square), `openthai` = OpenThai 2.1 Text (oar-ocr's v2.1 preset,
with `rec2`), `pp5` = PP-OCRv5 mobile det + `th_PP-OCRv5_mobile_rec`, `iapp-python` = iApp's own runtime (the
reference), `tesseract` = Tesseract 5.5.4 `tha+eng` (tessdata_best), `vision` = macOS Vision (`th-TH`, `en-US`,
accurate). PDF pages are rendered by hayro at 144 dpi for every run.

## Accuracy

| group | lang | n | ort-openthai | tract-openthai | ort-pp5 | tract-pp5 | iapp-python | tesseract | vision |
|---|---|---|---|---|---|---|---|---|---|
| ALL | all | 39 | 5.20 (7.53) | 5.06 (7.43) | 5.46 (8.00) | 5.95 (8.56) | 5.21 (7.53) | 2.16 (4.43) | 4.79 (7.99) |
| ALL | en | 8 | 1.26 (1.24) | 0.67 (0.66) | 0.15 (0.15) | 0.11 (0.11) | 1.26 (1.24) | 0.41 (0.40) | 0.26 (0.26) |
| ALL | mixed | 10 | 7.60 (12.55) | 7.53 (12.61) | 7.13 (12.18) | 7.06 (12.02) | 7.60 (12.55) | 4.50 (4.81) | 6.70 (11.72) |
| ALL | th | 21 | 5.60 (7.76) | 5.58 (7.76) | 6.57 (9.04) | 7.41 (10.07) | 5.62 (7.77) | 1.89 (5.60) | 5.56 (9.16) |
| pdf | all | 8 | 1.17 (1.16) | 1.17 (1.16) | 0.93 (1.21) | 1.19 (1.23) | 1.24 (1.23) | 1.59 (5.76) | 2.89 (3.55) |
| pdf | en | 1 | 0.52 (0.51) | 0.52 (0.51) | 0.00 (0.00) | 0.00 (0.00) | 0.52 (0.51) | 0.17 (0.17) | 0.00 (0.00) |
| pdf | mixed | 1 | 1.89 (1.87) | 1.68 (1.66) | 0.63 (0.62) | 1.26 (1.24) | 2.11 (2.07) | 2.11 (2.28) | 0.21 (0.21) |
| pdf | th | 6 | 1.18 (1.18) | 1.21 (1.21) | 1.14 (1.52) | 1.39 (1.45) | 1.24 (1.24) | 1.76 (7.30) | 3.80 (4.70) |
| synthetic-clean | all | 14 | 0.82 (0.86) | 0.46 (0.50) | 2.01 (2.50) | 2.63 (3.29) | 0.82 (0.86) | 1.44 (2.70) | 0.18 (0.20) |
| synthetic-clean | en | 4 | 1.83 (1.80) | 0.66 (0.65) | 0.25 (0.24) | 0.17 (0.16) | 1.83 (1.80) | 0.08 (0.08) | 0.17 (0.16) |
| synthetic-clean | mixed | 4 | 1.47 (1.66) | 1.26 (1.45) | 0.84 (0.83) | 0.63 (0.62) | 1.47 (1.66) | 4.21 (4.36) | 0.32 (0.42) |
| synthetic-clean | th | 6 | 0.00 (0.00) | 0.00 (0.00) | 3.48 (4.47) | 4.83 (6.19) | 0.00 (0.00) | 0.99 (3.43) | 0.14 (0.14) |
| synthetic-columns | all | 2 | 43.69 (66.53) | 43.48 (66.67) | 43.55 (66.04) | 43.27 (66.11) | 43.69 (66.53) | 3.26 (5.74) | 36.69 (66.18) |
| synthetic-columns | mixed | 1 | 32.10 (55.98) | 31.94 (56.30) | 31.62 (55.82) | 31.46 (55.66) | 32.10 (55.98) | 1.93 (1.91) | 30.98 (55.34) |
| synthetic-columns | th | 1 | 52.50 (74.60) | 52.26 (74.60) | 52.63 (73.87) | 52.26 (74.11) | 52.50 (74.60) | 4.27 (8.67) | 41.03 (74.48) |
| synthetic-degraded | all | 15 | 0.43 (0.42) | 0.40 (0.42) | 0.35 (0.42) | 1.20 (1.49) | 0.38 (0.37) | 3.18 (4.43) | 0.35 (0.35) |
| synthetic-degraded | en | 3 | 1.00 (0.98) | 0.78 (0.76) | 0.11 (0.11) | 0.11 (0.11) | 1.00 (0.98) | 1.00 (0.98) | 0.55 (0.55) |
| synthetic-degraded | mixed | 4 | 0.53 (0.52) | 0.74 (0.83) | 0.63 (0.93) | 0.42 (0.41) | 0.42 (0.41) | 7.67 (8.39) | 0.42 (0.41) |
| synthetic-degraded | th | 8 | 0.14 (0.14) | 0.09 (0.09) | 0.33 (0.33) | 2.01 (2.57) | 0.09 (0.09) | 2.10 (4.12) | 0.23 (0.23) |

The two-column pages: every engine except Tesseract reads them row by row across both columns. That includes iApp's
runtime, whose column logic did not separate a 90 px gutter; it did separate a 260 px one in a side test. This is a
reading-order problem, not a recognition one (oCER is still ~43 % because Thai lines cut mid-word at the gutter no
longer match their ground-truth lines).

## Speed and memory (warm, one process, all cores)

| run | images | p50 ms | p95 ms | PDF pages | p50 ms | p95 ms | render ms/page | cold start ms | peak MB |
|---|---|---|---|---|---|---|---|---|---|
| iapp-python | 31 | 156 | 345 | 8 | 396 | 515 | - | - | - |
| ort-openthai-pdfium | 0 | - | - | 8 | 223 | 279 | 5 | 238 | 492 |
| ort-openthai-square | 31 | 236 | 459 | 8 | 272 | 326 | 4 | 265 | 662 |
| ort-openthai | 31 | 118 | 247 | 8 | 248 | 338 | 4 | 243 | 534 |
| ort-pp5-square | 31 | 334 | 616 | 8 | 489 | 630 | 5 | 303 | 526 |
| ort-pp5 | 31 | 236 | 543 | 8 | 493 | 707 | 4 | 235 | 460 |
| tesseract | 31 | 427 | 1306 | 8 | 737 | 1211 | - | - | - |
| tract-openthai | 31 | 1644 | 3174 | 8 | 1944 | 2146 | 6 | 1526 | 2251 |
| tract-pp5 | 31 | 3132 | 6127 | 8 | 4849 | 9156 | 5 | 1163 | 1462 |
| vision | 31 | 193 | 523 | 8 | 358 | 447 | - | - | - |

Cold start = model load + first inference on a blank 1280² page. Peak MB = maximum resident set of the whole run.
`*-square` = the padded-square input that the tract detector needs, run on ONNX Runtime for comparison.
