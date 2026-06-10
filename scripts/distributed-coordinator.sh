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
#        e. (deprecated) periodic benchmark — replaced by h2h baseline + deltas
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
#   TRAIN_EPOCHS      epochs per training pass (default 25)
#   TRAIN_THREADS     openblas threads for training (default 8)
#   BENCH_WORKERS     local sub-workers for h2h bench parallel sharder (default 14)

set -uo pipefail

WORKER_ID=${WORKER_ID:-0}
# Batch size = 2 × WORKERS so every worker process does exactly 2 games per
# batch (no idle workers, no fractional distribution). Coordinator has 16
# workers → 32 games. Worker boxes have 7 workers but use the same 32 (so
# each does ~4-5 games sequentially — fine, just slower wall clock).
GAMES_PER_BATCH=${GAMES_PER_BATCH:-16}
WORKERS=${WORKERS:-16}
# Co-training: under MaxN MCTS every game already exercises all 4 power
# value heads (each leaf eval uses all 4 perspectives, each opponent node
# selects via that power's own value). So train all 4 model_<power>.json
# heads each iter from the same self-play batch — no FOCUS_POWER, no
# rotation. Each iter loops over [xarm, gormen, tenzen, lasha] and trains
# each from its own slice of the batch.
TRAIN_THRESHOLD=${TRAIN_THRESHOLD:-40}
TRAIN_WINDOW=${TRAIN_WINDOW:-180}
TRAIN_CURATE=${TRAIN_CURATE:-1}
TRAIN_MAX_SAMPLES=${TRAIN_MAX_SAMPLES:-240000}
TRAIN_EPOCHS=${TRAIN_EPOCHS:-25}
TRAIN_THREADS=${TRAIN_THREADS:-8}
BENCH_WORKERS=${BENCH_WORKERS:-14}
# Policy-channel knobs. Non-xarm powers currently learn mostly through sparse
# MCTS policy labels; keep xarm's collection density stable and spend extra
# full-search budget on gormen/tenzen/lasha.
POLICY_FULL_SEARCH_PROB_XARM=${POLICY_FULL_SEARCH_PROB_XARM:-0.10}
POLICY_FULL_SEARCH_IMPORTANT_BONUS_XARM=${POLICY_FULL_SEARCH_IMPORTANT_BONUS_XARM:-0.20}
POLICY_FULL_SEARCH_PROB_NON_XARM=${POLICY_FULL_SEARCH_PROB_NON_XARM:-0.22}
POLICY_FULL_SEARCH_IMPORTANT_BONUS_NON_XARM=${POLICY_FULL_SEARCH_IMPORTANT_BONUS_NON_XARM:-0.35}
POLICY_ALPHA_XARM=${POLICY_ALPHA_XARM:-1.0}
POLICY_ALPHA_NON_XARM=${POLICY_ALPHA_NON_XARM:-2.0}
# Auxiliary "suppress xarm" reward shaping at MCTS selection. When > 0 and the
# acting power is non-xarm, the exploitation Q at each MCTS node becomes
#   Q = own_avg_progress - λ × xarm_avg_progress
# instead of pure own-progress MaxN. Biases g/t/l play toward retarding xarm's
# dial. Default 0 = off. Anneal toward 0 once non-xarm powers have learned
# defensive play. Suggested initial value: 0.5.
XARM_SUPPRESSION_LAMBDA=${XARM_SUPPRESSION_LAMBDA:-0}
export XARM_SUPPRESSION_LAMBDA
# Value-target blend: t = w · final_rank + (1 - w) · progress.
# Rank target: 1st 1.0 / 2nd 0.66 / 3rd 0.33 / 4th 0.0 (winners outrank
# non-winners; ties share avg rank value).
# Force-zero (override any pre-set env value). Tried twice now:
#   - w=0.75 (iter 1833+): revert cascade, close_pct collapsed.
#   - w=1.0  (iter 1940+, May 25): broke the g/t/l value-loss plateau (loss
#     descending, σ recovered 0.08→0.30) but h2h results came out bad again.
# Reverted both times. Restoring value-head variance via the target does NOT
# translate to h2h gains — the working progress lives in the policy/search
# channel, not value magnitude (see project_gtl_value_plateau). Staying on
# relative-progress (w=0); g/t/l value head plateau is accepted as benign.
RANK_BLEND_WEIGHT=0
export RANK_BLEND_WEIGHT
# Progress target geometry. "relative" keeps progress but trains on
# own-progress-vs-field instead of absolute near-threshold progress, avoiding
# the late-game target saturation where all four powers sit around 0.8+.
PROGRESS_TARGET_MODE=${PROGRESS_TARGET_MODE:-relative}
export PROGRESS_TARGET_MODE
# Extra non-xarm target penalty for xarm's clock in relative progress mode.
# g/t/l have been finishing near 50 VP while losing the dial/tie-break race.
XARM_CLOCK_PENALTY=${XARM_CLOCK_PENALTY:-0.25}
export XARM_CLOCK_PENALTY
NON_XARM_FIELD_PENALTY=${NON_XARM_FIELD_PENALTY:-0.125}
export NON_XARM_FIELD_PENALTY
# Collection-only MCTS leaf shaping: nudge early/midgame searches toward
# concentrated pre-ruin corruption projects. H2H does not read this knob.
RUIN_PRESSURE_LAMBDA=${RUIN_PRESSURE_LAMBDA:-0.08}
RUIN_PRESSURE_MAX_ROUND=${RUIN_PRESSURE_MAX_ROUND:-3}
export RUIN_PRESSURE_LAMBDA
export RUIN_PRESSURE_MAX_ROUND
# Per-power xarm value-head target. 'rank' replaces xarm's slot in the target
# array with the final-placement rank value (1.0 winner / 0.66 / 0.33 / 0.0),
# decoupling its training signal from progress-mode saturation. Other powers
# keep PROGRESS_TARGET_MODE. 'inherit' = no override.
XARM_TARGET_MODE=${XARM_TARGET_MODE:-rank}
export XARM_TARGET_MODE
WINNER_BONUS_WEIGHT=${WINNER_BONUS_WEIGHT:-0.2}
export WINNER_BONUS_WEIGHT
ALL_POWERS=(xarm gormen tenzen lasha)

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA_DIR="$ROOT/packages/ai/data"
INBOX="$DATA_DIR/inbox"
ARCHIVE="$DATA_DIR/archive"
LOG_FILE="$DATA_DIR/training_loop.log"

