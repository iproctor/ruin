#!/bin/bash
#
# Big fixed-policy data collection (Sep 2026 data-scale experiment).
# Plays self-play batches with whatever model_<power>.json sits in
# packages/ai/data (the frozen anchor), converts each batch to a compact .npz
# shard under /data/iain/big/shards, keeps the raw JSONL gzipped under
# /data/iain/big/raw. Stops when /data/iain/big/STOP exists.
#
# Usage: BOX_ID=3 WORKERS=16 GAMES=32 ./scripts/bigcollect.sh

set -uo pipefail
BOX_ID=${BOX_ID:?BOX_ID required}
WORKERS=${WORKERS:-16}
GAMES=${GAMES:-32}
BIG=/data/iain/big
ROOT=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$BIG/raw" "$BIG/shards" "$BIG/logs"

# Same targets/search knobs the iter-4134 anchor was trained under.
export RUIN_MLP_BF16=1 RANK_BLEND_WEIGHT=0 PROGRESS_TARGET_MODE=relative
export XARM_CLOCK_PENALTY=0.25 NON_XARM_FIELD_PENALTY=0.125 XARM_TARGET_MODE=rank
export WINNER_BONUS_WEIGHT=0.2 RUIN_PRESSURE_LAMBDA=0.08 RUIN_PRESSURE_MAX_ROUND=3

cd "$ROOT"
b=$(ls "$BIG/shards" 2>/dev/null | grep -c "^b${BOX_ID}_" || true)
while [ ! -f "$BIG/STOP" ]; do
  b=$((b + 1))
  seed=$((BOX_ID * 100000000 + 50000000 + b * 100))
  raw="$BIG/raw/b${BOX_ID}_$(printf '%06d' $b).jsonl"
  t0=$(date +%s)
  if ! timeout --kill-after=60 3600 pnpm -s collect:parallel --games "$GAMES" --seed "$seed" --workers "$WORKERS" \
      --epsilon 0 --league-size 0 --hof-mix 0 --temp-rounds 3 --dirichlet-weight 0.25 \
      --full-search-prob 0.10 --full-search-important-bonus 0.20 \
      --full-search-prob-non-xarm 0.22 --full-search-important-bonus-non-xarm 0.35 \
      --iter 1000 --out "$raw" > "$BIG/logs/collect_b${BOX_ID}.log" 2>&1; then
    echo "[$(date +%T)] batch $b failed/timed out" >> "$BIG/logs/bigcollect_${BOX_ID}.log"
    rm -f "$raw"; pkill -u "$(id -u)" -f "collect-data.ts" || true; sleep 10; continue
  fi
  if [ -s "$raw" ]; then
    python3 packages/ai/scripts/ablate/prep_shard.py --box "$BOX_ID" --batch "$b" "$raw" "$BIG/shards/b${BOX_ID}_$(printf '%06d' $b).npz" \
      >> "$BIG/logs/bigcollect_${BOX_ID}.log" 2>&1 && gzip -1 "$raw"
  fi
  echo "[$(date +%T)] batch $b done in $(( $(date +%s) - t0 ))s" >> "$BIG/logs/bigcollect_${BOX_ID}.log"
done
