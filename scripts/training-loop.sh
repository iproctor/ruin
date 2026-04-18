#!/bin/bash
#
# Overnight self-play training loop.
#
# Each iteration:
#   1. Collect N games in parallel using the current model as the evaluator
#   2. Stash the new data into training_iter_NNN.jsonl
#   3. Concatenate the last K iterations into training_recent.jsonl (rolling window)
#   4. Train a fresh model on the rolling window
#   5. Snapshot model_iter_NNN.json
#   6. Every BENCH_EVERY iterations, run a parallel benchmark
#   7. Append everything to a log file
#
# Tunables: pass via environment or edit defaults below.
#
# Usage:
#   ITERATIONS=100 GAMES=200 WORKERS=6 BENCH_EVERY=5 ./scripts/training-loop.sh
#
# The loop is interruptible — Ctrl-C between iterations leaves you with the
# latest model.json + iter snapshots intact.

set -uo pipefail

ITERATIONS=${ITERATIONS:-100}
GAMES=${GAMES:-200}
WORKERS=${WORKERS:-6}
EPSILON=${EPSILON:-0.15}
# League training (AlphaStar-lite): non-zero LEAGUE_SIZE enables it.
# Per game, one power is the learner (on current model); each other power,
# with probability LEAGUE_MIX, is assigned a random model from the last
# LEAGUE_SIZE snapshots as its opponent policy. Only the learner's decision
# points produce training samples — so expect ~4x fewer samples per game.
LEAGUE_SIZE=${LEAGUE_SIZE:-0}
LEAGUE_MIX=${LEAGUE_MIX:-0.5}
BENCH_EVERY=${BENCH_EVERY:-5}
BENCH_GAMES=${BENCH_GAMES:-12}
WINDOW=${WINDOW:-6}            # rolling-window size in iterations
TRAIN_EPOCHS=${TRAIN_EPOCHS:-40}
SEED_BASE=${SEED_BASE:-10000}

DATA_DIR="packages/ai/data"
LOG_FILE="$DATA_DIR/training_loop.log"
mkdir -p "$DATA_DIR"

# Iteration index continues from any existing snapshots so this script can be
# safely re-run after a crash or restart without clobbering history.
START_ITER=$(ls "$DATA_DIR"/model_iter_*.json 2>/dev/null \
  | sed -E 's/.*model_iter_0*([0-9]+)\.json/\1/' \
  | sort -n | tail -1)
START_ITER=${START_ITER:-0}
START_ITER=$((START_ITER + 1))
END_ITER=$((START_ITER + ITERATIONS - 1))

{
  echo ""
  echo "===================================================================="
  echo "Training loop start: $(date)"
  echo "iterations: $ITERATIONS  games: $GAMES  workers: $WORKERS"
  echo "epsilon: $EPSILON  window: $WINDOW  bench_every: $BENCH_EVERY"
  echo "starting at iter $START_ITER, ending at iter $END_ITER"
  echo "===================================================================="
} | tee -a "$LOG_FILE"

iteration_failed() {
  local i=$1
  local msg=$2
  echo "[iter $i] FAILED: $msg — continuing to next iteration" | tee -a "$LOG_FILE"
}

