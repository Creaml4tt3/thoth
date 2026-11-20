#!/usr/bin/env bash
# Stages the model files and the test image for release-ocr.yml under <out>/modules/, each checked against the SHA-256
# in tools/ocr-spike/models.lock (the Phase 0 measurements were made on exactly these files). Run from the repo root.
#   models/fast/<v>/   OpenThai 2.1 Text (iapp, Apache-2.0), and det.tract1280.onnx for Intel Macs (ADR-0055 Decision 2)
#   models/second/<v>/ PP-OCRv5 mobile det + th_PP-OCRv5_mobile_rec (PaddlePaddle, Apache-2.0), dict.txt from its yml,
#                      and det.tract960.onnx for Intel Macs
#   test/1/ocr-test.png
set -euo pipefail
out="$1"
lock=tools/ocr-spike/models.lock
hf=https://huggingface.co
fast="$out/modules/models/fast/openthai-2.1-20261118"
second="$out/modules/models/second/pp-ocrv5-th-20250821"
mkdir -p "$fast" "$second" "$out/modules/test/1"

# The SHA-256 models.lock gives for a path (relative to the spike's cache), or a stop.
want() { awk -v p="$2" '$2 == p { print $1 }' "$lock" | grep . || { echo "::error::$2 is not in $lock"; exit 1; }; }
check() { echo "$(want "$lock" "$2")  $1" | shasum -a 256 -c -; }
get() { curl -fsSL --retry 3 -o "$1" "$hf/$2"; check "$1" "$3"; }

ot=iapp/OpenThai2.1-OCR-Text-20261118/resolve/c765cb8017c406ddc2a518de51db22bb2e2bbd07
for f in det.onnx rec.onnx rec2.onnx rec_dict.txt config.json NOTICE; do get "$fast/$f" "$ot/$f" "models/openthai21/$f"; done
get "$second/rec.onnx" PaddlePaddle/th_PP-OCRv5_mobile_rec_onnx/resolve/1d4adbbafb1034a2fd6618498575b81ea7b69f69/inference.onnx models/pp5th/inference.onnx
get "$out/inference.yml" PaddlePaddle/th_PP-OCRv5_mobile_rec_onnx/resolve/1d4adbbafb1034a2fd6618498575b81ea7b69f69/inference.yml models/pp5th/inference.yml
get "$second/det.onnx" PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/e6f4fa85f00e168c862bc462aebca69eef9b3d3d/inference.onnx models/pp5det/inference.onnx

py() { uv run --no-project --with onnx==1.19.1 --with onnxruntime==1.23.2 --with pyyaml==6.0.3 python -I "$@"; }
# dict.txt: the yml's PostProcess.character_dict, one per line.
py -c 'import sys,yaml; d=yaml.safe_load(open(sys.argv[1],encoding="utf-8"))["PostProcess"]["character_dict"]; open(sys.argv[2],"w",encoding="utf-8",newline="\n").write("\n".join(d)+"\n")' "$out/inference.yml" "$second/dict.txt"
check "$second/dict.txt" models/pp5/dict.txt
rm "$out/inference.yml"

# Intel Mac detectors: tract_patch.py, then the input pinned to a square (reproduces models.lock byte for byte).
pin='import sys,onnx
m=onnx.load(sys.argv[1]); n=int(sys.argv[3])
for d,v in zip(m.graph.input[0].type.tensor_type.shape.dim,[1,3,n,n]): d.Clear(); d.dim_value=v
onnx.save(m,sys.argv[2])'
py tools/ocr-spike/scripts/tract_patch.py "$fast/det.onnx" "$out/ot.onnx"
py -c "$pin" "$out/ot.onnx" "$fast/det.tract1280.onnx" 1280
check "$fast/det.tract1280.onnx" models/openthai21/det.tract1280.onnx
py tools/ocr-spike/scripts/tract_patch.py "$second/det.onnx" "$out/pp.onnx"
py -c "$pin" "$out/pp.onnx" "$second/det.tract960.onnx" 960
check "$second/det.tract960.onnx" models/pp5det/inference.tract960.onnx
rm "$out/ot.onnx" "$out/pp.onnx"

cp modules/ocr-test.png "$out/modules/test/1/ocr-test.png"