mkdir -p "$INBOX" "$ARCHIVE"

# H2H bench knobs.
H2H_ENABLE=${H2H_ENABLE:-1}            # h2h benches on by default; gated by
                                       # H2H_AFTER_ITERS to give training a
                                       # warm-up window before testing
H2H_EVERY_N=${H2H_EVERY_N:-3}          # run h2h every Nth iter; train-only between
H2H_AFTER_ITERS=${H2H_AFTER_ITERS:-5}  # skip h2h for the first N iters of
                                       # this coord run (relative to
                                       # START_ITER) to let demos + reset
                                       # accumulate before any promotion
H2H_TARGET_GAMES=${H2H_TARGET_GAMES:-768}  # games per power per bench cycle
H2H_GAMES_PER_BOX=${H2H_GAMES_PER_BOX:-16}   # each worker batch contributes this many
                                             # 40 bundles × 16 games = 640 target.
                                             # Smaller bundles → workers re-poll
                                             # the coord every ~3 min instead of
                                             # every ~17 min so config changes
                                             # propagate fast.
H2H_ITER=${H2H_ITER:-1000}             # MCTS iters per move during bench
H2H_WAIT_SECS=${H2H_WAIT_SECS:-1800}   # max time to wait per power for workers
ALL_POWERS=(xarm gormen tenzen lasha)
REF_DIR="$DATA_DIR/ref"

# Auto-anneal xarm suppression λ from baseline xarm win rate.
# Retired 2026-05-18: λ-shaping moved the field (xarm 61% → 47%, all three
# non-xarm powers promoted in iters 1818-1825) but has plateaued. Schedule
# kept as scaffolding for future use; currently returns 0 unconditionally.
compute_xarm_lambda() {
  local bl="$DATA_DIR/ref_baseline.json"
  if [ ! -f "$bl" ]; then return; fi
  local new_l="0.0000"
  if [ -n "$new_l" ] && [ "$new_l" != "$XARM_SUPPRESSION_LAMBDA" ]; then
    echo "[$(date +%H:%M:%S)] [coord] xarm λ: ${XARM_SUPPRESSION_LAMBDA} → ${new_l} (from baseline xarm win)" | tee -a "$LOG_FILE"
    XARM_SUPPRESSION_LAMBDA="$new_l"
    export XARM_SUPPRESSION_LAMBDA
  fi
}

# Worker dispatch: coord writes worker_config.json; workers rsync it every batch
# and dispatch on `task`. Default = collect.
write_worker_config() {
  local task="$1"
  local current_power="$2"
  python3 -c '
import json, sys
print(json.dumps({
  "task": sys.argv[1],
  "iter": int(sys.argv[2]),
  "current_power": sys.argv[3],
  "games_per_box": int(sys.argv[4]),
  "mcts_iter": int(sys.argv[5]),
  "xarm_suppression_lambda": float(sys.argv[6]),
  "rank_blend_weight": float(sys.argv[7]),
  "progress_target_mode": sys.argv[8],
  "xarm_clock_penalty": float(sys.argv[9]),
  "non_xarm_field_penalty": float(sys.argv[10]),
  "ruin_pressure_lambda": float(sys.argv[11]),
  "ruin_pressure_max_round": int(sys.argv[12]),
  "xarm_target_mode": sys.argv[13],
  "winner_bonus_weight": float(sys.argv[14]),
  "policy_full_search_prob_xarm": float(sys.argv[15]),
  "policy_full_search_important_bonus_xarm": float(sys.argv[16]),
  "policy_full_search_prob_non_xarm": float(sys.argv[17]),
  "policy_full_search_important_bonus_non_xarm": float(sys.argv[18]),
}, indent=2))' "$task" "$ITER" "$current_power" "$H2H_GAMES_PER_BOX" "$H2H_ITER" "$XARM_SUPPRESSION_LAMBDA" "$RANK_BLEND_WEIGHT" "$PROGRESS_TARGET_MODE" "$XARM_CLOCK_PENALTY" "$NON_XARM_FIELD_PENALTY" "$RUIN_PRESSURE_LAMBDA" "$RUIN_PRESSURE_MAX_ROUND" "$XARM_TARGET_MODE" "$WINNER_BONUS_WEIGHT" "$POLICY_FULL_SEARCH_PROB_XARM" "$POLICY_FULL_SEARCH_IMPORTANT_BONUS_XARM" "$POLICY_FULL_SEARCH_PROB_NON_XARM" "$POLICY_FULL_SEARCH_IMPORTANT_BONUS_NON_XARM" \
    > "$DATA_DIR/worker_config.json"
}

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
BATCH_COUNTER=0

# Initialize worker config (now that ITER is defined). Workers read this on
# their next loop iteration and dispatch on the `task` field.
compute_xarm_lambda
write_worker_config "collect" ""

