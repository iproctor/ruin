#!/usr/bin/env python3
"""
Promote a trained snapshot into the hall-of-fame when its avg rank beats
the current worst HOF member. Called by the coordinator after each
training iter.

Per-power layout:
  packages/ai/data/hof/<power>/manifest.json
  packages/ai/data/hof/<power>/model_hof_<iter>.json

Manifest:
  {
    "capacity": 5,
    "members": [
      { "iter": 1286, "rank": 0.412, "file": "model_hof_1286.json" },
      ...
    ]
  }

Under capacity: always add. At capacity: replace the worst-by-rank if new > worst.
Collect-data.ts loads every file in hof/<power>/ (except manifest.json).

Avg rank is mean target value across training samples for this power:
1.0 = always 1st, 0.5 = random placement, 0.0 = always last.
Captures placement quality (2nd/3rd finishes), not just wins.
"""

import argparse
import json
import os
import shutil
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--iter', type=int, required=True)
    ap.add_argument('--rank', type=float, required=True,
                    help='Avg rank for the focus power across training samples [0,1]. '
                         '0.5 = random placement, 1.0 = always 1st, 0.0 = always last.')
    ap.add_argument('--power', required=True)
    ap.add_argument('--capacity', type=int, default=5)
    ap.add_argument('--data-dir', default='packages/ai/data')
    ap.add_argument('--min-rank', type=float, default=0.3,
                    help='Skip promotion entirely if the new iter avg rank is below this '
                         'floor. Prevents weak iters from polluting HOF during regressions.')
    args = ap.parse_args()

    if args.rank < args.min_rank:
        print(f'[hof] iter {args.iter} rank {args.rank:.3f} < floor {args.min_rank:.3f} — skipping')
        return 0

    hof_dir = os.path.join(args.data_dir, 'hof', args.power)
    os.makedirs(hof_dir, exist_ok=True)
    manifest_path = os.path.join(hof_dir, 'manifest.json')

    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
    else:
        manifest = {'capacity': args.capacity, 'members': []}

    members = list(manifest.get('members', []))
    capacity = manifest.get('capacity', args.capacity)

    snap = f'model_{args.power}_iter_{args.iter}.json'
    snap_path = os.path.join(args.data_dir, snap)
    if not os.path.exists(snap_path):
        print(f'[hof] snapshot {snap_path} not found — skipping')
        return 0

    if any(m['iter'] == args.iter for m in members):
        return 0

    hof_file = f'model_hof_{args.iter}.json'
    hof_path = os.path.join(hof_dir, hof_file)

    def member_score(m):
        return m.get('rank', m.get('freq', 0))

    if len(members) < capacity:
        shutil.copy(snap_path, hof_path)
        members.append({'iter': args.iter, 'rank': args.rank, 'file': hof_file})
        action = f'added iter {args.iter} ({args.rank:.3f})'
    else:
        worst = min(members, key=member_score)
        worst_score = member_score(worst)
        if args.rank <= worst_score:
            return 0
        old = os.path.join(hof_dir, worst['file'])
        if os.path.exists(old):
            os.remove(old)
        shutil.copy(snap_path, hof_path)
        members = [m for m in members if m['iter'] != worst['iter']]
        members.append({'iter': args.iter, 'rank': args.rank, 'file': hof_file})
        action = (f'promoted iter {args.iter} ({args.rank:.3f}), '
                  f'evicted iter {worst["iter"]} ({worst_score:.3f})')

    members.sort(key=lambda m: -member_score(m))
    manifest['members'] = members
    manifest['capacity'] = capacity
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    print(f'[hof] {action}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
