"""Speed and memory, run alone on a quiet machine: p50/p95 per image and per PDF page, cold start, peak memory.

Usage: python3 -I scripts/timing.py <bench-out-dir> [<bench-out-dir>...]
Reads the JSONL and runs.json that bench.py wrote; prints a Markdown table. Only numbers, never text.
"""
import json
import statistics
import sys
from pathlib import Path


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, round(p / 100 * (len(xs) - 1)))] if xs else float("nan")


rows = {}
for d in map(Path, sys.argv[1:]):
    meta = {m["run"]: m for m in json.loads((d / "runs.json").read_text())} if (d / "runs.json").exists() else {}
    for f in sorted(d.glob("*.jsonl")):
        if f.stem.startswith("render"):
            continue
        r = rows.setdefault(f.stem, {"img": [], "page": [], "render": [], "cold": [], "peak": []})
        for line in f.read_text().splitlines():
            o = json.loads(line)
            pdf_page = "#" in o["id"] or "/renders/" in o["id"]
            (r["page"] if pdf_page else r["img"]).append(o["ms"])
            if o.get("render_ms"):
                r["render"].append(o["render_ms"])
            if o.get("cold_ms") and o.get("first"):
                r["cold"].append(o["cold_ms"])
        if meta.get(f.stem, {}).get("peak_mb"):
            r["peak"].append(meta[f.stem]["peak_mb"])

print("| run | images | p50 ms | p95 ms | PDF pages | p50 ms | p95 ms | render ms/page | cold start ms | peak MB |")
print("|---|---|---|---|---|---|---|---|---|---|")
for k, r in rows.items():
    f = lambda xs: f"{xs:.0f}" if xs == xs else "-"
    print(f"| {k} | {len(r['img'])} | {f(pct(r['img'], 50))} | {f(pct(r['img'], 95))} | {len(r['page'])} | "
          f"{f(pct(r['page'], 50))} | {f(pct(r['page'], 95))} | "
          f"{f(statistics.median(r['render'])) if r['render'] else '-'} | "
          f"{f(max(r['cold'])) if r['cold'] else '-'} | {f(max(r['peak'])) if r['peak'] else '-'} |")
