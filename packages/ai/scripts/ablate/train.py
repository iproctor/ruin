"""Offline ablation trainer: warm-start one power's model and train it on a
fixed .npz dataset (from prep.py) under a chosen value target and optional
auxiliary per-round head, then write a normal model JSON for benchmarking.

Variants (--target):
  stored  - the target the rows were collected with (control)
  rank    - final-placement rank (winners first, others by progress)
  winloss - 1 if this power won, else 0
  qblend  - 0.5 * stored + 0.5 * recorded root search value
--aux W   - add a linear head predicting next-round VP/threat gains for all
            four powers (8 outputs, MSE), weight W on the trunk gradient.
"""
import argparse, json, math, os, sys, time
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from train_mlp import DualHeadMLP, flush_denormals, ACTION_DIM  # noqa: E402

P = ["xarm", "gormen", "tenzen", "lasha"]


def warm_start(model, path, d):
    old = json.load(open(path))
    for li, lj in enumerate(old["layers"][:2]):
        W = np.array(lj["W"], dtype=np.float32)
        if li == 0 and W.shape[0] < d:
            W = np.vstack([W, np.zeros((d - W.shape[0], W.shape[1]), dtype=np.float32)])
        setattr(model, f"W{li+1}", W)
        setattr(model, f"b{li+1}", np.array(lj["b"], dtype=np.float32))
    model.Wv = np.array(old["layers"][2]["W"], dtype=np.float32)
    model.bv = np.array(old["layers"][2]["b"], dtype=np.float32)
    model.Wp = np.array(old["policyHead"]["W"], dtype=np.float32)
    model.bp = np.array(old["policyHead"]["b"], dtype=np.float32)
    for name in model._adam:
        arr = getattr(model, name)
        model._adam[name] = (np.zeros_like(arr), np.zeros_like(arr))
    model._step = 0
    return len(old["layers"][0]["W"][0]), len(old["layers"][1]["W"][0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--power", required=True)
    ap.add_argument("--warm", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--target", default="stored", choices=["stored", "rank", "winloss", "qblend"])
    ap.add_argument("--aux", type=float, default=0.0)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=5e-4)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--hidden1", type=int, default=0)
    ap.add_argument("--hidden2", type=int, default=0)
    ap.add_argument("--policy-alpha", type=float, default=-1)
    ap.add_argument("--l2", type=float, default=1e-5)
    ap.add_argument("--val", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()

    D = np.load(a.data)
    pi = P.index(a.power)
    X = D["X"]; n, d = X.shape
    if a.target == "stored":
        tv = D["T"][:, pi]
    elif a.target == "rank":
        tv = D["R"][:, pi]
    elif a.target == "winloss":
        tv = D["W"][:, pi]
    else:
        tv = 0.5 * D["T"][:, pi] + 0.5 * D["Q"][:, pi]
    Tv = tv.astype(np.float32)[:, None]
    Tp = D["POL"]; HP = D["HP"] & (D["PI"] == pi)
    AUX = D["AUX"]; G = D["GID"]
    alpha = a.policy_alpha if a.policy_alpha >= 0 else (1.0 if a.power == "xarm" else 2.0)

    rng = np.random.default_rng(a.seed)
    games = np.unique(G)
    val_games = set(rng.choice(games, size=max(1, int(len(games) * a.val)), replace=False).tolist())
    vmask = np.isin(G, list(val_games))
    tr = np.where(~vmask)[0]; va = np.where(vmask)[0]

    h1 = a.hidden1 or (1024 if a.power in ("tenzen", "lasha") else 512)
    h2 = a.hidden2 or (256 if a.power in ("tenzen", "lasha") else 128)
    model = DualHeadMLP(d, h1, h2, 4, ACTION_DIM, seed=a.seed, scalar_value=True)
    if a.warm:
        wh1, wh2 = json.load(open(a.warm))["layers"][0]["W"][0].__len__(), None
        if wh1 == h1:
            warm_start(model, a.warm, d)
            print(f"warm-started from {a.warm}")
        else:
            print(f"fresh init (warm width {wh1} != {h1})")
    flush_denormals(model)
    # Auxiliary head: a2 -> 8 linear outputs, MSE.
    Wa = rng.normal(0, math.sqrt(1 / h2), (h2, AUX.shape[1])).astype(np.float32)
    ba = np.zeros(AUX.shape[1], dtype=np.float32)
    ma = [np.zeros_like(Wa), np.zeros_like(Wa), np.zeros_like(ba), np.zeros_like(ba)]

    def evaluate(idx):
        v, p, cache = model.forward(X[idx])
        v = v[:, 0]; t = Tv[idx, 0]
        eps = 1e-6
        bce = float(-np.mean(t * np.log(v + eps) + (1 - t) * np.log(1 - v + eps)))
        # Outcome-grounded metrics independent of the target variant:
        won = D["W"][idx, pi]
        corr_win = float(np.corrcoef(v, won)[0, 1]) if won.std() > 0 else 0.0
        hp = HP[idx]
        pce = float(-np.mean(np.sum(Tp[idx][hp] * np.log(p[hp] + 1e-9), 1))) if hp.any() else float("nan")
        aux_mse = float(np.mean((cache["a2"] @ Wa + ba - AUX[idx]) ** 2))
        return bce, corr_win, float(v.std()), pce, aux_mse

    best = None; best_score = float("inf")
    for ep in range(1, a.epochs + 1):
        t0 = time.time()
        perm = rng.permutation(tr)
        for i in range(0, len(perm), a.batch):
            b = perm[i:i + a.batch]
            v, p, cache = model.forward(X[b])
            extra = None
            if a.aux > 0:
                pred = cache["a2"] @ Wa + ba
                g = (2.0 / len(b)) * (pred - AUX[b]) * a.aux
                gWa = cache["a2"].T @ g; gba = g.sum(0)
                extra = g @ Wa.T
                # Adam for the aux head.
                for (w, gw, m_i) in ((Wa, gWa, 0), (ba, gba, 2)):
                    ma[m_i] = 0.9 * ma[m_i] + 0.1 * gw
                    ma[m_i + 1] = 0.999 * ma[m_i + 1] + 0.001 * gw * gw
                    w -= a.lr * ma[m_i] / (np.sqrt(ma[m_i + 1]) + 1e-8)
            grads = model.backward(cache, Tv[b], Tp[b], HP[b], a.l2, alpha, None, extra_grad_a2=extra)
            model.adam_step(grads, a.lr)
        bce, cw, sd, pce, amse = evaluate(va)
        score = bce + alpha * pce
        print(f"ep {ep} val: value bce {bce:.4f} corr(pred, won) {cw:.3f} pred sd {sd:.3f} policy ce {pce:.4f} aux mse {amse:.4f} ({time.time()-t0:.0f}s)", flush=True)
        if score < best_score:
            best_score = score
            best = {k: getattr(model, k).copy() for k in ["W1", "b1", "W2", "b2", "Wv", "bv", "Wp", "bp"]}
    for k, v in best.items():
        setattr(model, k, v)
    flush_denormals(model)
    json.dump(model.to_json(d, h1, h2, 4, ACTION_DIM), open(a.out, "w"))
    print(f"saved {a.out}")


if __name__ == "__main__":
    main()
