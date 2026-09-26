"""Score model JSONs on a held-out .npz with target-independent metrics:
correlation of the value prediction with actually winning and with final
rank, plus policy cross-entropy / top-1 on the power's own policy rows.

Usage: python3 evaluate.py --data test.npz name=dir [name=dir ...]
       (each dir holds model_<power>.json for any subset of powers)
"""
import argparse, json, os
import numpy as np

P = ["xarm", "gormen", "tenzen", "lasha"]


def load(path):
    d = json.load(open(path))
    L = [(np.array(l["W"], dtype=np.float32), np.array(l["b"], dtype=np.float32)) for l in d["layers"]]
    ph = d["policyHead"]
    return L, (np.array(ph["W"], dtype=np.float32), np.array(ph["b"], dtype=np.float32))


def fwd(L, PH, X):
    a = X[:, :L[0][0].shape[0]]
    for W, b in L[:2]:
        a = np.maximum(a @ W + b, 0)
    v = 1 / (1 + np.exp(-np.clip((a @ L[2][0] + L[2][1])[:, 0], -30, 30)))
    zp = a @ PH[0] + PH[1]
    zp -= zp.max(1, keepdims=True)
    pp = np.exp(zp); pp /= pp.sum(1, keepdims=True)
    return v, pp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("models", nargs="+")
    a = ap.parse_args()
    D = np.load(a.data)
    X = D["X"]
    print(f"{'model':16} {'power':7} {'r(win)':>7} {'r(rank)':>8} {'pred sd':>8} {'pol CE':>7} {'top1':>5}")
    for spec in a.models:
        name, d = spec.split("=")
        for i, p in enumerate(P):
            f = os.path.join(d, f"model_{p}.json")
            if not os.path.exists(f):
                continue
            L, PH = load(f)
            v, pp = fwd(L, PH, X)
            won = D["W"][:, i]; rk = D["R"][:, i]
            rw = np.corrcoef(v, won)[0, 1]; rr = np.corrcoef(v, rk)[0, 1]
            m = D["HP"] & (D["PI"] == i)
            T = D["POL"][m]
            ce = -np.mean(np.sum(T * np.log(pp[m] + 1e-9), 1))
            top1 = np.mean(pp[m].argmax(1) == T.argmax(1))
            print(f"{name:16} {p:7} {rw:7.3f} {rr:8.3f} {v.std():8.3f} {ce:7.3f} {top1:5.2f}")


if __name__ == "__main__":
    main()
