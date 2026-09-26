"""Architecture ablation: region-structured net vs the flat MLP, both trained
from scratch on the same .npz, scored on held-out games.

RegionNet: each region's 68 features (+ 9-way region one-hot) go through one
shared encoder (77 -> E -> E, ReLU); the 9 embeddings are concatenated with the
254 global features and fed to the usual trunk (-> H1 -> H2) and heads
(scalar sigmoid value, 298-way softmax policy).

Usage: python3 regionnet.py --train train.npz --test test.npz --power gormen
         --arch region|mlp [--epochs 8] [--emb 64]
"""
import argparse, json, math, os, sys, time
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from train_mlp import DualHeadMLP, ACTION_DIM  # noqa: E402

P = ["xarm", "gormen", "tenzen", "lasha"]
LAYOUT = json.load(open(os.path.join(os.path.dirname(__file__), "region_layout.json")))
RIDX = np.array(LAYOUT["regions"])        # (9, 68)
GIDX = np.array(LAYOUT["global"])         # (254,)
NR, RF = RIDX.shape


class RegionNet:
    def __init__(self, emb, h1, h2, seed=1):
        rng = np.random.default_rng(seed)
        fin = RF + NR
        def he(i, o): return rng.normal(0, math.sqrt(2 / i), (i, o)).astype(np.float32)
        self.E1 = he(fin, emb); self.e1 = np.zeros(emb, np.float32)
        self.E2 = he(emb, emb); self.e2 = np.zeros(emb, np.float32)
        tin = NR * emb + len(GIDX)
        self.W1 = he(tin, h1); self.b1 = np.zeros(h1, np.float32)
        self.W2 = he(h1, h2); self.b2 = np.zeros(h2, np.float32)
        self.Wv = he(h2, 1); self.bv = np.zeros(1, np.float32)
        self.Wp = he(h2, ACTION_DIM); self.bp = np.zeros(ACTION_DIM, np.float32)
        self.names = ["E1", "e1", "E2", "e2", "W1", "b1", "W2", "b2", "Wv", "bv", "Wp", "bp"]
        self.adam = {k: (np.zeros_like(getattr(self, k)), np.zeros_like(getattr(self, k))) for k in self.names}
        self.t = 0
        self.onehot = np.eye(NR, dtype=np.float32)

    def forward(self, X):
        n = X.shape[0]
        R = X[:, RIDX]                                           # (n, 9, 68)
        R = np.concatenate([R, np.broadcast_to(self.onehot, (n, NR, NR))], axis=2).reshape(n * NR, -1)
        z1 = R @ self.E1 + self.e1; a1 = np.maximum(z1, 0)
        z2 = a1 @ self.E2 + self.e2; a2 = np.maximum(z2, 0)
        emb = a2.reshape(n, -1)
        T = np.concatenate([emb, X[:, GIDX]], axis=1)
        y1 = T @ self.W1 + self.b1; h1 = np.maximum(y1, 0)
        y2 = h1 @ self.W2 + self.b2; h2 = np.maximum(y2, 0)
        v = 1 / (1 + np.exp(-np.clip(h2 @ self.Wv + self.bv, -30, 30)))
        zp = h2 @ self.Wp + self.bp; zp -= zp.max(1, keepdims=True)
        p = np.exp(zp); p /= p.sum(1, keepdims=True)
        return v, p, dict(R=R, z1=z1, a1=a1, z2=z2, a2=a2, T=T, y1=y1, h1=h1, y2=y2, h2=h2, n=n)


