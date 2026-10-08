import json, glob, sys, math
from collections import defaultdict
rows = [json.loads(l) for f in glob.glob(sys.argv[1] + "/**/agree_*.jsonl", recursive=True) for l in open(f) if l.strip()]
by = defaultdict(list)
for r in rows: by[r["power"]].append(r)
def pct(k, n): return f"{100*k/max(1,n):5.1f}%"
print(f"{len(rows)} sampled decisions")
print(f"{'power':7} {'n':>5} {'base=base2':>11} {'cand=base':>10} {'base=ref':>9} {'cand=ref':>9} | disagreements: {'n':>4} {'base=ref':>9} {'cand=ref':>9}  (Δ ± se)")
for p in ["xarm", "gormen", "tenzen", "lasha"]:
    rs = by[p]; n = len(rs)
    if not n: continue
    bb = sum(r["base"] == r["base2"] for r in rs); cb = sum(r["cand"] == r["base"] for r in rs)
    br = sum(r["base"] == r["ref"] for r in rs); cr = sum(r["cand"] == r["ref"] for r in rs)
    d = [r for r in rs if r["cand"] != r["base"]]
    dbr = sum(r["base"] == r["ref"] for r in d); dcr = sum(r["cand"] == r["ref"] for r in d)
    # paired difference on disagreements: +1 cand matches ref, -1 base matches ref
    diffs = [(r["cand"] == r["ref"]) - (r["base"] == r["ref"]) for r in d]
    m = sum(diffs) / max(1, len(diffs)); se = math.sqrt(sum((x - m) ** 2 for x in diffs) / max(1, len(diffs) - 1) / max(1, len(diffs)))
    print(f"{p:7} {n:5d} {pct(bb,n):>11} {pct(cb,n):>10} {pct(br,n):>9} {pct(cr,n):>9} | {len(d):17d} {pct(dbr,len(d)):>9} {pct(dcr,len(d)):>9}  ({m:+.3f} ± {se:.3f})")
