"""Reference output: iApp's own Python runtime (runtime/line_engine.py, Apache-2.0) for OpenThai 2.1, one thread,
ONNX Runtime. Usage: python -I iapp_ref.py <model-dir> <out.jsonl> <image>...
"""
import json
import sys
import time

model_dir, out, images = sys.argv[1], sys.argv[2], sys.argv[3:]
sys.path.insert(0, model_dir)
from runtime.line_engine import LineOCR  # noqa: E402

t = time.time()
ocr = LineOCR(model_dir, threads=1)
load_ms = (time.time() - t) * 1000
with open(out, "w") as f:
    for p in images:
        t = time.time()
        r = ocr.read(p)
        f.write(json.dumps({"id": p, "ms": (time.time() - t) * 1000, "load_ms": load_ms, "text": r["text"]},
                           ensure_ascii=False) + "\n")
