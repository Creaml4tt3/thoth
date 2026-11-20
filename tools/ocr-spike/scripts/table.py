"""Pivot score.py output into a group x run table of "oCER (CER)", in percent. Usage: python -I table.py summary.txt [run...]"""
import re
import sys
from collections import defaultdict

t, order = defaultdict(dict), []
for line in open(sys.argv[1]):
    m = re.match(r"(\S+)\s+(\S+)\s+(\S+)\s+items=\s*(\d+)\s+CER=\s*([\d.]+)%\s+oCER=\s*([\d.]+)%", line)
    if m:
        run, group, lang, n, cer, ocer = m.groups()
        t[(group, lang, n)][run] = f"{ocer} ({cer})"
        order += [run] if run not in order else []
runs = sys.argv[2:] or order
print("| group | lang | n | " + " | ".join(runs) + " |")
print("|---|---|---|" + "---|" * len(runs))
for k in sorted(t, key=lambda k: (k[0] != "ALL", k[0], k[1] != "all", k[1])):
    print(f"| {k[0]} | {k[1]} | {k[2]} | " + " | ".join(t[k].get(r, "-") for r in runs) + " |")