def train_region(model, X, Tv, Tp, HP, alpha, lr, l2, idx, batch, rng):
    for i in range(0, len(idx), batch):
        b = idx[i:i + batch]; n = len(b)
        v, p, c = model.forward(X[b])
        gzv = (v - Tv[b]) / n
        gzp = (p - Tp[b]); gzp[~HP[b]] = 0; gzp *= alpha / max(1, int(HP[b].sum()))
        g = {}
        g["Wv"] = c["h2"].T @ gzv + l2 * model.Wv; g["bv"] = gzv.sum(0)
        g["Wp"] = c["h2"].T @ gzp + l2 * model.Wp; g["bp"] = gzp.sum(0)
        gh2 = gzv @ model.Wv.T + gzp @ model.Wp.T
        gy2 = gh2 * (c["y2"] > 0)
        g["W2"] = c["h1"].T @ gy2 + l2 * model.W2; g["b2"] = gy2.sum(0)
        gy1 = (gy2 @ model.W2.T) * (c["y1"] > 0)
        g["W1"] = c["T"].T @ gy1 + l2 * model.W1; g["b1"] = gy1.sum(0)
        gT = gy1 @ model.W1.T
        gemb = gT[:, :NR * model.E2.shape[1]].reshape(n * NR, -1)
        gz2 = gemb * (c["z2"] > 0)
        g["E2"] = c["a1"].T @ gz2 + l2 * model.E2; g["e2"] = gz2.sum(0)
        gz1 = (gz2 @ model.E2.T) * (c["z1"] > 0)
        g["E1"] = c["R"].T @ gz1 + l2 * model.E1; g["e1"] = gz1.sum(0)
        model.t += 1
        lr_t = lr * math.sqrt(1 - 0.999 ** model.t) / (1 - 0.9 ** model.t)
        for k in model.names:
            m, s = model.adam[k]
            m[:] = 0.9 * m + 0.1 * g[k]; s[:] = 0.999 * s + 0.001 * g[k] * g[k]
            getattr(model, k)[...] -= lr_t * m / (np.sqrt(s) + 1e-8)


def metrics(fwd, D, pi):
    X = D["X"]; vs = []; ps = []
    for i in range(0, len(X), 8192):
        v, p = fwd(X[i:i + 8192])[:2]
        vs.append(v[:, 0]); ps.append(p)
    v = np.concatenate(vs); p = np.concatenate(ps)
    won = D["W"][:, pi]; rk = D["R"][:, pi]; t = D["T"][:, pi]
    m = D["HP"] & (D["PI"] == pi)
    ce = -np.mean(np.sum(D["POL"][m] * np.log(p[m] + 1e-9), 1))
    top1 = np.mean(p[m].argmax(1) == D["POL"][m].argmax(1))
    eps = 1e-6
    bce = -np.mean(t * np.log(v + eps) + (1 - t) * np.log(1 - v + eps))
    return dict(bce=bce, r_target=np.corrcoef(v, t)[0, 1], r_win=np.corrcoef(v, won)[0, 1],
                r_rank=np.corrcoef(v, rk)[0, 1], sd=v.std(), pol_ce=ce, top1=top1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--test", required=True)
    ap.add_argument("--power", required=True)
    ap.add_argument("--arch", choices=["region", "mlp"], required=True)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--emb", type=int, default=64)
    ap.add_argument("--h1", type=int, default=512)
    ap.add_argument("--h2", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--l2", type=float, default=1e-5)
    a = ap.parse_args()
    pi = P.index(a.power)
    D = np.load(a.train); TE = np.load(a.test)
    X = D["X"]; Tv = D["T"][:, pi:pi + 1].astype(np.float32); Tp = D["POL"]; HP = D["HP"] & (D["PI"] == pi)
    alpha = 1.0 if a.power == "xarm" else 2.0
    rng = np.random.default_rng(1)
    idx_all = np.arange(len(X))
    if a.arch == "region":
        model = RegionNet(a.emb, a.h1, a.h2)
        fwd = model.forward
        nparams = sum(getattr(model, k).size for k in model.names)
    else:
        model = DualHeadMLP(X.shape[1], a.h1, a.h2, 4, ACTION_DIM, seed=1, scalar_value=True)
        fwd = model.forward
        nparams = sum(getattr(model, k).size for k in model._adam)
    print(f"{a.arch} {a.power}: {nparams} params, {len(X)} train rows, {len(TE['X'])} test rows", flush=True)
    for ep in range(1, a.epochs + 1):
        t0 = time.time()
        perm = rng.permutation(idx_all)
        if a.arch == "region":
            train_region(model, X, Tv, Tp, HP, alpha, a.lr, a.l2, perm, a.batch, rng)
        else:
            for i in range(0, len(perm), a.batch):
                b = perm[i:i + a.batch]
                v, p, c = model.forward(X[b])
                grads = model.backward(c, Tv[b], Tp[b], HP[b], a.l2, alpha, None)
                model.adam_step(grads, a.lr)
        m = metrics(fwd, TE, pi)
        print(f"ep {ep} ({time.time()-t0:.0f}s) test: " + " ".join(f"{k} {v:.4f}" for k, v in m.items()), flush=True)


if __name__ == "__main__":
    main()
