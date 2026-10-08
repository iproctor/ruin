"""Advantage sidecars for policy-gradient training on existing shards.

For every row with a policy target (full search), the move actually played
is taken as the top-visited action. Its advantage is estimated two ways with
the anchor value nets (each row scored by the acting power's own net):
  td: V(same power's next decision in this game) - V(now)   [final target if none]
  mc: final stored target - V(now)
Writes <shard>.adv.npz next to each shard with A_TD, A_MC, ATAKEN (-1 if none).

Usage: python3 adv_prep.py --models DIR --shards 'GLOB' [--procs 4]
"""
import argparse, glob, json, os
import numpy as np
from multiprocessing import Pool

P = ["xarm", "gormen", "tenzen", "lasha"]
MODELS = {}


def load(path):
    d = json.load(open(path))
    L = [(np.array(l["W"], dtype=np.float32), np.array(l["b"], dtype=np.float32)) for l in d["layers"]]
    return L


def value(L, X):
    a = X
    for W, b in L[:2]:
        a = np.maximum(a @ W + b, 0)
    return 1 / (1 + np.exp(-np.clip((a @ L[2][0] + L[2][1])[:, 0], -30, 30)))


def init(models_dir):
    for p in P:
        MODELS[p] = load(os.path.join(models_dir, f"model_{p}.json"))


def work(f):
    out = f[:-4] + ".adv.npz"
    if os.path.exists(out):
        return 0
    D = np.load(f)
    X = D["X"].astype(np.float32); PI = D["PI"].astype(int); GID = D["GID"]; T = D["T"]
    n = len(X)
    V = np.zeros(n, np.float32)
    for i, p in enumerate(P):
        m = PI == i
        if m.any():
            V[m] = value(MODELS[p], X[m])
    z = T[np.arange(n), PI]
    vnext = z.copy()
    # rows are in game order; next decision of the same power in the same game
    nxt = {}
    for r in range(n - 1, -1, -1):
        k = (GID[r], PI[r])
        if k in nxt:
            vnext[r] = V[nxt[k]]
        nxt[k] = r
    pol = D["POL"].astype(np.float32)
    taken = np.where(D["HP"], pol.argmax(1), -1)
    tmp = out + ".tmp.npz"
    np.savez(tmp, A_TD=(vnext - V).astype(np.float32), A_MC=(z - V).astype(np.float32), ATAKEN=taken.astype(np.int16))
    os.replace(tmp, out)
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--shards", required=True)
    ap.add_argument("--procs", type=int, default=4)
    a = ap.parse_args()
    files = sorted(f for f in glob.glob(a.shards) if not f.endswith(".tmp.npz") and not f.endswith(".adv.npz"))
    with Pool(a.procs, initializer=init, initargs=(a.models,)) as pool:
        done = 0
        for i, k in enumerate(pool.imap_unordered(work, files, chunksize=8)):
            done += k
            if i % 500 == 0:
                print(f"{i+1}/{len(files)} shards, {done} rows", flush=True)
    print("DONE", flush=True)


if __name__ == "__main__":
    main()
