"""Paired-seed analysis: each arm modifies one power (arm name ends in _<power>);
compare that power's outcomes against the 'base' arm on the same seeds."""
import json, math, os, sys, glob
D = sys.argv[1]
P = ["xarm", "gormen", "tenzen", "lasha"]


def load(f):
    out = {}
    for l in open(f):
        try:
            g = json.loads(l)
        except Exception:
            continue
        out[g["seed"]] = g
    return out


arms = {os.path.basename(f)[:-6]: load(f) for f in glob.glob(f"{D}/*.jsonl")}
base = arms.pop("base", {})
won = lambda g, p: p in (g["winners"] or [])
print(f"base n={len(base)}  win: " + " ".join(f"{p}:{sum(won(g,p) for g in base.values())/max(1,len(base)):.3f}" for p in P)
      + "  vp: " + " ".join(f"{p}:{sum(g['vp'][p] for g in base.values())/max(1,len(base)):.1f}" for p in P))


def ms(x):
    m = sum(x) / len(x)
    sd = math.sqrt(sum((v - m) ** 2 for v in x) / max(1, len(x) - 1))
    return m, sd / math.sqrt(len(x))


print(f"\n{'arm':16} {'n':>4}  {'win arm':>8} {'win base':>8} {'Δwin':>13}  {'Δvp':>11}  {'Δdial':>11}")
for a in sorted(arms):
    p = a.split("_")[-1]
    if p not in P:
        continue
    g = arms[a]
    common = sorted(set(g) & set(base))
    if len(common) < 5:
        continue
    dw = [won(g[s], p) - won(base[s], p) for s in common]
    dv = [g[s]["vp"][p] - base[s]["vp"][p] for s in common]
    dd = [g[s]["dial"][p] - base[s]["dial"][p] for s in common]
    (mw, sw), (mv, sv), (md, sd) = ms(dw), ms(dv), ms(dd)
    flag = " *" if abs(mw) > 2 * sw else ""
    print(f"{a:16} {len(common):4d}  {sum(won(g[s],p) for s in common)/len(common):8.3f} {sum(won(base[s],p) for s in common)/len(common):8.3f} "
          f"{mw:+.3f}±{sw:.3f}{flag:2}  {mv:+5.1f}±{sv:4.1f}  {md:+5.2f}±{sd:4.2f}")
