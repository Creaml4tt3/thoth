"""Run every engine on a set of images and PDFs; one JSONL per run, plus peak memory, in <out-dir>.

Usage (from tools/ocr-spike, after the builds in README):
  python3 -I scripts/bench.py <out-dir> <file or dir>...      # dirs: their png/jpg/pdf files
Runs: thoth-ocr (ONNX Runtime and tract) x (OpenThai 2.1, PP-OCRv5); Tesseract tha+eng; macOS Vision;
iApp's own Python runtime for OpenThai 2.1 (the reference). PDFs are rendered by hayro (and by pdfium for the
ONNX Runtime + OpenThai run) at 2x (144 dpi); the baselines read the same hayro renders.
Prints nothing from the files: text goes only into <out-dir>.
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
CACHE = Path.home() / "Library/Caches/thoth-ocr-spike"
M = CACHE / "models"
NATIVE = HERE / "target/release/thoth-ocr"
TRACT = HERE / "target/tract/release/thoth-ocr"
VISION = HERE / "target/vision_ocr"
PDFIUM = CACHE / "pdfium/arm64/lib/libpdfium.dylib"

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
files = []
for a in sys.argv[2:]:
    p = Path(a)
    files += sorted(x for x in p.iterdir() if x.suffix in (".png", ".jpg", ".pdf")) if p.is_dir() else [p]
images = [str(f) for f in files if f.suffix != ".pdf"]
pdfs = [str(f) for f in files if f.suffix == ".pdf"]

# Renders for the baselines, and render timing per renderer.
renders = out / "renders"
renders.mkdir(exist_ok=True)
page_pngs = []
for r in ("hayro", "pdfium"):
    if not pdfs:
        break
    (renders / r).mkdir(exist_ok=True)
    res = subprocess.run([str(NATIVE), "render", str(renders / r)] + pdfs, capture_output=True, text=True,
                         env={**os.environ, "THOTH_PDF": r, "PDFIUM_LIB": str(PDFIUM)})
    (out / f"render-{r}.jsonl").write_text(res.stdout)
    if res.returncode:
        print(f"render {r} failed: {res.stderr.strip()[:300]}")
    if r == "hayro":
        page_pngs = [json.loads(l)["png"] for l in res.stdout.splitlines()]


def peak_mb(stderr):
    m = re.search(r"(\d+)\s+maximum resident set size", stderr)
    return int(m[1]) / 1048576 if m else None


def run_thoth(name, binary, model, preset, items, env=None):
    env = {**os.environ, "PDFIUM_LIB": str(PDFIUM), **(env or {})}
    t = time.time()
    res = subprocess.run(["/usr/bin/time", "-l", str(binary), "ocr", str(M / model), preset,
                          str(out / f"{name}.jsonl")] + items, capture_output=True, text=True, env=env)
    err = res.stderr.strip().splitlines()
    meta = {"run": name, "rc": res.returncode, "peak_mb": peak_mb(res.stderr), "wall_s": time.time() - t,
            "error": next((l for l in err if l.startswith("error")), None)}
    print(json.dumps(meta))
    return meta


def run_tesseract(items):
    lines = []
    for f in items:
        t = time.time()
        r = subprocess.run(["tesseract", f, "stdout", "-l", "tha+eng", "--tessdata-dir", str(CACHE / "tessdata")],
                           capture_output=True, text=True)
        lines.append(json.dumps({"id": f, "ms": (time.time() - t) * 1000, "text": r.stdout}, ensure_ascii=False))
    (out / "tesseract.jsonl").write_text("\n".join(lines) + "\n")
    print(json.dumps({"run": "tesseract", "items": len(items)}))


def run_vision(items):
    r = subprocess.run([str(VISION)] + items, capture_output=True, text=True)
    (out / "vision.jsonl").write_text(r.stdout)
    print(json.dumps({"run": "vision", "rc": r.returncode, "items": len(r.stdout.splitlines())}))


def run_iapp(items):
    r = subprocess.run(["/usr/bin/time", "-l", "uv", "run", "--no-project", "-q", "--with", "onnxruntime",
                        "--with", "opencv-python-headless", "--with", "pyclipper", "--with", "numpy",
                        "python", "-I", str(HERE / "scripts/iapp_ref.py"), str(M / "openthai21"),
                        str(out / "iapp-python.jsonl")] + items, capture_output=True, text=True)
    print(json.dumps({"run": "iapp-python", "rc": r.returncode, "peak_mb": peak_mb(r.stderr),
                      "error": r.stderr.strip()[-300:] if r.returncode else None}))


meta = []
all_items = images + pdfs
square = {"THOTH_SQUARE": "1"}
meta.append(run_thoth("ort-openthai", NATIVE, "openthai21", "openthai", all_items))
meta.append(run_thoth("ort-openthai-pdfium", NATIVE, "openthai21", "openthai", pdfs, {"THOTH_PDF": "pdfium"})
            if pdfs else None)
meta.append(run_thoth("ort-pp5", NATIVE, "pp5", "pp5", all_items))
meta.append(run_thoth("ort-openthai-square", NATIVE, "openthai21", "openthai", all_items, square))
meta.append(run_thoth("tract-openthai", TRACT, "openthai21-tract", "openthai", all_items, square))
meta.append(run_thoth("ort-pp5-square", NATIVE, "pp5", "pp5-square", all_items, square))
meta.append(run_thoth("tract-pp5", TRACT, "pp5-tract", "pp5-square", all_items, square))
baseline_items = images + page_pngs
run_tesseract(baseline_items)
run_vision(baseline_items)
run_iapp(baseline_items)
(out / "runs.json").write_text(json.dumps([m for m in meta if m], indent=1))
