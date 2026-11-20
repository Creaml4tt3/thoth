"""Score OCR outputs (JSONL from thoth-ocr, vision_ocr, tesseract or iapp_ref) against ground truth.

CER = Levenshtein distance / reference length, on the whole page text after the same normalisation for both
sides (plan §4):
  - NFC, then Thai marks after a base in one order (vowel, tone, nikhahit), sara am composed;
  - lines joined with the Thai rule: no space between two lines when both sides of the join are Thai, a space
    otherwise (the plan's wrapped-line rule, applied to every line so line breaks never count);
  - runs of whitespace become one space, and spaces next to Thai characters are kept (they are real in Thai);
  - straight and curly quotes unified, dashes unified (fonts and screenshots disagree on these; they are not
    what the spike measures).
Each item is scored once; a group's CER is the sum of distances over the sum of reference lengths.

Two numbers per item:
  CER   the whole page, in order (strict: a different reading order or extra text counts as errors);
  oCER  order-free: each ground-truth line is matched to its best substring of the output (Sellers' approximate
        substring alignment), distances summed. Reading order, layout and text the ground truth leaves out on
        purpose (status bars, app chrome) do not count; missing and wrong characters do.

Usage: python -I score.py <gt.json> <out.jsonl>... [--csv out.csv]
gt.json: {"items": {id: {"group", "lang", "lines": [...]}}} or the corpus manifest (a list with "id"/"lines").
"""
import json

import numpy as np
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

VOWELS = set("ัิีึืฺุู็")
TONES = set("่้๊๋์๎")
MARKS = VOWELS | TONES | {"ํ"}
MARK_RUN = re.compile("[" + "".join(sorted(MARKS)) + "]{2,}")
QUOTES = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'", "–": "-", "—": "-",
                        "−": "-", " ": " "})


def is_thai(c):
    return "฀" <= c <= "๿"


def norm(text):
    t = unicodedata.normalize("NFC", text or "").translate(QUOTES)
    t = MARK_RUN.sub(lambda m: "".join(sorted(m[0], key=lambda c: 0 if c in VOWELS else 1 if c in TONES else 2)), t)
    t = re.sub("ํ([่-๋]?)า", lambda m: m[1] + "ำ", t)
    t = re.sub("([่-๋])ํา", lambda m: m[1] + "ำ", t)
    lines = [re.sub(r"\s+", " ", l).strip() for l in t.replace("\r", "\n").split("\n")]
    out = ""
    for l in lines:
        if not l:
            continue
        if out:
            out += "" if is_thai(out[-1]) and is_thai(l[0]) else " "
        out += l
    return out


def lev(a, b):
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def substring_dist(ref, hyp_codes):
    """Smallest edit distance between ref and any substring of hyp (free start and end in hyp)."""
    n = len(hyp_codes)
    idx = np.arange(n + 1)
    prev = np.zeros(n + 1, dtype=np.int64)
    for i, c in enumerate(ref, 1):
        sub = prev[:-1] + (hyp_codes != ord(c))
        base = np.empty(n + 1, dtype=np.int64)
        base[0] = i
        base[1:] = np.minimum(prev[1:] + 1, sub)
        prev = np.minimum.accumulate(base - idx) + idx  # insertions along hyp
    return int(prev.min())


def order_free(lines, hyp):
    codes = np.array([ord(c) for c in hyp], dtype=np.int64)
    refs = [norm(l) for l in lines]
    return sum(substring_dist(r, codes) for r in refs if r), sum(len(r) for r in refs)


def load_gt(path):
    d = json.loads(Path(path).read_text())
    if isinstance(d, list):
        return {x["id"]: x for x in d}
    return d["items"]


def key_of(out_id, gt):
    """Match an output id (a path, maybe with #page) to a ground-truth id."""
    name = out_id.split("/")[-1]
    stem, _, page = name.partition("#")
    for cand in (name, stem, re.sub(r"\.(png|jpg)$", "", stem) + (f"#{page}" if page else "")):
        if cand in gt:
            return cand
    stem2 = re.sub(r"\.(png|jpg)$", "", stem)
    if stem2 in gt:
        return stem2
    m = re.match(r"(.+)-(\d+)$", stem2)  # rendered PDF page png: <pdf stem>-<page>
    if m and f"{m[1]}.pdf#{m[2]}" in gt:
        return f"{m[1]}.pdf#{m[2]}"
    return None


def main():
    args = sys.argv[1:]
    csv = None
    if "--csv" in args:
        i = args.index("--csv")
        csv = args[i + 1]
        del args[i:i + 2]
    gt = load_gt(args[0])
    rows = []
    for f in args[1:]:
        for line in Path(f).read_text().splitlines():
            o = json.loads(line)
            k = key_of(o["id"], gt)
            if k is None:
                continue
            g = gt[k]
            ref, hyp = norm("\n".join(g["lines"])), norm(o.get("text", ""))
            od, on = order_free(g["lines"], hyp)
            rows.append({"run": Path(f).stem, "id": k, "group": g["group"], "lang": g.get("lang", "?"),
                         "dist": lev(ref, hyp), "n": len(ref), "odist": od, "on": on, "ms": o.get("ms"),
                         "cold_ms": o.get("cold_ms")})
    if csv:
        Path(csv).write_text("run,id,group,lang,dist,n,cer,ocer,ms\n" + "".join(
            f'{r["run"]},{r["id"]},{r["group"]},{r["lang"]},{r["dist"]},{r["n"]},{r["dist"] / max(r["n"], 1):.4f},'
            f'{r["odist"] / max(r["on"], 1):.4f},{r["ms"] or ""}\n' for r in rows))
    agg = defaultdict(lambda: [0, 0, 0, 0, 0])
    for r in rows:
        for key in ((r["run"], r["group"], "all"), (r["run"], r["group"], r["lang"]), (r["run"], "ALL", r["lang"]),
                    (r["run"], "ALL", "all")):
            a = agg[key]
            a[0] += r["dist"]
            a[1] += r["n"]
            a[2] += 1
            a[3] += r["odist"]
            a[4] += r["on"]
    for (run, group, lang), (d, n, c, od, on) in sorted(agg.items()):
        print(f"{run:28s} {group:20s} {lang:6s} items={c:3d} CER={100 * d / max(n, 1):6.2f}% "
              f"oCER={100 * od / max(on, 1):6.2f}%")


def _selftest():
    assert norm("ตั้ง\nใจ") == "ตั้งใจ" and norm("a\nb") == "a b" and norm("\u0e19\u0e49\u0e4d\u0e32") == "น้ำ"
    assert substring_dist("abc", np.array([ord(c) for c in "xxabcxx"])) == 0
    assert substring_dist("abc", np.array([ord(c) for c in "xxabxx"])) == 1
    assert order_free(["two", "one"], "one two") == (0, 6)


if __name__ == "__main__":
    _selftest()
    main()
