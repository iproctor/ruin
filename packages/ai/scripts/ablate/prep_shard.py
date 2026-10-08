"""Convert one self-play batch (JSONL, game order) into a compact .npz shard
for the streaming trainer: float16 features/policy, float32 targets
(stored, rank, win/loss, root-Q), game ids unique across boxes.

Usage: python3 prep_shard.py --box 3 --batch 17 in.jsonl out.npz
"""
import argparse, json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from prep import rank_target, P, ACTION_DIM  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--box", type=int, required=True)
    ap.add_argument("--batch", type=int, required=True)
    ap.add_argument("inp")
    ap.add_argument("out")
    a = ap.parse_args()
    rows = [json.loads(l) for l in open(a.inp) if l.strip()]
    games, cur, last = [], [], None
    for r in rows:
        ply = r["meta"]["gamePly"]
        if last is not None and ply < last:
            games.append(cur); cur = []
        cur.append(r); last = ply
    if cur:
        games.append(cur)
    X, T, Q, R, W, POL, HP, PI, GID, RD = [], [], [], [], [], [], [], [], [], []
    for gi, g in enumerate(games):
        gid = a.box * 10**9 + a.batch * 1000 + gi
        m0 = g[-1]["meta"]
        rk = rank_target(m0.get("winners"), m0["finalVp"], m0["finalThreat"])
        winners = set(m0.get("winners") or [])
        for r in g:
            X.append(r["x"]); T.append(r["t"]); Q.append(r.get("q") or r["t"])
            R.append(rk if rk is not None else r["t"])
            W.append([1.0 if p in winners else 0.0 for p in P])
            pol = np.zeros(ACTION_DIM, dtype=np.float32); has = False
            v = r.get("visits")
            if v:
                tot = sum(v.values())
                if tot > 0:
                    for k, c in v.items():
                        pol[int(k)] = c / tot
                    has = True
            POL.append(pol); HP.append(has); PI.append(r["p"]); GID.append(gid); RD.append(r["meta"]["round"])
    tmp = a.out + ".tmp.npz"
    np.savez_compressed(tmp, X=np.array(X, dtype=np.float16), T=np.array(T, dtype=np.float32),
                        Q=np.array(Q, dtype=np.float32), R=np.array(R, dtype=np.float32),
                        W=np.array(W, dtype=np.float32), POL=np.array(POL, dtype=np.float16),
                        HP=np.array(HP), PI=np.array(PI, dtype=np.int8), GID=np.array(GID, dtype=np.int64),
                        RD=np.array(RD, dtype=np.int8))
    os.replace(tmp, a.out)
    print(f"{a.out}: {len(X)} rows, {len(games)} games")


if __name__ == "__main__":
    main()
