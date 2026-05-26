#!/usr/bin/env python3
from __future__ import annotations
"""
Curate a self-play JSONL window into a quota-balanced training set.

The script is intentionally tolerant of legacy rows with no `meta` field. It
falls back to row shape (`p`, `visits`, `t`, and the round feature at x[0]) so
it can analyze old training_recent.jsonl files, but curation improves as new
collection metadata becomes available.
"""

import argparse
import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

POWERS = ["xarm", "gormen", "tenzen", "lasha"]
POWER_INDEX = {p: i for i, p in enumerate(POWERS)}


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_path", required=True)
    ap.add_argument("--out", dest="out_path", required=True)
    ap.add_argument("--max-samples", type=int, default=240_000,
                    help="Maximum rows to write. <=0 means keep all rows.")
    ap.add_argument("--policy-quota-xarm", type=int, default=25_000,
                    help="Reserve up to this many complete xarm policy rows before other strata.")
    ap.add_argument("--policy-quota-non-xarm", type=int, default=40_000,
                    help="Reserve up to this many complete policy rows per non-xarm power before other strata.")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--report", default="",
                    help="Optional path for a JSON coverage report.")
    return ap.parse_args()


def entropy_from_visits(visits: dict[str, Any] | None) -> tuple[float | None, float | None]:
    if not visits:
        return None, None
    counts = [float(v) for v in visits.values() if float(v) > 0]
    total = sum(counts)
    if total <= 0:
        return None, None
    entropy = 0.0
    top = 0.0
    for c in counts:
        p = c / total
        entropy -= p * math.log2(p)
        top = max(top, c)
    return entropy, top / total


def row_info(row: dict[str, Any]) -> dict[str, Any]:
    meta = row.get("meta") or {}
    visits = row.get("visits")
    entropy, top1 = entropy_from_visits(visits)
    if meta.get("visitEntropy") is not None:
        entropy = float(meta["visitEntropy"])
    if meta.get("top1Share") is not None:
        top1 = float(meta["top1Share"])

    p = row.get("p", -1)
    try:
        p = int(p)
    except Exception:
        p = -1
    acting = meta.get("actingPower")
    if p < 0 and acting in POWER_INDEX:
        p = POWER_INDEX[acting]

    if meta.get("round") is not None:
        rnd = int(meta["round"])
    else:
        x = row.get("x") or []
        rnd = max(1, int(round(float(x[0]) * 10))) if x else -1

    target = row.get("t") or []
    actor_target = float(target[p]) if 0 <= p < len(target) else None
    best_target = max((float(v) for v in target), default=0.0)
    sorted_targets = sorted((float(v) for v in target), reverse=True)
    leader_gap = (sorted_targets[0] - sorted_targets[1]) if len(sorted_targets) >= 2 else 1.0

    complete = meta.get("complete")
    if complete is None:
        complete = True

    return {
        "power_idx": p,
        "power": POWERS[p] if 0 <= p < len(POWERS) else "unknown",
        "round": rnd,
        "policy": visits is not None and len(visits) > 0,
        "entropy": entropy,
        "top1": top1,
        "complete": bool(complete),
        "late": rnd >= 4,
        "behind": actor_target is not None and (best_target - actor_target) >= 0.15,
        "close": leader_gap <= 0.08,
        "near_ruin": int(meta.get("nearRuinRegions") or 0) > 0,
        "high_info_policy": visits is not None and (
            (entropy is not None and entropy >= 1.5) or (top1 is not None and top1 <= 0.70)
        ),
    }


def choose_balanced(
    candidates: list[int],
    infos: list[dict[str, Any]],
    quota: int,
    chosen: set[int],
    rng: random.Random,
) -> list[int]:
    pool = [i for i in candidates if i not in chosen]
    if quota <= 0 or not pool:
        return []
    by_power: dict[str, list[int]] = defaultdict(list)
    for i in pool:
        by_power[infos[i]["power"]].append(i)
    for rows in by_power.values():
        rng.shuffle(rows)

    out: list[int] = []
    powers = [p for p in POWERS if by_power.get(p)]
    if by_power.get("unknown"):
        powers.append("unknown")
    cursor = 0
    while len(out) < quota and powers:
        p = powers[cursor % len(powers)]
        rows = by_power[p]
        if rows:
            out.append(rows.pop())
        powers = [q for q in powers if by_power[q]]
        cursor += 1
    return out


def bucket_round(rnd: int) -> str:
    if rnd < 0:
        return "unknown"
    if rnd >= 5:
        return "5+"
    return str(rnd)


