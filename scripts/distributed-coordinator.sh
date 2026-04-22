#!/bin/bash
#
# Distributed self-play coordinator. Runs on the Hetzner box.
#
# Acts as both a worker (generates its own batches) AND the trainer.
#
# Loop:
#   1. Run one local collection batch (~GAMES_PER_BATCH games), drop into inbox/
#   2. Count files in inbox/
#   3. If files in inbox/ ≥ TRAIN_THRESHOLD:
#        a. Concatenate all inbox files into training_recent.jsonl
#        b. Train fresh model.json
#        c. Snapshot as model_iter_NNNN.json
#        d. Move processed inbox files to archive/
#        e. Optionally run a benchmark every BENCH_EVERY trains
#        f. Increment iter counter
#   4. Goto 1
#
# Required env (or edit defaults below):
#   WORKER_ID         coordinator's own worker id (default 0)
#
# Optional:
#   GAMES_PER_BATCH   games per local collection batch (default 100)
#   WORKERS           local worker processes for collect:parallel (default 16)
#   TRAIN_THRESHOLD   number of inbox files needed to trigger a train (default 6)
#   TRAIN_EPOCHS      epochs per training pass (default 40)
#   TRAIN_THREADS     openblas threads for training (default 8)
#   BENCH_EVERY       run benchmark every N trains (default 5)
#   BENCH_GAMES       games per benchmark (default 48)
#   BENCH_WORKERS     parallel workers for benchmark (default 14)

set -uo pipefail

WORKER_ID=${WORKER_ID:-0}
GAMES_PER_BATCH=${GAMES_PER_BATCH:-50}
WORKERS=${WORKERS:-16}
# Focus power: if set, self-play uses model_<power>.json for that power and
# snapshots from the league pool for others. Only the focus power's model is
# trained each iteration; model.json stays frozen.
FOCUS_POWER=tenzen
# Tenzen cutoff shift ∈ [0,1]. Controls the per-game sampled Tenzen eval
# cutoff distribution inside collect-data.ts — 0 favors handmade-assisted
# openings, 1 forces all-learned. Ramp toward 1 over many iters.
TENZEN_CUTOFF_SHIFT=0.7
# Hall of Fame mix: fraction of games where the focus power uses a random
# snapshot from packages/ai/data/hof/ instead of the live focus model.
# Guards against training-data collapse by guaranteeing some games show the
# focus power executing its proper strategy.
HOF_MIX=0.1
export TENZEN_CUTOFF_SHIFT
# Train when this many NEW files (inbox) arrive. With 50 games/batch × 12 batches
# ≈ 600 games ≈ ~60k samples per train cycle.
TRAIN_THRESHOLD=${TRAIN_THRESHOLD:-12}
# Total batches to include in training (new + old). Old batches are pulled from
# archive/ most-recent-first to fill the window. This keeps training data size
# stable even when workers produce small batches.
TRAIN_WINDOW=${TRAIN_WINDOW:-18}
TRAIN_EPOCHS=${TRAIN_EPOCHS:-40}
TRAIN_THREADS=${TRAIN_THREADS:-8}
BENCH_EVERY=${BENCH_EVERY:-5}
BENCH_GAMES=${BENCH_GAMES:-48}
BENCH_WORKERS=${BENCH_WORKERS:-14}
# League training: non-zero LEAGUE_SIZE enables sampling opponents from the
# last N model_iter_*.json snapshots. Prevents role collapse. Value-head
# samples are unchanged (all powers), but policy-head visits are only
# recorded for the learner — ~4x fewer policy samples per game. Same inbox
# file count per train is fine; the trainer just sees sparser visits.
LEAGUE_SIZE=${LEAGUE_SIZE:-0}
LEAGUE_MIX=${LEAGUE_MIX:-0.5}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA_DIR="$ROOT/packages/ai/data"
INBOX="$DATA_DIR/inbox"
ARCHIVE="$DATA_DIR/archive"
LOG_FILE="$DATA_DIR/training_loop.log"

mkdir -p "$INBOX" "$ARCHIVE"

# Find the latest existing iter snapshot to continue numbering. Includes both
# the shared-model snapshots (model_iter_*.json) and per-power focus snapshots
# (model_<power>_iter_*.json). Otherwise in focus-training mode the shared
# model snapshots stop advancing, START_ITER pins to the last shared iter,
# and every coordinator restart resets the log counter to that + 1 — very
# confusing when trying to read the log across restarts.
START_ITER=$(ls "$DATA_DIR"/model_iter_*.json "$DATA_DIR"/model_*_iter_*.json 2>/dev/null \
  | sed -E 's/.*iter_0*([0-9]+)\.json/\1/' \
  | sort -n | tail -1)
