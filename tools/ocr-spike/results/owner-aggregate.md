# Owner's files: aggregate results only (2026-11-19)

19 items from the owner's private test folder: 14 screenshots, 3 phone photos, 1 PDF of 2 pages. The files,
their ground truth and all outputs stay outside the repo. Only the numbers below are committed. Ground truth was
transcribed by hand from the images, and ten files are marked for the owner to check. Text that the ground truth
leaves out on purpose (status bars, logos, thumbnails, partly hidden lines) shows up as extra output. That is why
strict CER is high everywhere, and why **oCER (order-free) is the number to read**. Cells: oCER (CER), percent.

## Accuracy

| group | lang | n | ort-openthai | tract-openthai | ort-pp5 | tract-pp5 | iapp-python | tesseract | vision |
|---|---|---|---|---|---|---|---|---|---|
| ALL | all | 19 | 3.12 (18.96) | 3.02 (18.71) | 7.09 (31.43) | 6.68 (29.39) | 2.98 (19.09) | 16.22 (39.05) | 1.40 (24.32) |
| ALL | mixed | 12 | 0.98 (20.52) | 1.03 (19.86) | 6.22 (36.05) | 5.14 (32.85) | 0.91 (20.81) | 10.58 (38.17) | 1.25 (30.04) |
| ALL | th | 7 | 8.87 (14.73) | 8.35 (15.58) | 9.42 (18.82) | 10.79 (19.97) | 8.49 (14.40) | 31.31 (41.47) | 1.82 (8.72) |
| pdf | all | 2 | 2.30 (42.28) | 2.30 (42.22) | 1.36 (44.19) | 1.71 (45.03) | 2.01 (42.45) | 15.00 (45.99) | 0.47 (44.41) |
| pdf | mixed | 2 | 2.30 (42.28) | 2.30 (42.22) | 1.36 (44.19) | 1.71 (45.03) | 2.01 (42.45) | 15.00 (45.99) | 0.47 (44.41) |
| photo | all | 3 | 16.00 (22.93) | 15.46 (23.13) | 17.62 (42.50) | 21.00 (42.04) | 15.33 (22.21) | 67.32 (75.02) | 2.50 (34.30) |
| photo | mixed | 1 | 1.85 (29.96) | 3.24 (28.63) | 10.19 (150.66) | 8.80 (123.79) | 2.31 (30.40) | 77.31 (86.78) | 4.17 (208.37) |
| photo | th | 2 | 18.42 (21.70) | 17.55 (22.16) | 18.89 (23.41) | 23.08 (27.60) | 17.55 (20.76) | 65.61 (72.94) | 2.21 (3.58) |
| screenshot | all | 14 | 0.77 (12.82) | 0.73 (12.43) | 6.31 (26.32) | 4.98 (23.32) | 0.76 (13.10) | 6.43 (30.42) | 1.40 (17.73) |
| screenshot | mixed | 9 | 0.56 (13.76) | 0.58 (12.96) | 7.48 (29.36) | 6.00 (25.86) | 0.55 (14.09) | 6.85 (34.05) | 1.36 (19.13) |
| screenshot | th | 5 | 1.52 (9.38) | 1.28 (10.52) | 2.13 (15.30) | 1.34 (14.11) | 1.52 (9.50) | 4.92 (17.27) | 1.52 (12.67) |

Notes:
- **Thai phone photos (2):** one is a skewed photo of a printed letter (all engines but Tesseract ≈ 0.5 %), the other
  a curved bottle label. On the label, OpenThai and PP-OCRv5 both miss 7 of 30 lines entirely (≈ 29 %), and macOS
  Vision misses none (3.3 %). Curved and small text on a bottle is the weak spot.
- **The PDF** is a 2-page A5 brochure of designed type (prices, tables) whose text layer is broken. OCR reads it at
  1–3.6 % oCER per page.

## Speed (warm)

| run | images | p50 ms | p95 ms | PDF pages | p50 ms | p95 ms | render ms/page | cold start ms | peak MB |
|---|---|---|---|---|---|---|---|---|---|
| iapp-python | 17 | 402 | 753 | 2 | 591 | 685 | - | - | - |
| ort-openthai-pdfium | 0 | - | - | 2 | 201 | 241 | 246 | 140 | 489 |
| ort-openthai-square | 17 | 180 | 359 | 2 | 228 | 248 | 391 | 137 | 945 |
| ort-openthai | 17 | 160 | 297 | 2 | 243 | 255 | 390 | 163 | 857 |
| ort-pp5-square | 17 | 285 | 854 | 2 | 555 | 752 | 393 | 180 | 791 |
| ort-pp5 | 17 | 332 | 732 | 2 | 501 | 724 | 394 | 140 | 623 |
| tesseract | 17 | 694 | 2235 | 2 | 1174 | 1361 | - | - | - |
| tract-openthai | 17 | 1145 | 2042 | 2 | 1410 | 1515 | 389 | 870 | 1979 |
| tract-pp5 | 17 | 3129 | 8631 | 2 | 6688 | 9168 | 384 | 613 | 1587 |
| vision | 17 | 374 | 870 | 2 | 699 | 712 | - | - | - |

Owner screenshots only (14 images, up to 2064×4556): p50 / p95 / max ms: ONNX Runtime + OpenThai 145 / 278 / 417;
tract + OpenThai 1093 / 1675 / 2304; ONNX Runtime + PP-OCRv5 245 / 732 / 1154; tract + PP-OCRv5 2897 / 8631 / 14375;
Tesseract 694 / 2235 / 4934; Vision 334 / 870 / 1418; iApp Python (1 thread) 375 / 753 / 993.

PDF rendering of the owner's brochure (2 pages, full-bleed photo background) at 144 dpi: hayro 395 ms/page, pdfium
249 ms/page.
