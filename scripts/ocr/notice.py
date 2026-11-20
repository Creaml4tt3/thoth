"""Writes the OCR program's NOTICE.txt: the licence texts of every crate built into thoth-ocr for a target, then the
files given after it (ONNX Runtime's LICENSE and ThirdPartyNotices.txt). Apache-2.0 and MIT require the notice to travel
with the copy; this file goes into the module download next to the program.

Usage: python3 -I scripts/ocr/notice.py <target> <out> [extra files...]   (run from the repo root)
"""
import json
import os
import re
import subprocess
import sys

target, out, extra = sys.argv[1], sys.argv[2], sys.argv[3:]
features = ["--features", "tract"] if target == "x86_64-apple-darwin" else []
meta = json.loads(subprocess.check_output(
    ["cargo", "metadata", "--manifest-path", "crates/thoth-ocr/Cargo.toml", "--format-version", "1", "--locked",
     "--filter-platform", target, *features]))
# Only crates in the resolved graph for this target (cargo metadata lists every package of the lock otherwise).
nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
seen, todo = set(), [meta["resolve"]["root"]]
while todo:
    pid = todo.pop()
    if pid in seen:
        continue
    seen.add(pid)
    todo += [d["pkg"] for d in nodes[pid]["deps"] if any(k["kind"] in (None, "build") for k in d["dep_kinds"])]
lic = re.compile(r"^(licen[sc]e|copying|notice)([-_.][\w.-]*)?$", re.I)
parts = ["thoth-ocr, part of Thoth's OCR module (https://github.com/Creaml4tt3/thoth), is Apache-2.0.\n"
         "It is built from the Rust crates below, each under its own licence, and loads the ONNX Runtime library.\n"]
for p in sorted((p for p in meta["packages"] if p["id"] in seen and p["source"]), key=lambda p: (p["name"], p["version"])):
    d = os.path.dirname(p["manifest_path"])
    files = sorted(f for f in os.listdir(d) if lic.match(f))
    parts.append(f"\n{'=' * 78}\n{p['name']} {p['version']} ({p.get('license') or 'see below'})\n{'=' * 78}\n")
    for f in files:
        parts.append(open(os.path.join(d, f), encoding="utf-8", errors="replace").read().rstrip() + "\n")
    if not files:
        parts.append(f"No licence file in the crate; its declared licence is {p.get('license')}. Source: {p.get('repository') or 'crates.io'}\n")
for f in extra:
    parts.append(f"\n{'=' * 78}\n{os.path.basename(f)} (ONNX Runtime)\n{'=' * 78}\n")
    parts.append(open(f, encoding="utf-8", errors="replace").read().rstrip() + "\n")
open(out, "w", encoding="utf-8", newline="\n").write("".join(parts))
print(f"{out}: {len(seen) - 1} crates")