START_ITER=${START_ITER:-0}
ITER=$((START_ITER + 1))
TRAINS_SINCE_BENCH=0
BATCH_COUNTER=0

{
  echo ""
  echo "===================================================================="
  echo "Distributed coordinator start: $(date)"
  echo "  WORKER_ID:        $WORKER_ID"
  echo "  GAMES_PER_BATCH:  $GAMES_PER_BATCH"
  echo "  WORKERS:          $WORKERS"
  echo "  TRAIN_THRESHOLD:  $TRAIN_THRESHOLD files in inbox"
  echo "  starting iter:    $ITER"
  echo "===================================================================="
} | tee -a "$LOG_FILE"

export OMP_NUM_THREADS=$TRAIN_THREADS
export OPENBLAS_NUM_THREADS=$TRAIN_THREADS
export MKL_NUM_THREADS=$TRAIN_THREADS
export NUMEXPR_NUM_THREADS=$TRAIN_THREADS

# Track script mtime so we re-exec when push-hetzner.sh rsyncs a new
# version. Without this the coordinator keeps running the old logic
# (schedule, cutoffs, etc.) until manually restarted.
SELF_MTIME=$(stat -c %Y "$0" 2>/dev/null || stat -f %m "$0")

while true; do
  # Restart into the latest script if it's been updated on disk.
  NOW_MTIME=$(stat -c %Y "$0" 2>/dev/null || stat -f %m "$0")
  if [ "$NOW_MTIME" != "$SELF_MTIME" ]; then
    echo "[$(date +%H:%M:%S)] [coord] script updated on disk, re-execing..." | tee -a "$LOG_FILE"
    exec "$0" "$@"
  fi

  # ── 1. Check inbox first — skip collection if threshold already met ─────────
  INBOX_COUNT=$(ls "$INBOX"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
  if [ "$INBOX_COUNT" -ge "$TRAIN_THRESHOLD" ]; then
    echo "  · inbox already has ${INBOX_COUNT}/${TRAIN_THRESHOLD} — skipping collection" | tee -a "$LOG_FILE"
  else
    BATCH_COUNTER=$((BATCH_COUNTER + 1))
    TS=$(date +%s)
    SEED=$((WORKER_ID * 100000000 + BATCH_COUNTER * 1000))
    BATCH_FILE="${INBOX}/training_W${WORKER_ID}_b$(printf '%05d' "$BATCH_COUNTER")_t${TS}.jsonl"
    rm -f "$DATA_DIR/training.jsonl"

    T0=$(date +%s)
    echo "[$(date +%H:%M:%S)] [coord] collecting batch ${BATCH_COUNTER} (${GAMES_PER_BATCH} games, seed ${SEED})" | tee -a "$LOG_FILE"
  FOCUS_ARG=""
  [ -n "$FOCUS_POWER" ] && FOCUS_ARG="--focus-power $FOCUS_POWER"
  # Adaptive mix: if the post-training hook wrote hof_mix.txt, use that
  # value; otherwise fall back to HOF_MIX env default.
  EFFECTIVE_HOF_MIX="$HOF_MIX"
  [ -f "$DATA_DIR/hof_mix.txt" ] && EFFECTIVE_HOF_MIX=$(cat "$DATA_DIR/hof_mix.txt")
  if ! pnpm collect:parallel --games "$GAMES_PER_BATCH" --seed "$SEED" \
      --workers "$WORKERS" --epsilon 0 \
      --league-size "$LEAGUE_SIZE" --league-mix "$LEAGUE_MIX" $FOCUS_ARG \
      --hof-mix "$EFFECTIVE_HOF_MIX" \
      --out "$DATA_DIR/training.jsonl" 2>&1 \
      | grep -E "^(  worker|.*samples →|\[league\]|\[focus\]|\[hof\])" | tee -a "$LOG_FILE"; then
    echo "  ! collection failed, retrying" | tee -a "$LOG_FILE"
    sleep 5
    continue
  fi
  if [ ! -s "$DATA_DIR/training.jsonl" ]; then
    echo "  ! no samples produced, retrying" | tee -a "$LOG_FILE"
    sleep 5
    continue
  fi
    mv "$DATA_DIR/training.jsonl" "$BATCH_FILE"
    SAMPLES=$(wc -l < "$BATCH_FILE")
    T1=$(date +%s)
    echo "  ✓ ${SAMPLES} samples in $((T1 - T0))s → $(basename "$BATCH_FILE")" | tee -a "$LOG_FILE"

    INBOX_COUNT=$(ls "$INBOX"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
    echo "  · inbox: ${INBOX_COUNT}/${TRAIN_THRESHOLD} batches" | tee -a "$LOG_FILE"
  fi

  # ── 2. Train when threshold reached ─────────────────────────────────────────
  if [ "$INBOX_COUNT" -lt "$TRAIN_THRESHOLD" ]; then
    # Not enough yet — loop back and make another local batch.
    # Workers may upload while we're collecting.
    continue
  fi

  ITER_TAG=$(printf '%04d' "$ITER")
  echo "" | tee -a "$LOG_FILE"
  echo "── train iter ${ITER}  ($(date +%H:%M:%S)) ────────────────────" | tee -a "$LOG_FILE"

  # 3a. Build training set: new inbox files + old archive files to fill the window.
  RECENT_FILE="$DATA_DIR/training_recent.jsonl"
  # Start with all new data (inbox)
  cat "$INBOX"/*.jsonl > "$RECENT_FILE"
  NEW_COUNT=$INBOX_COUNT
  # Fill remaining window slots from most-recent archive files
  FILL_COUNT=$((TRAIN_WINDOW - NEW_COUNT))
  if [ "$FILL_COUNT" -gt 0 ]; then
    OLD_FILES=$(ls -t "$ARCHIVE"/*.jsonl 2>/dev/null | head -"$FILL_COUNT")
    if [ -n "$OLD_FILES" ]; then
      echo "$OLD_FILES" | while read -r f; do cat "$f"; done >> "$RECENT_FILE"
      OLD_USED=$(echo "$OLD_FILES" | wc -l | tr -d ' ')
      echo "  · padded with ${OLD_USED} archive batches (window ${TRAIN_WINDOW})" | tee -a "$LOG_FILE"
    fi
  fi
  TOTAL=$(wc -l < "$RECENT_FILE")
  echo "[iter $ITER] training on ${TOTAL} samples (${NEW_COUNT} new + archive fill)" | tee -a "$LOG_FILE"

  # 3b. Train — focus mode trains only model_<power>.json, model.json frozen.
  T2=$(date +%s)
  if [ -n "$FOCUS_POWER" ]; then
    TRAIN_OUT="$DATA_DIR/model_${FOCUS_POWER}.json"
    WARM_SRC="$DATA_DIR/model_${FOCUS_POWER}.json"
    # Bootstrap: if focus model doesn't exist yet, warm-start from model.json
    [ ! -f "$WARM_SRC" ] && WARM_SRC="$DATA_DIR/model.json"
    # Scalar-value head: focuses trunk capacity on P(focus_power wins).
    # BCE gradients are sharper than softmax-CE so use smaller LR.
    TRAIN_ARGS="--power $FOCUS_POWER --warm-start $WARM_SRC --scalar-value --lr 1e-3"
  else
    TRAIN_OUT="$DATA_DIR/model.json"
    TRAIN_ARGS=""
  fi
  if ! stdbuf -oL python3 -u packages/ai/scripts/train_mlp.py \
      --in "$RECENT_FILE" --out "$TRAIN_OUT" \
      --iter "$ITER" $TRAIN_ARGS --epochs "$TRAIN_EPOCHS" --batch 512 2>&1 \
      | grep --line-buffered -E "^(loaded|baseline|ep |saved|class |reweight|policy rows|avg target|--power|warm-)" \
      | tee -a "$LOG_FILE"; then
    echo "  ! training failed" | tee -a "$LOG_FILE"
    continue
  fi
  T3=$(date +%s)
  echo "[iter $ITER] trained in $((T3 - T2))s → $(basename $TRAIN_OUT)" | tee -a "$LOG_FILE"

  # 3c. Snapshot
  if [ -n "$FOCUS_POWER" ]; then
    cp "$TRAIN_OUT" "$DATA_DIR/model_${FOCUS_POWER}_iter_${ITER_TAG}.json"
  else
    cp "$DATA_DIR/model.json" "$DATA_DIR/model_iter_${ITER_TAG}.json"
  fi

  # 3c.1 HOF promotion: if this iter's focus-power class freq beats the
  # worst HOF entry, promote it in and evict the worst. Under capacity,
  # always add. Collect-data.ts reads hof/ at startup so the next batch
  # picks up the change automatically.
  if [ -n "$FOCUS_POWER" ]; then
    # Promote the model that GENERATED the good data, not the trainee.
    # Workers played this iter's training games using the previous model
    # (model_tenzen.json as of the start of this iter), which corresponds to
    # snapshot iter N-1. Class freq in the log reflects that prior model's
    # play; training drift (new model plays worse than data said it should)
    # must not cause us to HOF the worse trainee.
    DATA_GEN_ITER=$((ITER - 1))
    TZ_FREQ=$(grep "^class freq:" "$LOG_FILE" \
      | tail -1 \
      | grep -oE "${FOCUS_POWER}:[0-9.]+" \
      | cut -d: -f2)
    if [ -n "$TZ_FREQ" ] && [ -f "$DATA_DIR/model_${FOCUS_POWER}_iter_${DATA_GEN_ITER}.json" ]; then
      python3 "$ROOT/scripts/hof-promote.py" \
        --iter "$DATA_GEN_ITER" --freq "$TZ_FREQ" --power "$FOCUS_POWER" \
        --data-dir "$DATA_DIR" 2>&1 | tee -a "$LOG_FILE"
    fi

    # Adaptive HOF mix: when focus power's class freq drops, boost HOF_MIX
    # so more collection games use a strong snapshot, pulling training data
    # back toward strong behavior. Linear ramp:
    #   freq ≥ 0.115 → HOF_MIX = 0.10 (baseline)
    #   freq  = 0.05 → HOF_MIX = 0.36
    #   freq ≤ 0.05 → HOF_MIX = 0.36 (clamped)
    # Written to hof_mix.txt; workers rsync this file and read it before
    # each collect call.
    if [ -n "$TZ_FREQ" ]; then
      ADAPTIVE_MIX=$(awk -v f="$TZ_FREQ" 'BEGIN {
        if (f >= 0.115) { mix = 0.10 }
        else if (f <= 0.05) { mix = 0.36 }
        else { mix = 0.10 + (0.115 - f) * 4 }
        printf "%.2f", mix
      }')
      echo "$ADAPTIVE_MIX" > "$DATA_DIR/hof_mix.txt"
      echo "[hof_mix] freq=${TZ_FREQ} → hof_mix=${ADAPTIVE_MIX}" | tee -a "$LOG_FILE"
    fi
  fi

  # 3d. Move processed inbox files to archive (so we don't double-train)
  mv "$INBOX"/*.jsonl "$ARCHIVE"/

  # 3d.1. Prune old archive files — keep only TRAIN_WINDOW worth (enough
  # to fill the padding window). Everything older is dead weight.
  ARCHIVE_COUNT=$(ls "$ARCHIVE"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
  if [ "$ARCHIVE_COUNT" -gt "$TRAIN_WINDOW" ]; then
    PRUNE_COUNT=$((ARCHIVE_COUNT - TRAIN_WINDOW))
    ls -t "$ARCHIVE"/*.jsonl | tail -"$PRUNE_COUNT" | xargs rm -f
    echo "  · pruned ${PRUNE_COUNT} old archive files (kept ${TRAIN_WINDOW})" | tee -a "$LOG_FILE"
  fi

  # 3e. Optional periodic benchmark
  TRAINS_SINCE_BENCH=$((TRAINS_SINCE_BENCH + 1))
  if [ "$TRAINS_SINCE_BENCH" -ge "$BENCH_EVERY" ]; then
    TRAINS_SINCE_BENCH=0
    BENCH_FILE="$DATA_DIR/bench_iter_${ITER_TAG}.json"
    echo "[iter $ITER] benchmarking ($BENCH_GAMES games)..." | tee -a "$LOG_FILE"
    pnpm benchmark:parallel --games "$BENCH_GAMES" --seed 100 \
        --workers "$BENCH_WORKERS" --out "$BENCH_FILE" 2>&1 \
        | grep -E "^(  [a-z]+ +[0-9]|WIN|DAC|ROUNDS|VP|spread|AGGREGATED|ERRORS|Total wall)" \
        | tee -a "$LOG_FILE"
  fi

  ITER=$((ITER + 1))
done