for i in $(seq $START_ITER $END_ITER); do
  ITER_TAG=$(printf '%04d' "$i")
  ITER_START=$(date +%s)

  {
    echo ""
    echo "── iter $i / $END_ITER  ($(date +%H:%M:%S)) ────────────────────"
  } | tee -a "$LOG_FILE"

  # 1. Collect
  TRAIN_FILE="$DATA_DIR/training_iter_${ITER_TAG}.jsonl"
  rm -f "$DATA_DIR/training.jsonl"
  COLLECT_SEED=$((SEED_BASE + i * 1000))
  if ! pnpm collect:parallel --games "$GAMES" --seed "$COLLECT_SEED" \
      --workers "$WORKERS" --epsilon "$EPSILON" \
      --league-size "$LEAGUE_SIZE" --league-mix "$LEAGUE_MIX" \
      --out "$DATA_DIR/training.jsonl" 2>&1 \
      | grep -E "^(  worker|.*samples →|.*ERROR|\[league\])" | tee -a "$LOG_FILE"; then
    iteration_failed "$i" "collection failed"
    continue
  fi
  if [ ! -s "$DATA_DIR/training.jsonl" ]; then
    iteration_failed "$i" "no training samples produced"
    continue
  fi
  mv "$DATA_DIR/training.jsonl" "$TRAIN_FILE"
  SAMPLES=$(wc -l < "$TRAIN_FILE")
  echo "[iter $i] collected $SAMPLES samples → $TRAIN_FILE" | tee -a "$LOG_FILE"

  # 2. Build rolling window
  RECENT_FILE="$DATA_DIR/training_recent.jsonl"
  RECENT_LIST=$(ls -t "$DATA_DIR"/training_iter_*.jsonl 2>/dev/null | head -"$WINDOW")
  cat $RECENT_LIST > "$RECENT_FILE"
  TOTAL=$(wc -l < "$RECENT_FILE")
  echo "[iter $i] training on $TOTAL samples (rolling window of $WINDOW iters)" | tee -a "$LOG_FILE"

  # 3. Train
  # batch=512 + OMP threads forces openblas to use all cores for the matmuls
  # (default batch=128 was too small for openblas to bother threading).
  # Using `env` instead of inline VAR=val to ensure the env vars actually
  # reach python3 across the pipeline + `if !` wrapping.
  TRAIN_THREADS=${TRAIN_THREADS:-8}
  export OMP_NUM_THREADS=$TRAIN_THREADS
  export OPENBLAS_NUM_THREADS=$TRAIN_THREADS
  export MKL_NUM_THREADS=$TRAIN_THREADS
  export NUMEXPR_NUM_THREADS=$TRAIN_THREADS
  # NOTE: stream python output line-by-line (no `tail` buffering it).
  # Use stdbuf to force python to line-buffer too, so the loop log shows
  # progress in real time instead of dumping at the end.
  if ! stdbuf -oL python3 -u packages/ai/scripts/train_mlp.py \
      --in "$RECENT_FILE" --out "$DATA_DIR/model.json" \
      --multi-policy --warm-start "$DATA_DIR/model.json" \
      --epochs "$TRAIN_EPOCHS" --batch 512 2>&1 \
      | grep --line-buffered -E "^(loaded|baseline|ep |saved|power-tagged|warm-)" \
      | tee -a "$LOG_FILE"; then
    iteration_failed "$i" "training failed"
    continue
  fi

  # 4. Snapshot model
  cp "$DATA_DIR/model.json" "$DATA_DIR/model_iter_${ITER_TAG}.json"

  # 5. Periodic benchmark
  if [ $((i % BENCH_EVERY)) -eq 0 ]; then
    BENCH_FILE="$DATA_DIR/bench_iter_${ITER_TAG}.json"
    echo "[iter $i] benchmarking ($BENCH_GAMES games)..." | tee -a "$LOG_FILE"
    pnpm benchmark:parallel --games "$BENCH_GAMES" --seed 100 \
        --workers "$WORKERS" --out "$BENCH_FILE" 2>&1 \
        | grep -E "^(  [a-z]+ +[0-9]|WIN|DAC|ROUNDS|AGGREGATED|ERRORS|Total wall)" \
        | tee -a "$LOG_FILE"
  fi

  ITER_END=$(date +%s)
  ELAPSED=$((ITER_END - ITER_START))
  echo "[iter $i] done in ${ELAPSED}s" | tee -a "$LOG_FILE"
done

{
  echo ""
  echo "===================================================================="
  echo "Training loop finished at $(date)"
  echo "===================================================================="
} | tee -a "$LOG_FILE"