def make_report(infos: list[dict[str, Any]], selected: set[int]) -> dict[str, Any]:
    def summarize(indices: list[int]) -> dict[str, Any]:
        n = len(indices)
        power = Counter(infos[i]["power"] for i in indices)
        rounds = Counter(bucket_round(infos[i]["round"]) for i in indices)
        policy = sum(1 for i in indices if infos[i]["policy"])
        complete = sum(1 for i in indices if infos[i]["complete"])
        late = sum(1 for i in indices if infos[i]["late"])
        behind = sum(1 for i in indices if infos[i]["behind"])
        close = sum(1 for i in indices if infos[i]["close"])
        near_ruin = sum(1 for i in indices if infos[i]["near_ruin"])
        ent = [infos[i]["entropy"] for i in indices if infos[i]["entropy"] is not None]
        top1 = [infos[i]["top1"] for i in indices if infos[i]["top1"] is not None]
        return {
            "rows": n,
            "power": dict(power),
            "round": dict(rounds),
            "policy_rows": policy,
            "policy_pct": round(policy / n, 4) if n else 0,
            "complete_pct": round(complete / n, 4) if n else 0,
            "late_pct": round(late / n, 4) if n else 0,
            "behind_pct": round(behind / n, 4) if n else 0,
            "close_pct": round(close / n, 4) if n else 0,
            "near_ruin_pct": round(near_ruin / n, 4) if n else 0,
            "visit_entropy_avg": round(sum(ent) / len(ent), 4) if ent else None,
            "top1_share_avg": round(sum(top1) / len(top1), 4) if top1 else None,
        }

    return {
        "input": summarize(list(range(len(infos)))),
        "selected": summarize(sorted(selected)),
    }


def main() -> int:
    args = parse_args()
    rng = random.Random(args.seed)

    rows: list[str] = []
    infos: list[dict[str, Any]] = []
    with open(args.in_path, "r") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            rows.append(line)
            infos.append(row_info(obj))

    n = len(rows)
    max_samples = n if args.max_samples <= 0 else min(args.max_samples, n)
    chosen: set[int] = set()

    # Policy rows are the scarce signal for improving play. Reserve them first,
    # especially for non-xarm powers, then let the existing strata fill value
    # and coverage rows around that core.
    for power in POWERS:
        quota = args.policy_quota_xarm if power == "xarm" else args.policy_quota_non_xarm
        if quota <= 0:
            continue
        candidates = [
            i for i, info in enumerate(infos)
            if info["complete"] and info["policy"] and info["power"] == power
        ]
        rng.shuffle(candidates)
        for i in candidates[:max(0, min(quota, max_samples - len(chosen)))]:
            chosen.add(i)
        if len(chosen) >= max_samples:
            break

    strata = [
        ("high_info_policy", 0.25),
        ("late", 0.18),
        ("behind", 0.15),
        ("close", 0.12),
        ("near_ruin", 0.10),
    ]
    for name, frac in strata:
        candidates = [i for i, info in enumerate(infos) if info[name] and info["complete"]]
        for i in choose_balanced(candidates, infos, int(max_samples * frac), chosen, rng):
            chosen.add(i)

    # Fill the remainder from complete rows, balanced across powers and rounds.
    remaining = max_samples - len(chosen)
    if remaining > 0:
        by_round_power: dict[tuple[str, str], list[int]] = defaultdict(list)
        for i, info in enumerate(infos):
            if i in chosen or not info["complete"]:
                continue
            by_round_power[(bucket_round(info["round"]), info["power"])].append(i)
        for bucket in by_round_power.values():
            rng.shuffle(bucket)
        keys = list(by_round_power.keys())
        rng.shuffle(keys)
        cursor = 0
        while remaining > 0 and keys:
            k = keys[cursor % len(keys)]
            bucket = by_round_power[k]
            if bucket:
                chosen.add(bucket.pop())
                remaining -= 1
            keys = [q for q in keys if by_round_power[q]]
            cursor += 1

    # If the input is all legacy/incomplete or quotas could not fill, use any
    # remaining rows deterministically rather than silently shrinking too much.
    if len(chosen) < max_samples:
        rest = [i for i in range(n) if i not in chosen]
        rng.shuffle(rest)
        chosen.update(rest[:max_samples - len(chosen)])

    Path(args.out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out_path, "w") as f:
        for i in sorted(chosen):
            f.write(rows[i] + "\n")

    report = make_report(infos, chosen)
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        with open(args.report, "w") as f:
            json.dump(report, f, indent=2, sort_keys=True)

    s = report["selected"]
    print(
        f"curated {s['rows']}/{n} rows | policy {s['policy_pct']:.1%} | "
        f"late {s['late_pct']:.1%} | behind {s['behind_pct']:.1%} | "
        f"close {s['close_pct']:.1%} | near-ruin {s['near_ruin_pct']:.1%}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