{
  echo ""
  echo "===================================================================="
  echo "Distributed coordinator start: $(date)"
  echo "  WORKER_ID:        $WORKER_ID"
  echo "  GAMES_PER_BATCH:  $GAMES_PER_BATCH"
  echo "  WORKERS:          $WORKERS"
  echo "  TRAIN_THRESHOLD:  $TRAIN_THRESHOLD files in inbox"
  echo "  TARGET_MODE:      $PROGRESS_TARGET_MODE"
  echo "  XARM_CLOCK_PEN:   $XARM_CLOCK_PENALTY  field=$NON_XARM_FIELD_PENALTY"
  echo "  WINNER_BONUS:     $WINNER_BONUS_WEIGHT"
  echo "  RUIN_PRESSURE:    λ=$RUIN_PRESSURE_LAMBDA through round $RUIN_PRESSURE_MAX_ROUND"
  echo "  POLICY_SEARCH:    xarm=$POLICY_FULL_SEARCH_PROB_XARM+$POLICY_FULL_SEARCH_IMPORTANT_BONUS_XARM non-xarm=$POLICY_FULL_SEARCH_PROB_NON_XARM+$POLICY_FULL_SEARCH_IMPORTANT_BONUS_NON_XARM"
  echo "  POLICY_ALPHA:     xarm=$POLICY_ALPHA_XARM non-xarm=$POLICY_ALPHA_NON_XARM"
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

  # Refresh xarm suppression λ from the latest baseline, then re-publish the
  # worker config so workers see the new value on their next config pull.
  PREV_LAMBDA="$XARM_SUPPRESSION_LAMBDA"
  compute_xarm_lambda
  if [ "$PREV_LAMBDA" != "$XARM_SUPPRESSION_LAMBDA" ]; then
    write_worker_config "collect" ""
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
  if ! pnpm collect:parallel --games "$GAMES_PER_BATCH" --seed "$SEED" \
      --workers "$WORKERS" \
      --dirichlet-weight 0.25 \
      --full-search-prob "$POLICY_FULL_SEARCH_PROB_XARM" \
      --full-search-important-bonus "$POLICY_FULL_SEARCH_IMPORTANT_BONUS_XARM" \
      --full-search-prob-non-xarm "$POLICY_FULL_SEARCH_PROB_NON_XARM" \
      --full-search-important-bonus-non-xarm "$POLICY_FULL_SEARCH_IMPORTANT_BONUS_NON_XARM" \
      --hof-mix 0.15 \
      --temp-rounds 3 \
      --iter 1000 \
      --out "$DATA_DIR/training.jsonl" 2>&1 \
      | grep -E "^(  worker|.*samples →)" | tee -a "$LOG_FILE"; then
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
  # Then optionally curate that raw window into a quota-balanced set. The
  # curator is metadata-aware, but it can also fall back to legacy rows.
  RECENT_FILE="$DATA_DIR/training_recent.jsonl"
  RAW_RECENT_FILE="$DATA_DIR/training_recent_raw.jsonl"
  # Start with all new data (inbox)
  cat "$INBOX"/*.jsonl > "$RAW_RECENT_FILE"
  NEW_COUNT=$INBOX_COUNT
  # Fill remaining window slots from most-recent archive files
  FILL_COUNT=$((TRAIN_WINDOW - NEW_COUNT))
  if [ "$FILL_COUNT" -gt 0 ]; then
    OLD_FILES=$(ls -t "$ARCHIVE"/*.jsonl 2>/dev/null | head -"$FILL_COUNT")
    if [ -n "$OLD_FILES" ]; then
      echo "$OLD_FILES" | while read -r f; do cat "$f"; done >> "$RAW_RECENT_FILE"
      OLD_USED=$(echo "$OLD_FILES" | wc -l | tr -d ' ')
      echo "  · padded with ${OLD_USED} archive batches (window ${TRAIN_WINDOW})" | tee -a "$LOG_FILE"
    fi
  fi
  if [ "$TRAIN_CURATE" = "1" ]; then
    CURATE_REPORT="$DATA_DIR/training_recent_report.json"
    if python3 packages/ai/scripts/curate_training.py \
        --in "$RAW_RECENT_FILE" \
        --out "$RECENT_FILE" \
        --max-samples "$TRAIN_MAX_SAMPLES" \
        --seed "$ITER" \
        --report "$CURATE_REPORT" 2>&1 | tee -a "$LOG_FILE"; then
      :
    else
      echo "  ! curation failed; falling back to raw recent window" | tee -a "$LOG_FILE"
      cp "$RAW_RECENT_FILE" "$RECENT_FILE"
    fi
  else
    cp "$RAW_RECENT_FILE" "$RECENT_FILE"
  fi
  TOTAL=$(wc -l < "$RECENT_FILE")
  echo "[iter $ITER] training on ${TOTAL} samples (${NEW_COUNT} new + archive fill)" | tee -a "$LOG_FILE"


  # 3b. Train all 4 power heads from the same batch. Each train_mlp.py
  # invocation filters samples to that power and updates only its own
  # model_<power>.json. Sequential to keep CPU usage bounded.
  DATA_GEN_ITER=$((ITER - 1))
  TRAIN_OK=1
  for POWER in "${ALL_POWERS[@]}"; do
    T2=$(date +%s)
    TRAIN_OUT="$DATA_DIR/model_${POWER}.json"
    WARM_SRC="$DATA_DIR/model_${POWER}.json"
    [ ! -f "$WARM_SRC" ] && WARM_SRC="$DATA_DIR/model.json"
    # Tenzen + lasha run on a wider trunk (1024/256) — bigger brain. Tenzen
    # was promoted after a production warm-start basin proved to inflate
    # value-head MAE by 33% vs fresh init on the same data; lasha promoted
    # 2026-05-03 after an extended 0.06–0.23 oscillation. Lasha gets a
    # one-time fresh start (empty warm-start) — the existing 512/128
    # checkpoint can't be reused at the new width anyway.
    HIDDEN_ARGS=()
    case "$POWER" in
      tenzen|lasha) HIDDEN_ARGS=(--hidden1 1024 --hidden2 256) ;;
    esac
    # Skip warm-start when the saved model exists but its architecture
    # doesn't match the current --hidden{1,2}. For now this only fires for
    # lasha during the 512/128 → 1024/256 transition; once a wide-trunk
    # model_lasha.json is saved, warm-start resumes naturally.
    EFFECTIVE_WARM="$WARM_SRC"
    if [ "$POWER" = "lasha" ] && [ -f "$WARM_SRC" ]; then
      OLD_H1=$(python3 -c "import json,sys
m=json.load(open(sys.argv[1]))
ls=m.get('layers',[])
print(len(ls[0]['W'][0]) if ls else 0)" "$WARM_SRC" 2>/dev/null)
      if [ "$OLD_H1" != "1024" ]; then
        EFFECTIVE_WARM=""
        echo "[iter $ITER] lasha: skipping warm-start (old h1=${OLD_H1}, want 1024) — fresh init" | tee -a "$LOG_FILE"
      fi
    fi
    # Operator-driven one-shot fresh init: if data/fresh_powers exists and
    # contains this power name, drop warm-start. File is cleared after the
    # train step so the fresh init only fires once.
    FRESH_FILE="$DATA_DIR/fresh_powers"
    if [ -f "$FRESH_FILE" ] && grep -qw "$POWER" "$FRESH_FILE"; then
      EFFECTIVE_WARM=""
      echo "[iter $ITER] $POWER: fresh init (matched fresh_powers)" | tee -a "$LOG_FILE"
    fi
    POLICY_ALPHA="$POLICY_ALPHA_XARM"
    case "$POWER" in
      gormen|tenzen|lasha) POLICY_ALPHA="$POLICY_ALPHA_NON_XARM" ;;
    esac
    if ! stdbuf -oL python3 -u packages/ai/scripts/train_mlp.py \
        --in "$RECENT_FILE" --out "$TRAIN_OUT" \
        --iter "$ITER" --power "$POWER" --warm-start "$EFFECTIVE_WARM" \
        --scalar-value --lr 5e-4 --policy-alpha "$POLICY_ALPHA" \
        --epochs "$TRAIN_EPOCHS" --batch 512 \
        "${HIDDEN_ARGS[@]}" 2>&1 \
        | grep --line-buffered -E "^(loaded|baseline|ep |saved|class |avg rank|reweight|policy rows|policy alpha|avg target|--power|warm-)" \
        | tee -a "$LOG_FILE"; then
      echo "  ! training failed for $POWER" | tee -a "$LOG_FILE"
      TRAIN_OK=0
      break
    fi
    T3=$(date +%s)
    cp "$TRAIN_OUT" "$DATA_DIR/model_${POWER}_iter_${ITER_TAG}.json"
    echo "[iter $ITER] $POWER trained in $((T3 - T2))s → model_${POWER}.json" | tee -a "$LOG_FILE"
    # HOF promotion is no longer driven by avg-rank from training. The h2h
    # phase below is the sole gate: a model joins the HOF for its power only
    # when it beats the ref baseline by H2H_PROMOTE_DELTA. Avoids polluting
    # the HOF with marginal/regressed iters that pass training metrics but
    # fail head-to-head against the known-good ref set.
  done
  [ "$TRAIN_OK" -ne 1 ] && continue

  # Consume one-shot fresh_powers marker after all powers trained.
  if [ -f "$DATA_DIR/fresh_powers" ]; then
    rm -f "$DATA_DIR/fresh_powers"
    echo "[iter $ITER] consumed fresh_powers marker" | tee -a "$LOG_FILE"
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

  # 3e. (Removed 2026-05-03) periodic benchmark:parallel was redundant with
  # the h2h baseline below — both measure 4-way self-play win rates among
  # the current ref set. ref_baseline.json plus per-iter h2h deltas serve
  # the same role with finer per-power resolution.

  # 3f. H2H bench cycle. For each power P, swap workers to bench_h2h mode,
  # contribute coord's own batch, wait for cluster to reach target games,
  # aggregate. Workers see the task switch via worker_config.json (rsynced
  # at the top of their loop) and dispatch to bench-h2h-parallel.ts.
  #
  # Compares against ref_baseline.json (all-ref self-play). Per-power, if
  # current win rate exceeds baseline + H2H_PROMOTE_DELTA, the candidate is
  # promoted: cp model_<P>.json → ref/model_<P>_ref.json. Any promotion
  # invalidates the baseline (deletes ref_baseline.json) so the next cycle
  # re-runs baseline calibration with the new ref set.
  # Three-band rule: Δ ≥ +PROMOTE_DELTA → promote, Δ < -REVERT_DELTA → revert,
  # otherwise hold (keep candidate live so training continues from current
  # weights). Same threshold for all powers.
  H2H_PROMOTE_DELTA=${H2H_PROMOTE_DELTA:-0.02}
  H2H_REVERT_DELTA=${H2H_REVERT_DELTA:-0.02}
  H2H_PROMOTE_DELTA_WIN_OTHER=${H2H_PROMOTE_DELTA_WIN_OTHER:-0.04}
  H2H_PROMOTE_DELTA_VP=${H2H_PROMOTE_DELTA_VP:-1.0}
  # Verdict floor: below this many games no promote/revert fires (and no
  # baseline is written) — a stalled cluster must not revert a good candidate
  # on near-zero evidence.
  H2H_MIN_GAMES=${H2H_MIN_GAMES:-256}
  # Sequential early stop: once past the floor, stop a power's bench as soon
  # as the verdict is statistically resolved at z× the combined standard
  # error. Clear promotes/reverts resolve in a fraction of the target games;
  # only genuinely borderline candidates spend the full budget.
  H2H_EARLY_STOP_Z=${H2H_EARLY_STOP_Z:-2.5}
  # After a single-power promotion, the promoted power's h2h aggregate already
  # measured exactly the new ref set; reuse it as the baseline (skipping the
  # ~25 min recalibration) if it has at least this many games.
  H2H_BASELINE_REUSE_MIN_GAMES=${H2H_BASELINE_REUSE_MIN_GAMES:-512}
  REF_BASELINE_FILE="$DATA_DIR/ref_baseline.json"

  if [ "$H2H_ENABLE" = "1" ] && [ -d "$REF_DIR" ] && [ "$((ITER - START_ITER))" -gt "$H2H_AFTER_ITERS" ] && [ "$((ITER % H2H_EVERY_N))" -eq 0 ]; then
    # 3f.0. Ensure baseline exists. Distributed: workers + coord all
    # contribute to bench_inbox_baseline/, coord aggregates.
    if [ ! -f "$REF_BASELINE_FILE" ]; then
      BL_INBOX="$DATA_DIR/bench_inbox_baseline"
      rm -rf "$BL_INBOX"
      mkdir -p "$BL_INBOX"

      write_worker_config "bench_baseline" ""
      BL_T0=$(date +%s)
      BL_SEED_BASE=$((900000 + ITER * 1000))
      echo "[iter $ITER] baseline: contributing batches alongside workers, target ${H2H_TARGET_GAMES} games..." | tee -a "$LOG_FILE"

      # Coord keeps running its own bench batches while workers contribute,
      # rather than running one batch and idling. Each coord batch = 16
      # games / ~3 min with native MLP. Workers upload async to the same
      # bench_inbox_baseline/. Loop ends when total games >= target or we
      # exceed the wait timeout.
      WAIT_T0=$(date +%s)
      BL_BATCH=0
      while true; do
        TOTAL=$(python3 -c "
import json, glob
t = 0
for f in glob.glob('${BL_INBOX}/*.json'):
  try: t += json.load(open(f)).get('games', 0)
  except: pass
print(t)" 2>/dev/null || echo 0)
        [ "$TOTAL" -ge "$H2H_TARGET_GAMES" ] && break
        WAITED=$(($(date +%s) - WAIT_T0))
        if [ "$WAITED" -gt "$H2H_WAIT_SECS" ]; then
          echo "  ! baseline: timeout at ${TOTAL}/${H2H_TARGET_GAMES} games (waited ${WAITED}s)" | tee -a "$LOG_FILE"
          break
        fi
        BL_BATCH=$((BL_BATCH + 1))
        BL_SEED=$((BL_SEED_BASE + BL_BATCH * 100))
        BL_OUT="${BL_INBOX}/coord_b$(printf '%03d' "$BL_BATCH")_$(date +%s).json"
        if ! npx tsx packages/server/src/scripts/bench-h2h-parallel.ts \
            --baseline \
            --games "$H2H_GAMES_PER_BOX" --seed "$BL_SEED" \
            --iter "$H2H_ITER" --workers "$BENCH_WORKERS" \
            --ref-dir "$REF_DIR" \
            --out "$BL_OUT" 2>&1 \
            | grep -E "^baseline" \
            | tee -a "$LOG_FILE"; then
          echo "  ! coord baseline batch ${BL_BATCH} failed — sleeping" | tee -a "$LOG_FILE"
          sleep 10
        fi
      done

      # Aggregate baseline shards → ref_baseline.json. Refuses to write below
      # the H2H_MIN_GAMES floor: a garbage near-zero baseline would make every
      # subsequent candidate trivially "promote" until a human notices.
      python3 -c "
import json, glob, sys
out = sys.argv[1]
inbox = sys.argv[2]
itr = int(sys.argv[3])
min_games = int(sys.argv[4])
import math
agg = {'games':0, 'completed':0, 'no_winners':0, 'co_wins':0,
       'wins': {'xarm':0,'gormen':0,'tenzen':0,'lasha':0},
       'vp_w': {'xarm':0,'gormen':0,'tenzen':0,'lasha':0},
       'vp_sq_w': {'xarm':0,'gormen':0,'tenzen':0,'lasha':0},
       'dial_w': {'xarm':0,'gormen':0,'tenzen':0,'lasha':0},
       'dial_sq_w': {'xarm':0,'gormen':0,'tenzen':0,'lasha':0},
       'rounds_w': 0, 'shards': []}
for f in sorted(glob.glob(f'{inbox}/*.json')):
    try:
        d = json.load(open(f))
        agg['games'] += d['games']
        agg['completed'] += d['completed']
        agg['no_winners'] += d['no_winners']
        agg['co_wins'] += d['co_wins']
        for p in agg['wins']: agg['wins'][p] += d['wins'].get(p, 0)
        for p in agg['vp_w']:
            m = d['vp_mean'].get(p, 0)
            s = d.get('vp_stdev', {}).get(p, 0)
            agg['vp_w'][p] += m * d['games']
            agg['vp_sq_w'][p] += (s*s + m*m) * d['games']
        for p in agg['dial_w']:
            m = d.get('dial_mean', {}).get(p, 0)
            s = d.get('dial_stdev', {}).get(p, 0)
            agg['dial_w'][p] += m * d['games']
            agg['dial_sq_w'][p] += (s*s + m*m) * d['games']
        agg['rounds_w'] += d['avg_rounds'] * d['games']
        agg['shards'].append(f.split('/')[-1])
    except Exception as e:
        print(f'shard {f}: {e}', file=sys.stderr)
if agg['games'] < min_games:
    print(f'[baseline] ERROR: only {agg[\"games\"]} games (< {min_games}) — refusing to write baseline')
    sys.exit(1)
g = agg['games'] or 1
agg['win_rates'] = {p: agg['wins'][p]/g for p in agg['wins']}
agg['vp_mean'] = {p: agg['vp_w'][p]/g for p in agg['vp_w']}
agg['vp_stdev'] = {p: math.sqrt(max(0, agg['vp_sq_w'][p]/g - agg['vp_mean'][p]**2)) for p in agg['vp_w']}
agg['dial_mean'] = {p: agg['dial_w'][p]/g for p in agg['dial_w']}
agg['dial_stdev'] = {p: math.sqrt(max(0, agg['dial_sq_w'][p]/g - agg['dial_mean'][p]**2)) for p in agg['dial_w']}
agg['avg_rounds'] = agg['rounds_w'] / g
del agg['vp_w']; del agg['vp_sq_w']; del agg['dial_w']; del agg['dial_sq_w']; del agg['rounds_w']
agg['baseline'] = True
agg['iter'] = itr
open(out, 'w').write(json.dumps(agg, indent=2))
print(f'[baseline] {agg[\"games\"]} games | xarm:{agg[\"win_rates\"][\"xarm\"]*100:.1f}% gormen:{agg[\"win_rates\"][\"gormen\"]*100:.1f}% tenzen:{agg[\"win_rates\"][\"tenzen\"]*100:.1f}% lasha:{agg[\"win_rates\"][\"lasha\"]*100:.1f}% | rounds={agg[\"avg_rounds\"]:.2f} | {len(agg[\"shards\"])} shards')
" "$REF_BASELINE_FILE" "$BL_INBOX" "$ITER" "$H2H_MIN_GAMES" 2>&1 | tee -a "$LOG_FILE"

      BL_T1=$(date +%s)
      echo "[iter $ITER] baseline calibrated in $((BL_T1 - BL_T0))s" | tee -a "$LOG_FILE"
    fi

    # If calibration failed (timeout below the floor, aggregation error), the
    # h2h block below is skipped — make sure workers don't stay stuck grinding
    # baseline batches forever.
    if [ ! -f "$REF_BASELINE_FILE" ]; then
      echo "[iter $ITER] baseline calibration failed — skipping h2h cycle, returning workers to collect" | tee -a "$LOG_FILE"
      write_worker_config "collect" ""
    fi
  fi

  if [ "$H2H_ENABLE" = "1" ] && [ -f "$REF_BASELINE_FILE" ] && [ "$((ITER - START_ITER))" -gt "$H2H_AFTER_ITERS" ] && [ "$((ITER % H2H_EVERY_N))" -eq 0 ]; then
    echo "[iter $ITER] h2h cycle (target=${H2H_TARGET_GAMES}/power, iter=${H2H_ITER})" | tee -a "$LOG_FILE"
    for POWER in "${ALL_POWERS[@]}"; do
      BENCH_INBOX="$DATA_DIR/bench_inbox_${POWER}"
      rm -rf "$BENCH_INBOX"
      mkdir -p "$BENCH_INBOX"

      write_worker_config "bench_h2h" "$POWER"
      H2H_T0=$(date +%s)
      H2H_SEED_BASE=$((100000 + ITER * 1000))
      echo "[iter $ITER] h2h ${POWER}: contributing batches alongside workers, target ${H2H_TARGET_GAMES} games..." | tee -a "$LOG_FILE"

      # Same loop pattern as baseline: coord keeps producing 16-game batches
      # while workers also upload, instead of running once and idling.
      # Sequential early stop: poll the running Δwin/Δvp against baseline and
      # stop as soon as the verdict can no longer change (CI at
      # H2H_EARLY_STOP_Z × SE entirely inside one verdict region), once past
      # the H2H_MIN_GAMES floor. The verdict python below recomputes on the
      # same shards, so the early verdict equals the full-budget verdict.
      WAIT_T0=$(date +%s)
      H2H_BATCH=0
      while true; do
        POLL=$(python3 -c "
import json, glob, math, sys
inbox, basefile, power = sys.argv[1], sys.argv[2], sys.argv[3]
min_games, z = int(sys.argv[4]), float(sys.argv[5])
p_xarm, p_win_other, p_vp, r_thr = map(float, sys.argv[6:10])
g = 0; wins = 0; vp_w = 0.0; vp_sq = 0.0
for f in glob.glob(inbox + '/*.json'):
    try:
        d = json.load(open(f))
        g += d['games']; wins += d['wins'].get(power, 0)
        m = d['vp_mean'].get(power, 0.0); s = d.get('vp_stdev', {}).get(power, 0.0)
        vp_w += m * d['games']; vp_sq += (s*s + m*m) * d['games']
    except Exception: pass
resolved = 0
if g >= min_games:
    try:
        base = json.load(open(basefile))
        bg = max(1, base.get('games', 1))
        bw = base['win_rates'].get(power, 0.0)
        bvp = base.get('vp_mean', {}).get(power, 0.0)
        bvs = base.get('vp_stdev', {}).get(power, 0.0)
        cw = wins / g
        dwin = cw - bw
        ci_w = z * math.sqrt(cw*(1-cw)/g + bw*(1-bw)/bg)
        cvp = vp_w / g
        cvs = math.sqrt(max(0.0, vp_sq/g - cvp*cvp))
        dvp = cvp - bvp
        ci_v = z * math.sqrt(cvs*cvs/g + bvs*bvs/bg)
        promote_thr = p_xarm if power == 'xarm' else p_win_other
        # Clear promote on either channel ends the bench regardless of the
        # other thresholds (verdict python checks promote first too).
        clear_promote = (dwin - ci_w >= promote_thr) or (power != 'xarm' and dvp - ci_v >= p_vp)
        # Otherwise every threshold the verdict consults must be resolved:
        # the CI sits entirely on one side of it.
        win_side = (dwin - ci_w >= promote_thr) or (dwin + ci_w < promote_thr)
        revert_side = (dwin - ci_w >= -r_thr) or (dwin + ci_w < -r_thr)
        vp_side = power == 'xarm' or (dvp - ci_v >= p_vp) or (dvp + ci_v < p_vp)
        resolved = 1 if (clear_promote or (win_side and revert_side and vp_side)) else 0
    except Exception:
        resolved = 0
print(f'{g} {resolved}')" \
          "$BENCH_INBOX" "$REF_BASELINE_FILE" "$POWER" \
          "$H2H_MIN_GAMES" "$H2H_EARLY_STOP_Z" \
          "$H2H_PROMOTE_DELTA" "$H2H_PROMOTE_DELTA_WIN_OTHER" "$H2H_PROMOTE_DELTA_VP" "$H2H_REVERT_DELTA" \
          2>/dev/null || echo "0 0")
        TOTAL=$(echo "$POLL" | awk '{print $1}')
        RESOLVED=$(echo "$POLL" | awk '{print $2}')
        [ "$TOTAL" -ge "$H2H_TARGET_GAMES" ] && break
        if [ "$RESOLVED" = "1" ]; then
          echo "  · h2h ${POWER}: early stop at ${TOTAL} games — verdict resolved at z=${H2H_EARLY_STOP_Z}" | tee -a "$LOG_FILE"
          break
        fi
        WAITED=$(($(date +%s) - WAIT_T0))
        if [ "$WAITED" -gt "$H2H_WAIT_SECS" ]; then
          echo "  ! h2h ${POWER}: timeout at ${TOTAL}/${H2H_TARGET_GAMES} games (waited ${WAITED}s)" | tee -a "$LOG_FILE"
          break
        fi
        H2H_BATCH=$((H2H_BATCH + 1))
        H2H_SEED=$((H2H_SEED_BASE + H2H_BATCH * 100))
        H2H_OUT="${BENCH_INBOX}/coord_b$(printf '%03d' "$H2H_BATCH")_$(date +%s).json"
        if ! npx tsx packages/server/src/scripts/bench-h2h-parallel.ts \
            --current-power "$POWER" \
            --games "$H2H_GAMES_PER_BOX" --seed "$H2H_SEED" \
            --iter "$H2H_ITER" --workers "$BENCH_WORKERS" \
            --ref-dir "$REF_DIR" \
            --out "$H2H_OUT" 2>&1 \
            | grep -E "^${POWER}:" \
            | tee -a "$LOG_FILE"; then
          echo "  ! coord h2h ${POWER} batch ${H2H_BATCH} failed — sleeping" | tee -a "$LOG_FILE"
          sleep 10
        fi
      done

      # Aggregate.
      AGG_OUT="$DATA_DIR/bench_h2h_iter_${ITER_TAG}_${POWER}.json"
      python3 -c "
import json, glob, sys
power = sys.argv[1]
out = sys.argv[2]
inbox = sys.argv[3]
itr = int(sys.argv[4])
import math
agg = {'games':0, 'completed':0, 'no_winners':0, 'co_wins':0,
       'wins': {'xarm':0,'gormen':0,'tenzen':0,'lasha':0},
       'vp_w': {'xarm':0,'gormen':0,'tenzen':0,'lasha':0},
       'vp_sq_w': {'xarm':0,'gormen':0,'tenzen':0,'lasha':0},
       'dial_w': {'xarm':0,'gormen':0,'tenzen':0,'lasha':0},
       'dial_sq_w': {'xarm':0,'gormen':0,'tenzen':0,'lasha':0},
       'rounds_w': 0, 'shards': []}
for f in sorted(glob.glob(f'{inbox}/*.json')):
    try:
        d = json.load(open(f))
        agg['games'] += d['games']
        agg['completed'] += d['completed']
        agg['no_winners'] += d['no_winners']
        agg['co_wins'] += d['co_wins']
        for p in agg['wins']: agg['wins'][p] += d['wins'].get(p, 0)
        for p in agg['vp_w']:
            m = d['vp_mean'].get(p, 0)
            s = d.get('vp_stdev', {}).get(p, 0)
            agg['vp_w'][p] += m * d['games']
            agg['vp_sq_w'][p] += (s*s + m*m) * d['games']
        for p in agg['dial_w']:
            m = d.get('dial_mean', {}).get(p, 0)
            s = d.get('dial_stdev', {}).get(p, 0)
            agg['dial_w'][p] += m * d['games']
            agg['dial_sq_w'][p] += (s*s + m*m) * d['games']
        agg['rounds_w'] += d['avg_rounds'] * d['games']
        agg['shards'].append(f.split('/')[-1])
    except Exception as e:
        print(f'shard {f}: {e}', file=sys.stderr)
g = agg['games'] or 1
agg['win_rates'] = {p: agg['wins'][p]/g for p in agg['wins']}
agg['vp_mean'] = {p: agg['vp_w'][p]/g for p in agg['vp_w']}
agg['vp_stdev'] = {p: math.sqrt(max(0, agg['vp_sq_w'][p]/g - agg['vp_mean'][p]**2)) for p in agg['vp_w']}
agg['dial_mean'] = {p: agg['dial_w'][p]/g for p in agg['dial_w']}
agg['dial_stdev'] = {p: math.sqrt(max(0, agg['dial_sq_w'][p]/g - agg['dial_mean'][p]**2)) for p in agg['dial_w']}
agg['avg_rounds'] = agg['rounds_w'] / g
del agg['vp_w']; del agg['vp_sq_w']; del agg['dial_w']; del agg['dial_sq_w']; del agg['rounds_w']
agg['current_power'] = power
agg['iter'] = itr
open(out, 'w').write(json.dumps(agg, indent=2))
print(f'[h2h ${POWER}] {agg[\"games\"]} games | win_rate={agg[\"win_rates\"][power]*100:.1f}% | rounds={agg[\"avg_rounds\"]:.2f} | {len(agg[\"shards\"])} shards')
" "$POWER" "$AGG_OUT" "$BENCH_INBOX" "$ITER" 2>&1 | tee -a "$LOG_FILE"

      H2H_T1=$(date +%s)
      echo "[iter $ITER] h2h ${POWER}: $((H2H_T1 - H2H_T0))s total" | tee -a "$LOG_FILE"
    done

    # Promotion phase. Per power, compare current to baseline.
    #
    # xarm: win-rate gated (Δwin ≥ H2H_PROMOTE_DELTA). xarm's win condition
    # is dial-based; vp is a side-effect, so win-rate is the meaningful signal.
    #
    # gormen/tenzen/lasha: promote on EITHER Δwin ≥ H2H_PROMOTE_DELTA_WIN_OTHER
    # (a clear win-rate jump) OR Δvp ≥ H2H_PROMOTE_DELTA_VP (vp_mean is ~6×
    # more sensitive than win-rate at this sample size, so a small Δvp is real
    # progress even when wins haven't tipped). This avoids missing real field
    # improvement that doesn't yet beat xarm's dial timing.
    #
    # Revert is win-rate based for all powers (Δwin < -H2H_REVERT_DELTA).
    ANY_PROMOTED=0
    PROMOTED_POWERS=()
    for POWER in "${ALL_POWERS[@]}"; do
      AGG_OUT="$DATA_DIR/bench_h2h_iter_${ITER_TAG}_${POWER}.json"
      [ ! -f "$AGG_OUT" ] && continue
      DECISION=$(python3 -c "
import json, sys
power = sys.argv[1]
agg = json.load(open(sys.argv[2]))
base = json.load(open(sys.argv[3]))
promote_thr_xarm = float(sys.argv[4])
promote_thr_win_other = float(sys.argv[5])
promote_thr_vp = float(sys.argv[6])
revert_thr = float(sys.argv[7])
min_games = int(sys.argv[8])
games = int(agg.get('games', 0))
cur = agg['win_rates'].get(power, 0.0)
bl = base['win_rates'].get(power, 0.0)
delta = cur - bl
cur_vp = agg.get('vp_mean', {}).get(power, 0.0)
bl_vp = base.get('vp_mean', {}).get(power, 0.0)
delta_vp = cur_vp - bl_vp
if power == 'xarm':
    promote = delta >= promote_thr_xarm
else:
    promote = (delta >= promote_thr_win_other) or (delta_vp >= promote_thr_vp)
if games < min_games:
    # Too few games for any verdict — never promote or (worse) revert a
    # candidate on a stalled cluster's near-zero sample.
    verdict = 'SKIP'
elif promote:
    verdict = 'PROMOTE'
elif delta < -revert_thr:
    verdict = 'REVERT'
else:
    verdict = 'HOLD'
print(f'{verdict}|{cur:.4f}|{bl:.4f}|{delta:+.4f}|{cur_vp:.2f}|{bl_vp:.2f}|{delta_vp:+.2f}|{games}')
" "$POWER" "$AGG_OUT" "$REF_BASELINE_FILE" "$H2H_PROMOTE_DELTA" "$H2H_PROMOTE_DELTA_WIN_OTHER" "$H2H_PROMOTE_DELTA_VP" "$H2H_REVERT_DELTA" "$H2H_MIN_GAMES" 2>>"$LOG_FILE")
      VERDICT=$(echo "$DECISION" | cut -d'|' -f1)
      CUR=$(echo "$DECISION" | cut -d'|' -f2)
      BL=$(echo "$DECISION" | cut -d'|' -f3)
      DELTA=$(echo "$DECISION" | cut -d'|' -f4)
      CUR_VP=$(echo "$DECISION" | cut -d'|' -f5)
      BL_VP=$(echo "$DECISION" | cut -d'|' -f6)
      DELTA_VP=$(echo "$DECISION" | cut -d'|' -f7)
      CUR_GAMES=$(echo "$DECISION" | cut -d'|' -f8)
      if [ -z "$VERDICT" ]; then
        # Decision script crashed (corrupt baseline/aggregate). Hold the
        # candidate but say so loudly — a silent empty verdict here used to
        # disable the entire gate until a human noticed.
        echo "[iter $ITER] ERROR ${POWER}: verdict computation failed (see log for python stderr) — holding candidate" | tee -a "$LOG_FILE"
      elif [ "$VERDICT" = "SKIP" ]; then
        echo "[iter $ITER] skip ${POWER}: only ${CUR_GAMES} games (< ${H2H_MIN_GAMES}) — no verdict, holding candidate" | tee -a "$LOG_FILE"
      elif [ "$VERDICT" = "PROMOTE" ]; then
        cp "$DATA_DIR/model_${POWER}.json" "$REF_DIR/model_${POWER}_ref.json"
        echo "[iter $ITER] promote ${POWER}: cur=${CUR} > base=${BL} (Δ=${DELTA}) vp=${CUR_VP} vs ${BL_VP} (Δvp=${DELTA_VP}, ${CUR_GAMES}g) → ref updated" | tee -a "$LOG_FILE"
        ANY_PROMOTED=1
        PROMOTED_POWERS+=("$POWER")

        # HOF entry: only h2h-promoted models. Use the h2h win rate as the
        # rank, --min-rank 0.0 so the gate is purely the h2h verdict above.
        # Source snapshot is this iter's just-trained model_<P>_iter_NNNN.json.
        if [ -f "$DATA_DIR/model_${POWER}_iter_${ITER_TAG}.json" ]; then
          python3 "$ROOT/scripts/hof-promote.py" \
            --iter "$ITER" --rank "$CUR" --power "$POWER" \
            --min-rank 0.0 \
            --data-dir "$DATA_DIR" 2>&1 | tee -a "$LOG_FILE"
        fi
      elif [ "$VERDICT" = "REVERT" ]; then
        cp "$REF_DIR/model_${POWER}_ref.json" "$DATA_DIR/model_${POWER}.json"
        echo "[iter $ITER] revert ${POWER}: cur=${CUR} vs base=${BL} (Δ=${DELTA}) vp=${CUR_VP} vs ${BL_VP} (Δvp=${DELTA_VP}) → reverted to ref" | tee -a "$LOG_FILE"
      else
        # HOLD: candidate stayed close to baseline. Keep it live so training
        # continues from current weights instead of snapping back to ref.
        echo "[iter $ITER] hold ${POWER}: cur=${CUR} vs base=${BL} (Δ=${DELTA}) vp=${CUR_VP} vs ${BL_VP} (Δvp=${DELTA_VP}) → kept" | tee -a "$LOG_FILE"
      fi
    done

    # If any promotion changed the ref set, archive the baseline (so we keep
    # the history of how the ref-vs-ref equilibrium has shifted) and then
    # invalidate so the next h2h cycle recalibrates against the new lineup.
    if [ "$ANY_PROMOTED" = "1" ]; then
      if [ -f "$REF_BASELINE_FILE" ]; then
        BL_ITER=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['iter'])" "$REF_BASELINE_FILE" 2>/dev/null || echo "$ITER")
        cp "$REF_BASELINE_FILE" "$DATA_DIR/ref_baseline_iter_$(printf '%04d' "$BL_ITER").json"
      fi
      rm -f "$REF_BASELINE_FILE"

      # Single-power promotion: the promoted power's h2h aggregate measured
      # candidate-P against the 3 unchanged refs — exactly the population the
      # new ref set forms — so it IS the new ref-vs-ref baseline. Reuse it
      # (skipping ~25 min of recalibration) when it has enough games; an
      # early-stopped short run or a multi-power promotion still recalibrates.
      if [ "${#PROMOTED_POWERS[@]}" -eq 1 ]; then
        PROMOTED_P="${PROMOTED_POWERS[0]}"
        PROMOTED_AGG="$DATA_DIR/bench_h2h_iter_${ITER_TAG}_${PROMOTED_P}.json"
        python3 -c "
import json, sys
src, out = sys.argv[1], sys.argv[2]
itr, min_games = int(sys.argv[3]), int(sys.argv[4])
agg = json.load(open(src))
if agg.get('games', 0) < min_games:
    print(f'[baseline] promoted aggregate has only {agg.get(\"games\", 0)} games (< {min_games}) — will recalibrate')
    sys.exit(0)
agg.pop('current_power', None)
agg['baseline'] = True
agg['baseline_source'] = src.split('/')[-1]
agg['iter'] = itr
open(out, 'w').write(json.dumps(agg, indent=2))
print(f'[baseline] reused {agg[\"games\"]}-game h2h aggregate as new baseline')
" "$PROMOTED_AGG" "$REF_BASELINE_FILE" "$ITER" "$H2H_BASELINE_REUSE_MIN_GAMES" 2>&1 | tee -a "$LOG_FILE"
      fi

      if [ -f "$REF_BASELINE_FILE" ]; then
        echo "[iter $ITER] ref set updated — baseline archived as iter ${BL_ITER:-?}, reused ${PROMOTED_POWERS[0]} h2h aggregate as new baseline" | tee -a "$LOG_FILE"
      else
        echo "[iter $ITER] ref set updated — baseline archived as iter ${BL_ITER:-?}, will recalibrate next cycle" | tee -a "$LOG_FILE"
      fi
    fi

    # Return workers to collect mode.
    write_worker_config "collect" ""
  fi

  ITER=$((ITER + 1))
done
