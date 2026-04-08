#!/usr/bin/env python3
"""
Train a small MLP on collected self-play data and emit JSON weights
readable by the TS inference code.

Usage:
  python3 packages/ai/scripts/train_mlp.py \
      --in packages/ai/data/training.jsonl \
      --out packages/ai/data/model.json \
      --epochs 50 --batch 128 --lr 5e-3

Architecture: D -> 128 -> 64 -> 4 (softmax)

No torch dependency — pure numpy with hand-rolled backprop.
"""

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np


# ── CLI ──────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_path", required=True)
    ap.add_argument("--out", dest="out_path", required=True)
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=5e-3)
    ap.add_argument("--l2", type=float, default=1e-5)
    ap.add_argument("--val", type=float, default=0.1)
    ap.add_argument("--hidden1", type=int, default=64)
    ap.add_argument("--hidden2", type=int, default=32)
    ap.add_argument("--seed", type=int, default=1)
    return ap.parse_args()


# ── Data loading ─────────────────────────────────────────────────────────────

def load_jsonl(path: str) -> tuple[np.ndarray, np.ndarray]:
    """
    Loads training rows. Supports two formats:
      {"x": [...], "y": <int>}        legacy hard label
      {"x": [...], "t": [...]}        soft target vector (4 floats)
    Always returns (X, T) with T as a (N, 4) soft-target matrix.
    """
    xs, ts = [], []
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            xs.append(obj["x"])
            if "t" in obj:
                ts.append(obj["t"])
            else:
                soft = [0.0, 0.0, 0.0, 0.0]
                soft[int(obj["y"])] = 1.0
                ts.append(soft)
    X = np.array(xs, dtype=np.float32)
    T = np.array(ts, dtype=np.float32)
    return X, T


# ── Model ────────────────────────────────────────────────────────────────────

class MLP:
    """
    D -> H1 -> H2 -> C  with ReLU on hidden layers, softmax on output.
    Pure numpy forward/backward with Adam optimizer.
    """

    def __init__(self, d: int, h1: int, h2: int, c: int, seed: int = 1) -> None:
        rng = np.random.default_rng(seed)
        # He init for ReLU
        self.W1 = rng.normal(0, math.sqrt(2 / d),  (d,  h1)).astype(np.float32)
        self.b1 = np.zeros(h1, dtype=np.float32)
        self.W2 = rng.normal(0, math.sqrt(2 / h1), (h1, h2)).astype(np.float32)
        self.b2 = np.zeros(h2, dtype=np.float32)
        self.W3 = rng.normal(0, math.sqrt(2 / h2), (h2, c)).astype(np.float32)
        self.b3 = np.zeros(c, dtype=np.float32)

        # Adam state
        self._adam = {}
        for name in ["W1", "b1", "W2", "b2", "W3", "b3"]:
            p = getattr(self, name)
            self._adam[name] = (np.zeros_like(p), np.zeros_like(p))
        self._step = 0

    def forward(self, X: np.ndarray) -> tuple[np.ndarray, dict]:
        z1 = X @ self.W1 + self.b1
        a1 = np.maximum(z1, 0)                # ReLU
        z2 = a1 @ self.W2 + self.b2
        a2 = np.maximum(z2, 0)
        z3 = a2 @ self.W3 + self.b3
        # softmax (stable)
        z3_shift = z3 - z3.max(axis=1, keepdims=True)
        ez = np.exp(z3_shift)
        probs = ez / ez.sum(axis=1, keepdims=True)
        cache = {"X": X, "z1": z1, "a1": a1, "z2": z2, "a2": a2, "probs": probs}
        return probs, cache

    def backward(self, cache: dict, T: np.ndarray, l2: float) -> dict:
        """T is a (N, C) soft target matrix (rows sum to 1)."""
        n = T.shape[0]
        probs = cache["probs"]
        grad_z3 = (probs - T) / n

        grad_W3 = cache["a2"].T @ grad_z3 + l2 * self.W3
        grad_b3 = grad_z3.sum(axis=0)

        grad_a2 = grad_z3 @ self.W3.T
        grad_z2 = grad_a2 * (cache["z2"] > 0)

        grad_W2 = cache["a1"].T @ grad_z2 + l2 * self.W2
        grad_b2 = grad_z2.sum(axis=0)

        grad_a1 = grad_z2 @ self.W2.T
        grad_z1 = grad_a1 * (cache["z1"] > 0)

        grad_W1 = cache["X"].T @ grad_z1 + l2 * self.W1
        grad_b1 = grad_z1.sum(axis=0)

        return {"W1": grad_W1, "b1": grad_b1,
                "W2": grad_W2, "b2": grad_b2,
                "W3": grad_W3, "b3": grad_b3}

    def adam_step(self, grads: dict, lr: float,
                  beta1: float = 0.9, beta2: float = 0.999, eps: float = 1e-8) -> None:
        self._step += 1
        lr_t = lr * math.sqrt(1 - beta2 ** self._step) / (1 - beta1 ** self._step)
        for name in grads:
            g = grads[name]
            m, v = self._adam[name]
            m[:] = beta1 * m + (1 - beta1) * g
            v[:] = beta2 * v + (1 - beta2) * (g * g)
            p = getattr(self, name)
            p -= lr_t * m / (np.sqrt(v) + eps)

    def predict_classes(self, X: np.ndarray) -> np.ndarray:
        probs, _ = self.forward(X)
        return probs.argmax(axis=1)

    def to_json(self, d: int, h1: int, h2: int, c: int) -> dict:
        return {
            "version": 2,
            "type": "mlp",
            "featureDim": d,
            "layers": [
                {"W": self.W1.tolist(), "b": self.b1.tolist(), "activation": "relu"},
                {"W": self.W2.tolist(), "b": self.b2.tolist(), "activation": "relu"},
                {"W": self.W3.tolist(), "b": self.b3.tolist(), "activation": "softmax"},
            ],
        }


