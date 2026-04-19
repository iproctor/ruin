#!/usr/bin/env python3
"""
Promote a trained snapshot into the hall-of-fame when its class freq beats
the current worst HOF member. Called by the coordinator after each
training iter.

Manifest (packages/ai/data/hof/manifest.json):
  {
    "capacity": 5,
    "members": [
      { "iter": 1286, "freq": 0.161, "file": "model_tenzen_hof_1286.json", "power": "tenzen" },
      ...
    ]
  }

Under capacity: always add. At capacity: replace the worst-by-freq if new > worst.
Collect-data.ts loads every file matching model_<power>_hof_*.json in hof/, so
promoting/demoting files is sufficient — no other wiring needed.
"""

import argparse
import json
import os
import shutil
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--iter', type=int, required=True)
    ap.add_argument('--freq', type=float, required=True)
    ap.add_argument('--power', required=True)
    ap.add_argument('--capacity', type=int, default=5)
    ap.add_argument('--data-dir', default='packages/ai/data')
    args = ap.parse_args()

    hof_dir = os.path.join(args.data_dir, 'hof')
    os.makedirs(hof_dir, exist_ok=True)
    manifest_path = os.path.join(hof_dir, 'manifest.json')

    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
    else:
        manifest = {'capacity': args.capacity, 'members': []}

    members = [m for m in manifest.get('members', []) if m.get('power') == args.power]
    other_members = [m for m in manifest.get('members', []) if m.get('power') != args.power]
    capacity = manifest.get('capacity', args.capacity)

    snap = f'model_{args.power}_iter_{args.iter}.json'
    snap_path = os.path.join(args.data_dir, snap)
    if not os.path.exists(snap_path):
        print(f'[hof] snapshot {snap_path} not found — skipping')
        return 0

    # If we already have this iter in HOF, nothing to do.
    if any(m['iter'] == args.iter for m in members):
        return 0

    hof_file = f'model_{args.power}_hof_{args.iter}.json'
    hof_path = os.path.join(hof_dir, hof_file)

    if len(members) < capacity:
        shutil.copy(snap_path, hof_path)
        members.append({
            'iter': args.iter, 'freq': args.freq,
            'file': hof_file, 'power': args.power,
        })
        action = f'added iter {args.iter} ({args.freq:.3f})'
    else:
        worst = min(members, key=lambda m: m['freq'])
        if args.freq <= worst['freq']:
            # Not an improvement.
            return 0
        old = os.path.join(hof_dir, worst['file'])
        if os.path.exists(old):
            os.remove(old)
        shutil.copy(snap_path, hof_path)
        members = [m for m in members if m['iter'] != worst['iter']]
        members.append({
            'iter': args.iter, 'freq': args.freq,
            'file': hof_file, 'power': args.power,
        })
        action = (f'promoted iter {args.iter} ({args.freq:.3f}), '
                  f'evicted iter {worst["iter"]} ({worst["freq"]:.3f})')

    members.sort(key=lambda m: -m['freq'])
    manifest['members'] = other_members + members
    manifest['capacity'] = capacity
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    print(f'[hof] {action}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
