"""Streaming trainer over compact .npz shards (prep_shard.py output).

Memory stays bounded: each epoch shuffles the shard list and trains on
groups of --group shards at a time (rows shuffled within the group). Games
with gid % HOLDOUT_MOD == 0 are never trained on; they form the validation /
test set (a fixed slice across runs, so metrics are comparable).

Usage:
  python3 stream_train.py --shards '/data/iain/big/all/*/*.npz' --power gormen \
      --warm model_gormen.json --out out.json [--epochs 3] [--max-rows N]
"""
import argparse, glob, json, math, os, sys, time
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from train_mlp import DualHeadMLP, flush_denormals, ACTION_DIM  # noqa: E402

P = ["xarm", "gormen", "tenzen", "lasha"]
HOLDOUT_MOD = 20


def warm_start(model, path, d):
    old = json.load(open(path))
    for li, lj in enumerate(old["layers"][:2]):
        setattr(model, f"W{li+1}", np.array(lj["W"], dtype=np.float32))
        setattr(model, f"b{li+1}", np.array(lj["b"], dtype=np.float32))
    model.Wv = np.array(old["layers"][2]["W"], dtype=np.float32)
    model.bv = np.array(old["layers"][2]["b"], dtype=np.float32)
    model.Wp = np.array(old["policyHead"]["W"], dtype=np.float32)
    model.bp = np.array(old["policyHead"]["b"], dtype=np.float32)
    for name in model._adam:
        arr = getattr(model, name)
        model._adam[name] = (np.zeros_like(arr), np.zeros_like(arr))
    model._step = 0


def target(D, pi, kind):
    if kind == "stored":
        return D["T"][:, pi]
    if kind == "rank":
        return D["R"][:, pi]
    if kind == "winloss":
        return D["W"][:, pi]
    return 0.5 * D["T"][:, pi] + 0.5 * D["Q"][:, pi]


def load_group(files, pi, kind, holdout):
    parts = []
    for f in files:
        try:
            D = np.load(f)
        except Exception:
            continue
        keep = (D["GID"] % HOLDOUT_MOD == 0) if holdout else (D["GID"] % HOLDOUT_MOD != 0)
        if not keep.any():
            continue
        parts.append((D["X"][keep], target(D, pi, kind)[keep], D["POL"][keep],
                      D["HP"][keep] & (D["PI"][keep] == pi), D["W"][keep, pi], D["R"][keep, pi]))
    if not parts:
        return None
    return [np.concatenate([p[i] for p in parts]) for i in range(6)]


def metrics(model, H, alpha):
    X, tv, pol, hp, won, rk = H
    vs, ps = [], []
    for i in range(0, len(X), 16384):
        v, p, _ = model.forward(X[i:i + 16384].astype(np.float32))
        vs.append(v[:, 0]); ps.append(p)
    v = np.concatenate(vs); p = np.concatenate(ps); eps = 1e-6
    bce = float(-np.mean(tv * np.log(v + eps) + (1 - tv) * np.log(1 - v + eps)))
    ce = float(-np.mean(np.sum(pol[hp].astype(np.float32) * np.log(p[hp] + 1e-9), 1))) if hp.any() else 0.0
    return dict(bce=bce, pol_ce=ce, score=bce + alpha * ce,
                r_target=float(np.corrcoef(v, tv)[0, 1]), r_rank=float(np.corrcoef(v, rk)[0, 1]),
                r_win=float(np.corrcoef(v, won)[0, 1]), sd=float(v.std()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", required=True, help="glob of .npz shards")
    ap.add_argument("--power", required=True)
    ap.add_argument("--warm", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--target", default="stored", choices=["stored", "rank", "winloss", "qblend"])
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--group", type=int, default=32)
    ap.add_argument("--lr", type=float, default=5e-4)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--l2", type=float, default=1e-5)
    ap.add_argument("--max-shards", type=int, default=0, help="use only the first N shards (data-scale runs)")
    ap.add_argument("--holdout-max-shards", type=int, default=400)
    a = ap.parse_args()
    pi = P.index(a.power)
    alpha = 1.0 if a.power == "xarm" else 2.0
    files = sorted(f for f in glob.glob(a.shards) if not f.endswith('.tmp.npz'))
    rng = np.random.default_rng(1)
    if a.max_shards:
        files = list(rng.permutation(files)[:a.max_shards])
    H = load_group(sorted(files)[:a.holdout_max_shards], pi, a.target, holdout=True)
    d = H[0].shape[1]
    h1, h2 = (1024, 256) if a.power in ("tenzen", "lasha") else (512, 128)
    model = DualHeadMLP(d, h1, h2, 4, ACTION_DIM, seed=1, scalar_value=True)
    if a.warm:
        warm_start(model, a.warm, d)
    flush_denormals(model)
    m0 = metrics(model, H, alpha)
    print(f"{len(files)} shards, holdout {len(H[0])} rows | start: " + " ".join(f"{k} {v:.4f}" for k, v in m0.items()), flush=True)
    best, best_score = None, float("inf") if not a.warm else m0["score"]
    if a.warm:
        best = {k: getattr(model, k).copy() for k in ["W1", "b1", "W2", "b2", "Wv", "bv", "Wp", "bp"]}
    rows_seen = 0
    for ep in range(1, a.epochs + 1):
        t0 = time.time()
        order = rng.permutation(files)
        for gi in range(0, len(order), a.group):
            G = load_group(order[gi:gi + a.group], pi, a.target, holdout=False)
            if G is None:
                continue
            X, tv, pol, hp = G[0], G[1].astype(np.float32)[:, None], G[2], G[3]
            perm = rng.permutation(len(X))
            for i in range(0, len(perm), a.batch):
                b = perm[i:i + a.batch]
                v, p, c = model.forward(X[b].astype(np.float32))
                grads = model.backward(c, tv[b], pol[b].astype(np.float32), hp[b], a.l2, alpha, None)
                model.adam_step(grads, a.lr)
            rows_seen += len(X)
        m = metrics(model, H, alpha)
        print(f"ep {ep} ({time.time()-t0:.0f}s, {rows_seen} rows seen): " + " ".join(f"{k} {v:.4f}" for k, v in m.items()), flush=True)
        if m["score"] < best_score:
            best_score = m["score"]
            best = {k: getattr(model, k).copy() for k in ["W1", "b1", "W2", "b2", "Wv", "bv", "Wp", "bp"]}
    for k, v in best.items():
        setattr(model, k, v)
    flush_denormals(model)
    tmp = a.out + ".tmp"
    json.dump(model.to_json(d, h1, h2, 4, ACTION_DIM), open(tmp, "w"))
    os.replace(tmp, a.out)
    print(f"saved {a.out}", flush=True)


if __name__ == "__main__":
    main()
