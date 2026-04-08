#!/usr/bin/env python3
"""
Upgrade collected training rows from 553 features to 562 by inserting a zero
at the position of each region's new magic-symbol feature.

Reads JSONL with rows {"x": [553 floats], "t": [4 floats]} and writes JSONL
with rows {"x": [562 floats], "t": [4 floats]}.
"""

import argparse
import json
from pathlib import Path

OLD_DIM = 553
NEW_DIM = 562
GLOBAL_DIMS = 4
PER_POWER_BLOCK = 4 * 34  # 136
REGION_BLOCK_OLD = 41
REGIONS = 9
REGION_START = GLOBAL_DIMS + PER_POWER_BLOCK  # 140


def upgrade_row(x: list[float]) -> list[float]:
    """Insert a zero at REGION_START + (i+1)*REGION_BLOCK_OLD for i in 0..8."""
    if len(x) != OLD_DIM:
        raise ValueError(f"expected {OLD_DIM} features, got {len(x)}")
    insert_positions = sorted(
        REGION_START + (i + 1) * REGION_BLOCK_OLD for i in range(REGIONS)
    )
    out: list[float] = []
    insert_set = set(insert_positions)
    for old_idx in range(OLD_DIM + 1):
        if old_idx in insert_set:
            out.append(0.0)
        if old_idx < OLD_DIM:
            out.append(x[old_idx])
    if len(out) != NEW_DIM:
        raise ValueError(f"got {len(out)} after insert, expected {NEW_DIM}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_path", required=True)
    ap.add_argument("--out", dest="out_path", required=True)
    args = ap.parse_args()

    Path(args.out_path).parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(args.in_path, "r") as fin, open(args.out_path, "w") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if len(obj["x"]) == NEW_DIM:
                # Already upgraded
                fout.write(line + "\n")
            else:
                obj["x"] = upgrade_row(obj["x"])
                fout.write(json.dumps(obj) + "\n")
            n += 1
    print(f"upgraded {n} rows: {args.in_path} -> {args.out_path}")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
