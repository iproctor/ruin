"""Data-scaling learning curve: train the standard MLP from scratch on a
fraction of the games in train.npz (early stopping on a game-level val split
of that subset), then score on held-out test.npz.

Usage: python3 learning_curve.py --train train.npz --test test.npz --power gormen --frac 0.25
"""
import argparse, os, sys, time
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from train_mlp import DualHeadMLP, ACTION_DIM  # noqa: E402

P = ["xarm", "gormen", "tenzen", "lasha"]


def value_metrics(model, D, pi):
    X = D["X"]; vs = []; ps = []
    for i in range(0, len(X), 16384):
        v, p, _ = model.forward(X[i:i + 16384])
        vs.append(v[:, 0]); ps.append(p)
    v = np.concatenate(vs); p = np.concatenate(ps)
    t = D["T"][:, pi]; eps = 1e-6
    bce = float(-np.mean(t * np.log(v + eps) + (1 - t) * np.log(1 - v + eps)))
    m = D["HP"] & (D["PI"] == pi)
    ce = float(-np.mean(np.sum(D["POL"][m] * np.log(p[m] + 1e-9), 1)))
    return dict(bce=bce, r_target=float(np.corrcoef(v, t)[0, 1]),
                r_rank=float(np.corrcoef(v, D["R"][:, pi])[0, 1]),
                r_win=float(np.corrcoef(v, D["W"][:, pi])[0, 1]), pol_ce=ce)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--test", required=True)
    ap.add_argument("--power", required=True)
    ap.add_argument("--frac", type=float, required=True)
    ap.add_argument("--max-epochs", type=int, default=30)
    ap.add_argument("--patience", type=int, default=3)
    ap.add_argument("--lr", type=float, default=1e-3)
    a = ap.parse_args()
    pi = P.index(a.power)
    D = np.load(a.train); TE = np.load(a.test)
    rng = np.random.default_rng(7)
    games = np.unique(D["GID"])
    sub = rng.choice(games, size=max(20, int(len(games) * a.frac)), replace=False)
    nval = max(5, len(sub) // 10)
    val_g, tr_g = sub[:nval], sub[nval:]
    tr = np.where(np.isin(D["GID"], tr_g))[0]; va = np.where(np.isin(D["GID"], val_g))[0]
    X = D["X"]; Tv = D["T"][:, pi:pi + 1].astype(np.float32); Tp = D["POL"]; HP = D["HP"] & (D["PI"] == pi)
    alpha = 1.0 if a.power == "xarm" else 2.0
    h1, h2 = (1024, 256) if a.power in ("tenzen", "lasha") else (512, 128)
    model = DualHeadMLP(X.shape[1], h1, h2, 4, ACTION_DIM, seed=1, scalar_value=True)
    best, best_val, stale = None, float("inf"), 0
    t0 = time.time()
    for ep in range(1, a.max_epochs + 1):
        perm = rng.permutation(tr)
        for i in range(0, len(perm), 512):
            b = perm[i:i + 512]
            v, p, c = model.forward(X[b])
            model.adam_step(model.backward(c, Tv[b], Tp[b], HP[b], 1e-5, alpha, None), a.lr)
        v, p, _ = model.forward(X[va])
        t = Tv[va, 0]; eps = 1e-6
        vb = -np.mean(t * np.log(v[:, 0] + eps) + (1 - t) * np.log(1 - v[:, 0] + eps))
        hp = HP[va]
        pc = -np.mean(np.sum(Tp[va][hp] * np.log(p[hp] + 1e-9), 1)) if hp.any() else 0.0
        score = vb + alpha * pc
        if score < best_val - 1e-4:
            best_val, stale = score, 0
            best = {k: getattr(model, k).copy() for k in ["W1", "b1", "W2", "b2", "Wv", "bv", "Wp", "bp"]}
        else:
            stale += 1
            if stale >= a.patience:
                break
    for k, v in best.items():
        setattr(model, k, v)
    m = value_metrics(model, TE, pi)
    print(f"RESULT power={a.power} frac={a.frac} games={len(tr_g)} rows={len(tr)} epochs={ep} ({time.time()-t0:.0f}s) "
          + " ".join(f"{k}={v:.4f}" for k, v in m.items()), flush=True)


if __name__ == "__main__":
    main()
