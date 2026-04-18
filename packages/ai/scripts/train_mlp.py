#!/usr/bin/env python3
"""
Train a dual-head MLP (value + policy) on collected self-play data and emit
JSON weights readable by the TS inference code.

Architecture:
   Input (D)
      ↓
   Hidden1 (H1, ReLU)
      ↓
   Hidden2 (H2, ReLU)
      ↓
   ┌────┴────┐
   ↓         ↓
 Value     Policy
  (4)     (ACTION_DIM = 298)
 softmax    softmax

Losses:
  value_loss  = soft cross-entropy against the 0.8/0.2 target vector
  policy_loss = KL-divergence between predicted policy and normalized
                MCTS visit distribution (sparse target — most slots are 0)

Total loss = value_loss + alpha * policy_loss

Pure numpy. No torch dependency.

Usage:
  python3 packages/ai/scripts/train_mlp.py \
      --in packages/ai/data/training.jsonl \
      --out packages/ai/data/model.json \
      --epochs 50
"""

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np

ACTION_DIM = 298  # canonical action slots — must match action-canon.ts


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
    ap.add_argument("--hidden1", type=int, default=512)
    ap.add_argument("--hidden2", type=int, default=128)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--policy-alpha", type=float, default=1.0,
                    help="Weight on policy loss (relative to value loss).")
    ap.add_argument("--multi-policy", action="store_true",
                    help="Use per-power policy heads (v4 model). Data must have 'p' field.")
    ap.add_argument("--warm-start", type=str, default="",
                    help="Path to a v3 model.json. Trunk + value head are warm-started; "
                         "each per-power policy head is initialized from the shared head.")
    return ap.parse_args()


# ── Data loading ─────────────────────────────────────────────────────────────