# ── Training loop ────────────────────────────────────────────────────────────

def soft_cross_entropy(probs: np.ndarray, T: np.ndarray) -> float:
    eps = 1e-12
    return float(-(T * np.log(np.clip(probs, eps, 1.0))).sum(axis=1).mean())


def argmax_agreement(probs: np.ndarray, T: np.ndarray) -> float:
    """Fraction of rows where the argmax predicted class matches the argmax of the target."""
    return float((probs.argmax(axis=1) == T.argmax(axis=1)).mean())


def per_class_pred_dist(probs: np.ndarray, n_classes: int) -> list[float]:
    """Average predicted probability per class — a sanity check that the model
    isn't collapsing to predicting one class only."""
    return [float(probs[:, c].mean()) for c in range(n_classes)]


def main() -> int:
    args = parse_args()
    if not os.path.exists(args.in_path):
        print(f"[ERROR] training data not found: {args.in_path}", file=sys.stderr)
        return 1

    print(f"\n=== Train MLP ===")
    print(f"in:      {args.in_path}")
    print(f"out:     {args.out_path}")
    print(f"epochs:  {args.epochs}  batch: {args.batch}  lr: {args.lr}  l2: {args.l2}")
    print()

    X, T = load_jsonl(args.in_path)
    n, d = X.shape
    print(f"loaded {n} samples, feature dim {d}")
    print(f"avg target distribution: {T.mean(axis=0).round(3).tolist()}")

    # Shuffle + split
    rng = np.random.default_rng(args.seed)
    perm = rng.permutation(n)
    X = X[perm]; T = T[perm]
    n_val = int(n * args.val)
    X_val, T_val = X[:n_val], T[:n_val]
    X_tr,  T_tr  = X[n_val:], T[n_val:]
    print(f"train: {len(T_tr)}  val: {len(T_val)}\n")

    model = MLP(d, args.hidden1, args.hidden2, 4, seed=args.seed)

    p, _ = model.forward(X_val)
    print(f"baseline (random init):  loss {soft_cross_entropy(p, T_val):.4f}  "
          f"argmax-agree {argmax_agreement(p, T_val)*100:.1f}%\n")

    n_tr = len(T_tr)
    names = ["xarm", "gormen", "tenzen", "lasha"]

    best_val = float("inf")
    best_snapshot = None
    patience = 8
    stale = 0

    for epoch in range(1, args.epochs + 1):
        idx = rng.permutation(n_tr)
        Xs, Ts = X_tr[idx], T_tr[idx]
        epoch_loss = 0.0
        n_batches = 0
        t0 = time.time()

        for i in range(0, n_tr, args.batch):
            xb = Xs[i:i + args.batch]
            tb = Ts[i:i + args.batch]
            probs, cache = model.forward(xb)
            epoch_loss += soft_cross_entropy(probs, tb)
            grads = model.backward(cache, tb, args.l2)
            model.adam_step(grads, args.lr)
            n_batches += 1

        train_loss = epoch_loss / max(n_batches, 1)
        pv, _ = model.forward(X_val)
        val_loss = soft_cross_entropy(pv, T_val)
        agree = argmax_agreement(pv, T_val)
        dist = per_class_pred_dist(pv, 4)
        dist_str = " ".join(f"{names[c]}:{dist[c]:.2f}" for c in range(4))
        dt = time.time() - t0
        print(f"epoch {epoch:2d}  train {train_loss:.4f}  val {val_loss:.4f}  "
              f"agree {agree*100:.1f}%  pred-dist[{dist_str}]  ({dt:.1f}s)")

        if val_loss < best_val - 1e-4:
            best_val = val_loss
            best_snapshot = {
                "W1": model.W1.copy(), "b1": model.b1.copy(),
                "W2": model.W2.copy(), "b2": model.b2.copy(),
                "W3": model.W3.copy(), "b3": model.b3.copy(),
            }
            stale = 0
        else:
            stale += 1
            if stale >= patience:
                print(f"  (early stop at epoch {epoch})")
                break

    if best_snapshot is not None:
        for k, v in best_snapshot.items():
            setattr(model, k, v)

    Path(args.out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out_path, "w") as f:
        json.dump(model.to_json(d, args.hidden1, args.hidden2, 4), f)
    print(f"\nsaved model to {args.out_path}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
