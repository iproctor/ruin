#!/usr/bin/env python3
"""
Upgrade a saved MLP model to use the new 562-feature input layout by inserting
zero-weight rows into W1 at the positions of the newly added per-region
magic-symbol features.

The new feature is added at the END of each per-region block.
Per-region block size: 41 (old) -> 42 (new); +1 per region for 9 regions = +9 features.

Input layout offsets:
  global         : 4   features
  per-power      : 4 * 34 = 136 features
  per-region     : 9 * 41 = 369 features (old) / 9 * 42 = 378 (new)
  world-track    : 2 * 22 = 44 features

Region block start (old): 140
Region i in old occupies: 140 + i*41 .. 140 + i*41 + 40
The new magic-symbol feature for region i is appended after region i's old block,
so we insert one zero row at OLD index 140 + (i+1)*41 (which becomes the position
of the new feature in the new layout).

Usage:
  python3 packages/ai/scripts/upgrade_model_features.py \
      --in packages/ai/data/model.json --out packages/ai/data/model.json
"""

import argparse
import json
from pathlib import Path

OLD_DIM = 553
NEW_DIM = 562
PER_POWER_BLOCK = 4 * 34  # 136
GLOBAL_DIMS = 4
REGION_BLOCK_OLD = 41
REGIONS = 9
REGION_START = GLOBAL_DIMS + PER_POWER_BLOCK  # 140


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_path", required=True)
    ap.add_argument("--out", dest="out_path", required=True)
    args = ap.parse_args()

    with open(args.in_path, "r") as f:
        model = json.load(f)

    if model.get("featureDim") != OLD_DIM:
        print(f"[ERROR] expected featureDim={OLD_DIM}, got {model.get('featureDim')}")
        return 1

    # Compute the OLD-row indices to insert zero rows AT (in old coordinates).
    # We insert *after* each region's old block, i.e., at index REGION_START + (i+1)*REGION_BLOCK_OLD.
    insert_positions_old = sorted(
        REGION_START + (i + 1) * REGION_BLOCK_OLD for i in range(REGIONS)
    )

    # The first layer's W has shape (OLD_DIM, h1). We need to insert rows.
    layer0 = model["layers"][0]
    W1 = layer0["W"]  # list of rows, length OLD_DIM
    if len(W1) != OLD_DIM:
        print(f"[ERROR] expected W1 to have {OLD_DIM} rows, got {len(W1)}")
        return 1

    h1 = len(W1[0])
    zero_row = [0.0] * h1

    # Build new W1 by walking old indices and inserting zero rows at the
    # appropriate positions.
    new_W1: list[list[float]] = []
    insert_set = set(insert_positions_old)
    for old_idx in range(OLD_DIM + 1):  # +1 to allow insertion at the end
        if old_idx in insert_set:
            new_W1.append(list(zero_row))
        if old_idx < OLD_DIM:
            new_W1.append(W1[old_idx])

    if len(new_W1) != NEW_DIM:
        print(f"[ERROR] new W1 has {len(new_W1)} rows, expected {NEW_DIM}")
        return 1

    layer0["W"] = new_W1
    model["featureDim"] = NEW_DIM

    Path(args.out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out_path, "w") as f:
        json.dump(model, f)
    print(f"upgraded model: {OLD_DIM} -> {NEW_DIM} features, saved to {args.out_path}")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