def load_jsonl(path: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Returns (X, T, P, has_policy, power_idx):
      X         (N, D)   — features
      T         (N, 4)   — soft value targets
      P         (N, 298) — normalized policy targets (zeros if no visits recorded)
      has_policy(N,)     — bool, True if this row has a real policy target
      power_idx (N,)     — int, acting power index (0-3), or -1 if not tagged
    """
    xs, ts, ps, mask, pwr = [], [], [], [], []
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
            policy = np.zeros(ACTION_DIM, dtype=np.float32)
            has = False
            if "visits" in obj:
                visits = obj["visits"]
                total = sum(visits.values())
                if total > 0:
                    for slot, count in visits.items():
                        idx = int(slot)
                        if 0 <= idx < ACTION_DIM:
                            policy[idx] = count / total
                    has = True
            ps.append(policy)
            mask.append(has)
            pwr.append(obj.get("p", -1))
    X = np.array(xs, dtype=np.float32)
    T = np.array(ts, dtype=np.float32)
    P = np.array(ps, dtype=np.float32)
    M = np.array(mask, dtype=bool)
    PI = np.array(pwr, dtype=np.int32)
    return X, T, P, M, PI


# ── Model ────────────────────────────────────────────────────────────────────

POWER_NAMES = ["xarm", "gormen", "tenzen", "lasha"]
N_POWERS = len(POWER_NAMES)


class DualHeadMLP:
    """
    Shared trunk: D -> H1 (ReLU) -> H2 (ReLU)
    Value head:   H2 -> 4   (softmax)
    Policy heads: H2 -> 298 (softmax) — one per power when multi_policy=True,
                  otherwise a single shared head (backward compat).
    """

    def __init__(self, d: int, h1: int, h2: int, c: int, p: int,
                 seed: int = 1, multi_policy: bool = False) -> None:
        rng = np.random.default_rng(seed)
        self.multi_policy = multi_policy
        self.W1 = rng.normal(0, math.sqrt(2 / d),  (d,  h1)).astype(np.float32)
        self.b1 = np.zeros(h1, dtype=np.float32)
        self.W2 = rng.normal(0, math.sqrt(2 / h1), (h1, h2)).astype(np.float32)
        self.b2 = np.zeros(h2, dtype=np.float32)
        # Value head
        self.Wv = rng.normal(0, math.sqrt(2 / h2), (h2, c)).astype(np.float32)
        self.bv = np.zeros(c, dtype=np.float32)
        # Policy head(s)
        if multi_policy:
            for i in range(N_POWERS):
                setattr(self, f"Wp{i}", rng.normal(0, math.sqrt(2 / h2), (h2, p)).astype(np.float32))
                setattr(self, f"bp{i}", np.zeros(p, dtype=np.float32))
            self.Wp = None
            self.bp = None
        else:
            self.Wp = rng.normal(0, math.sqrt(2 / h2), (h2, p)).astype(np.float32)
            self.bp = np.zeros(p, dtype=np.float32)

        self._adam = {}
        param_names = ["W1", "b1", "W2", "b2", "Wv", "bv"]
        if multi_policy:
            for i in range(N_POWERS):
                param_names += [f"Wp{i}", f"bp{i}"]
        else:
            param_names += ["Wp", "bp"]
        for name in param_names:
            arr = getattr(self, name)
            self._adam[name] = (np.zeros_like(arr), np.zeros_like(arr))
        self._step = 0

    def _get_policy_weights(self, power_idx: 'np.ndarray | None') -> tuple:
        if not self.multi_policy:
            return self.Wp, self.bp
        raise ValueError("Use forward_multi for multi-policy models")

    def forward(self, X: np.ndarray) -> tuple[np.ndarray, np.ndarray, dict]:
        z1 = X @ self.W1 + self.b1
        a1 = np.maximum(z1, 0)
        z2 = a1 @ self.W2 + self.b2
        a2 = np.maximum(z2, 0)

        # Value head
        zv = a2 @ self.Wv + self.bv
        zv_shift = zv - zv.max(axis=1, keepdims=True)
        ezv = np.exp(zv_shift)
        v_probs = ezv / ezv.sum(axis=1, keepdims=True)

        # Policy head — shared or per-power
        if self.multi_policy:
            action_dim = getattr(self, "Wp0").shape[1]
            # Use head 0 as default for metrics; backward uses pp_probs per-power.
            cache_pp = {}
            for i in range(N_POWERS):
                Wp_i = getattr(self, f"Wp{i}")
                bp_i = getattr(self, f"bp{i}")
                zp_i = a2 @ Wp_i + bp_i
                zp_shift = zp_i - zp_i.max(axis=1, keepdims=True)
                ezp_i = np.exp(zp_shift)
                cache_pp[i] = ezp_i / ezp_i.sum(axis=1, keepdims=True)
            # For metrics: use head 0's predictions as a representative.
            p_probs = cache_pp[0]
            cache = {
                "X": X, "z1": z1, "a1": a1, "z2": z2, "a2": a2,
                "v_probs": v_probs, "pp_probs": cache_pp,
            }
            return v_probs, p_probs, cache
        else:
            zp = a2 @ self.Wp + self.bp
            zp_shift = zp - zp.max(axis=1, keepdims=True)
            ezp = np.exp(zp_shift)
            p_probs = ezp / ezp.sum(axis=1, keepdims=True)

            cache = {
                "X": X, "z1": z1, "a1": a1, "z2": z2, "a2": a2,
                "v_probs": v_probs, "p_probs": p_probs,
            }
            return v_probs, p_probs, cache

    def backward(
        self,
        cache: dict,
        T_value: np.ndarray,
        T_policy: np.ndarray,
        policy_mask: np.ndarray,
        l2: float,
        policy_alpha: float,
        sample_weights: 'np.ndarray | None' = None,
        power_idx: 'np.ndarray | None' = None,
    ) -> dict:
        n = T_value.shape[0]
        v_probs = cache["v_probs"]

        # Value head: cross-entropy gradient, scaled by per-sample weights.
        grad_zv = (v_probs - T_value) / n
        if sample_weights is not None:
            grad_zv = grad_zv * sample_weights[:, None]

        # Policy head(s)
        grad_a2_policy = np.zeros_like(cache["a2"])
        grads: dict = {}

        if self.multi_policy and power_idx is not None:
            pp_probs = cache["pp_probs"]
            # Untagged samples (p == -1): broadcast to all heads so they
            # train identically until power-tagged data starts flowing.
            untagged = policy_mask & (power_idx < 0)
            for i in range(N_POWERS):
                Wp_i = getattr(self, f"Wp{i}")
                mask_i = policy_mask & ((power_idx == i) | (power_idx < 0))
                n_i = max(1, int(mask_i.sum()))
                grad_zp_i = (pp_probs[i] - T_policy)
                grad_zp_i[~mask_i] = 0
                grad_zp_i = grad_zp_i * (policy_alpha / n_i)
                grads[f"Wp{i}"] = cache["a2"].T @ grad_zp_i + l2 * Wp_i
                grads[f"bp{i}"] = grad_zp_i.sum(axis=0)
                grad_a2_policy += grad_zp_i @ Wp_i.T
        else:
            p_probs = cache["p_probs"]
            grad_zp = (p_probs - T_policy)
            grad_zp[~policy_mask] = 0
            n_policy = max(1, int(policy_mask.sum()))
            grad_zp = grad_zp * (policy_alpha / n_policy)
            grads["Wp"] = cache["a2"].T @ grad_zp + l2 * self.Wp
            grads["bp"] = grad_zp.sum(axis=0)
            grad_a2_policy = grad_zp @ self.Wp.T

        # Heads -> a2 gradients
        grads["Wv"] = cache["a2"].T @ grad_zv + l2 * self.Wv
        grads["bv"] = grad_zv.sum(axis=0)
        grad_a2 = grad_zv @ self.Wv.T + grad_a2_policy
        grad_z2 = grad_a2 * (cache["z2"] > 0)

        grad_W2 = cache["a1"].T @ grad_z2 + l2 * self.W2
        grad_b2 = grad_z2.sum(axis=0)

        grad_a1 = grad_z2 @ self.W2.T
        grad_z1 = grad_a1 * (cache["z1"] > 0)

        grads["W1"] = cache["X"].T @ grad_z1 + l2 * self.W1
        grads["b1"] = grad_z1.sum(axis=0)
        grads["W2"] = grad_W2
        grads["b2"] = grad_b2

        return grads

    def adam_step(self, grads: dict, lr: float,
                  beta1: float = 0.9, beta2: float = 0.999, eps: float = 1e-8) -> None:
        self._step += 1
        lr_t = lr * math.sqrt(1 - beta2 ** self._step) / (1 - beta1 ** self._step)
        for name, g in grads.items():
            m, v = self._adam[name]
            m[:] = beta1 * m + (1 - beta1) * g
            v[:] = beta2 * v + (1 - beta2) * (g * g)
            p = getattr(self, name)
            p -= lr_t * m / (np.sqrt(v) + eps)

    def to_json(self, d: int, h1: int, h2: int, c: int, p: int) -> dict:
        layers = [
            {"W": self.W1.tolist(), "b": self.b1.tolist(), "activation": "relu"},
            {"W": self.W2.tolist(), "b": self.b2.tolist(), "activation": "relu"},
            {"W": self.Wv.tolist(), "b": self.bv.tolist(), "activation": "softmax"},
        ]
        if self.multi_policy:
            policy_heads = {}
            for i, name in enumerate(POWER_NAMES):
                policy_heads[name] = {
                    "W": getattr(self, f"Wp{i}").tolist(),
                    "b": getattr(self, f"bp{i}").tolist(),
                    "activation": "softmax",
                }
            return {
                "version": 4,
                "type": "mlp_multi_policy",
                "featureDim": d,
                "actionDim": p,
                "layers": layers,
                "policyHeads": policy_heads,
            }
        return {
            "version": 3,
            "type": "mlp_dual",
            "featureDim": d,
            "actionDim": p,
            "layers": layers,
            "policyHead": {
                "W": self.Wp.tolist(),
                "b": self.bp.tolist(),
                "activation": "softmax",
            },
        }


# ── Loss helpers ─────────────────────────────────────────────────────────────

def soft_cross_entropy(probs: np.ndarray, T: np.ndarray) -> float:
    eps = 1e-12
    return float(-(T * np.log(np.clip(probs, eps, 1.0))).sum(axis=1).mean())


def policy_cross_entropy(probs: np.ndarray, T: np.ndarray, mask: np.ndarray) -> float:
    if mask.sum() == 0:
        return 0.0
    eps = 1e-12
    rows = -(T[mask] * np.log(np.clip(probs[mask], eps, 1.0))).sum(axis=1)
    return float(rows.mean())


def argmax_agreement(probs: np.ndarray, T: np.ndarray) -> float:
    return float((probs.argmax(axis=1) == T.argmax(axis=1)).mean())


def policy_top1_accuracy(probs: np.ndarray, T: np.ndarray, mask: np.ndarray) -> float:
    if mask.sum() == 0:
        return 0.0
    p = probs[mask].argmax(axis=1)
    t = T[mask].argmax(axis=1)
    return float((p == t).mean())


def per_class_pred_dist(probs: np.ndarray, n_classes: int) -> list[float]:
    return [float(probs[:, c].mean()) for c in range(n_classes)]


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    args = parse_args()
    if not os.path.exists(args.in_path):
        print(f"[ERROR] training data not found: {args.in_path}", file=sys.stderr)
        return 1

    print(f"\n=== Train dual-head MLP ===")
    print(f"in:           {args.in_path}")
    print(f"out:          {args.out_path}")
    print(f"epochs:       {args.epochs}  batch: {args.batch}  lr: {args.lr}  l2: {args.l2}")
    print(f"hidden:       {args.hidden1} -> {args.hidden2}")
    print(f"policy alpha: {args.policy_alpha}")
    print()

    _t_load = time.time()
    X, T_value, T_policy, has_policy, power_idx = load_jsonl(args.in_path)
    n, d = X.shape
    print(f"loaded {n} samples, feature dim {d}  ({time.time() - _t_load:.1f}s)")
    print(f"policy rows: {int(has_policy.sum())} / {n}  ({100 * has_policy.mean():.1f}%)")
    if args.multi_policy:
        tagged = (power_idx >= 0).sum()
        print(f"power-tagged: {tagged} / {n}  ({100 * tagged / n:.1f}%)")
        for i, name in enumerate(POWER_NAMES):
            ct = int(((power_idx == i) & has_policy).sum())
            print(f"  {name} policy rows: {ct}")
    print(f"avg target distribution: {T_value.mean(axis=0).round(3).tolist()}")

    rng = np.random.default_rng(args.seed)
    perm = rng.permutation(n)
    X = X[perm]; T_value = T_value[perm]; T_policy = T_policy[perm]; has_policy = has_policy[perm]; power_idx = power_idx[perm]
    n_val = int(n * args.val)
    X_val,  Tv_val, Tp_val, hp_val, pi_val = X[:n_val], T_value[:n_val], T_policy[:n_val], has_policy[:n_val], power_idx[:n_val]
    X_tr,   Tv_tr,  Tp_tr,  hp_tr,  pi_tr  = X[n_val:], T_value[n_val:], T_policy[n_val:], has_policy[n_val:], power_idx[n_val:]
    # ── Inverse-frequency reweighting ──────────────────────────────────────────
    # Break the self-reinforcing loop: if xarm wins 80% of games, xarm-win
    # samples dominate the gradient and the model learns "predict xarm" instead
    # of learning to play the other powers. Fix: weight each sample by the
    # inverse of its winner's frequency. Rare winners (non-xarm) get amplified.
    winner_class = T_value.argmax(axis=1)  # which power won (0-3)
    class_counts = np.bincount(winner_class, minlength=4).astype(np.float32)
    class_counts = np.maximum(class_counts, 1)  # avoid div-by-zero
    class_freq = class_counts / class_counts.sum()
    # Weight = 1 / (4 * freq) → uniform classes get weight 1.0, rare classes get > 1
    inv_freq = 1.0 / (4.0 * class_freq)
    sample_weights = inv_freq[winner_class].astype(np.float32)
    # Split into train/val (same permutation as above)
    sw_val = sample_weights[:n_val]
    sw_tr = sample_weights[n_val:]
    _rw_names = ["xarm", "gormen", "tenzen", "lasha"]
    print(f"class counts: {' '.join(f'{_rw_names[i]}:{int(class_counts[i])}' for i in range(4))}")
    print(f"class freq:   {' '.join(f'{_rw_names[i]}:{class_freq[i]:.3f}' for i in range(4))}")
    print(f"reweight:     {' '.join(f'{_rw_names[i]}:{inv_freq[i]:.2f}' for i in range(4))}")
    print(f"train: {len(Tv_tr)}  val: {len(Tv_val)}\n")

    model = DualHeadMLP(d, args.hidden1, args.hidden2, 4, ACTION_DIM,
                        seed=args.seed, multi_policy=args.multi_policy)
    if args.warm_start:
        with open(args.warm_start) as wf:
            old = json.load(wf)
        ver = old.get("version")
        if ver in (3, 4):
            # Trunk + value head (shared across v3 and v4)
            for li, lj in enumerate(old["layers"][:2]):
                setattr(model, f"W{li+1}", np.array(lj["W"], dtype=np.float32))
                setattr(model, f"b{li+1}", np.array(lj["b"], dtype=np.float32))
            vl = old["layers"][2]
            model.Wv = np.array(vl["W"], dtype=np.float32)
            model.bv = np.array(vl["b"], dtype=np.float32)
            # Policy head(s)
            if ver == 4 and "policyHeads" in old:
                ph_map = old["policyHeads"]
                if args.multi_policy:
                    for i, name in enumerate(POWER_NAMES):
                        if name in ph_map:
                            setattr(model, f"Wp{i}", np.array(ph_map[name]["W"], dtype=np.float32))
                            setattr(model, f"bp{i}", np.array(ph_map[name]["b"], dtype=np.float32))
                else:
                    first = ph_map[POWER_NAMES[0]]
                    model.Wp = np.array(first["W"], dtype=np.float32)
                    model.bp = np.array(first["b"], dtype=np.float32)
            elif "policyHead" in old:
                ph = old["policyHead"]
                if args.multi_policy:
                    for i in range(N_POWERS):
                        setattr(model, f"Wp{i}", np.array(ph["W"], dtype=np.float32).copy())
                        setattr(model, f"bp{i}", np.array(ph["b"], dtype=np.float32).copy())
                else:
                    model.Wp = np.array(ph["W"], dtype=np.float32)
                    model.bp = np.array(ph["b"], dtype=np.float32)
            # Reset Adam state for warm-started params
            for name in model._adam:
                arr = getattr(model, name)
                model._adam[name] = (np.zeros_like(arr), np.zeros_like(arr))
            model._step = 0
            src = f"v{ver}"
            dst = "v4 multi-policy" if args.multi_policy else "v3"
            print(f"warm-started from {args.warm_start} ({src} → {dst})")
        else:
            print(f"[WARN] warm-start model version {ver} — only v3/v4 supported, skipping")
    n_tr = len(Tv_tr)
    names = ["xarm", "gormen", "tenzen", "lasha"]

    best_val = float("inf")
    best_snap = None
    patience = 20
    stale = 0

    for epoch in range(1, args.epochs + 1):
        idx = rng.permutation(n_tr)
        X_s = X_tr[idx]; Tv_s = Tv_tr[idx]; Tp_s = Tp_tr[idx]; hp_s = hp_tr[idx]; sw_s = sw_tr[idx]; pi_s = pi_tr[idx]
        epoch_v_loss = 0.0
        epoch_p_loss = 0.0
        n_batches = 0
        t0 = time.time()
        for i in range(0, n_tr, args.batch):
            xb = X_s[i:i + args.batch]
            tvb = Tv_s[i:i + args.batch]
            tpb = Tp_s[i:i + args.batch]
            hpb = hp_s[i:i + args.batch]
            wb = sw_s[i:i + args.batch]
            pib = pi_s[i:i + args.batch]
            v_probs, p_probs, cache = model.forward(xb)
            epoch_v_loss += soft_cross_entropy(v_probs, tvb)
            epoch_p_loss += policy_cross_entropy(p_probs, tpb, hpb)
            grads = model.backward(cache, tvb, tpb, hpb, args.l2, args.policy_alpha, wb,
                                   power_idx=pib if args.multi_policy else None)
            model.adam_step(grads, args.lr)
            n_batches += 1

        train_v = epoch_v_loss / max(n_batches, 1)
        train_p = epoch_p_loss / max(n_batches, 1)
        v_probs_val, p_probs_val, _ = model.forward(X_val)
        val_v = soft_cross_entropy(v_probs_val, Tv_val)
        val_p = policy_cross_entropy(p_probs_val, Tp_val, hp_val)
        val_agree = argmax_agreement(v_probs_val, Tv_val)
        pol_top1 = policy_top1_accuracy(p_probs_val, Tp_val, hp_val)
        dist = per_class_pred_dist(v_probs_val, 4)
        dist_str = " ".join(f"{names[c]}:{dist[c]:.2f}" for c in range(4))
        dt = time.time() - t0
        print(
            f"ep {epoch:2d}  "
            f"v {train_v:.3f}/{val_v:.3f}  "
            f"p {train_p:.3f}/{val_p:.3f}  "
            f"v-agree {val_agree*100:.0f}%  p-top1 {pol_top1*100:.0f}%  "
            f"[{dist_str}]  ({dt:.1f}s)"
        )

        # Early stop on combined loss
        combined = val_v + args.policy_alpha * val_p
        if combined < best_val - 1e-4:
            best_val = combined
            snap_keys = ["W1", "b1", "W2", "b2", "Wv", "bv"]
            if model.multi_policy:
                for i in range(N_POWERS):
                    snap_keys += [f"Wp{i}", f"bp{i}"]
            else:
                snap_keys += ["Wp", "bp"]
            best_snap = {k: getattr(model, k).copy() for k in snap_keys}
            stale = 0
        else:
            stale += 1
            if stale >= patience:
                print(f"  (early stop at epoch {epoch})")
                break

    if best_snap is not None:
        for k, v in best_snap.items():
            setattr(model, k, v)

    Path(args.out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out_path, "w") as f:
        json.dump(model.to_json(d, args.hidden1, args.hidden2, 4, ACTION_DIM), f)
    print(f"\nsaved model to {args.out_path}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
