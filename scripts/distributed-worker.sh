#!/bin/bash
#
# Distributed self-play worker. Run this on a laptop to contribute training
# batches to the Hetzner coordinator.
#
# Loop:
#   1. Pull model.json from coordinator
#   2. If model has not changed since the last batch we generated, sleep and retry
#   3. If model is new: run collect-data with a unique seed range
#   4. Upload the resulting training file to coordinator's inbox/
#   5. Goto 1
#
# Required env (or edit defaults below):
#   WORKER_ID         unique small int per worker (1, 2, 3, ...) — used in seed sharding
#   COORD_HOST        DNS name or IP of the Hetzner coordinator (default 78.46.79.158)
#   COORD_USER        ssh user on the coordinator                (default iain)
#   COORD_PATH        chaos repo path on the coordinator         (default /home/iain/code/chaos)
#   SSH_KEY           private key                                (default ~/.ssh/id_ed25519_hetzner)
#
# Optional:
#   GAMES_PER_BATCH   how many games per batch (default 100)
#   WORKERS           local worker processes for collect:parallel (default 7)
#   IDLE_SECONDS      sleep between model checks when idle (default 30)

set -uo pipefail

REMOTE_USER=${COORD_USER:-iain}
REMOTE_HOST=${COORD_HOST:-78.46.79.158}
REMOTE_PATH=${COORD_PATH:-/home/iain/code/chaos}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519_hetzner}
WORKER_ID=${WORKER_ID:?WORKER_ID env var required (unique small int per worker)}

GAMES_PER_BATCH=${GAMES_PER_BATCH:-50}
WORKERS=${WORKERS:-7}
IDLE_SECONDS=${IDLE_SECONDS:-30}
# League training: non-zero LEAGUE_SIZE enables opponent-snapshot sampling.
# The worker pulls the most recent LEAGUE_SIZE model_iter_*.json from the
# coordinator before each batch.
LEAGUE_SIZE=${LEAGUE_SIZE:-0}
LEAGUE_MIX=${LEAGUE_MIX:-0.5}
# Focus power: if set, all self-play games use model_<power>.json for that
# power and snapshots for others. Only that power's visits are recorded.
FOCUS_POWER=tenzen
# Tenzen cutoff shift ∈ [0,1] — passed through to collect:parallel.
TENZEN_CUTOFF_SHIFT=${TENZEN_CUTOFF_SHIFT:-1.0}
export TENZEN_CUTOFF_SHIFT
HOF_MIX=${HOF_MIX:-0.1}
export HOF_MIX

LOCAL_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA_DIR="$LOCAL_ROOT/packages/ai/data"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new"
RSYNC_SSH="ssh ${SSH_OPTS}"

mkdir -p "$DATA_DIR"

# Track which model we last collected against (mtime as a string).
LAST_MODEL_MTIME=""
BATCH_COUNTER=0

echo "──────────────────────────────────────────────────"
echo "Distributed worker starting"
echo "  WORKER_ID:       $WORKER_ID"
echo "  COORD:           ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}"
echo "  GAMES_PER_BATCH: $GAMES_PER_BATCH"
echo "  WORKERS:         $WORKERS"
echo "──────────────────────────────────────────────────"

# Track script mtime so we can re-exec when the file changes on disk
# (e.g. after push-hetzner.sh updates this box). Workers would otherwise
# keep running the old logic until manually restarted.
SELF_MTIME=$(stat -c %Y "$0" 2>/dev/null || stat -f %m "$0")

while true; do
  # Restart into the latest script if it's been updated on disk.
  NOW_MTIME=$(stat -c %Y "$0" 2>/dev/null || stat -f %m "$0")
  if [ "$NOW_MTIME" != "$SELF_MTIME" ]; then
    echo "[$(date +%H:%M:%S)] script updated on disk, re-execing..."
    exec "$0" "$@"
  fi

  # 1. Pull the canonical model + any per-power models from the coordinator.
  echo "[$(date +%H:%M:%S)] checking coordinator for new model..."
  if ! rsync -az -e "${RSYNC_SSH}" \
      --include='model.json' --include='model_xarm.json' --include='model_gormen.json' \
      --include='model_tenzen.json' --include='model_lasha.json' --exclude='*' \
      "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/packages/ai/data/" \
      "${DATA_DIR}/" 2>/dev/null; then
    echo "  ! rsync failed, sleeping ${IDLE_SECONDS}s..."
    sleep "$IDLE_SECONDS"
    continue
  fi

  # 1a. Mirror the hall-of-fame dir so HOF sampling in collect-data sees
  # whatever the coordinator has promoted.
  mkdir -p "${DATA_DIR}/hof"
  rsync -az --delete -e "${RSYNC_SSH}" \
    "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/packages/ai/data/hof/" \
    "${DATA_DIR}/hof/" 2>/dev/null || true

  # 1b. If league training is on, pull the most recent LEAGUE_SIZE snapshots.
  # Ask the coordinator which filenames are the newest, wipe old local ones,
  # then rsync only those. Keeps worker disk usage bounded.
  if [ "$LEAGUE_SIZE" -gt 0 ]; then
    SNAPSHOT_LIST=$(ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_HOST}" \
      "cd ${REMOTE_PATH}/packages/ai/data && ls model_iter_*.json 2>/dev/null | sort | tail -${LEAGUE_SIZE}")
    if [ -z "$SNAPSHOT_LIST" ]; then
      echo "  ! no snapshots on coordinator, league pool will be empty"
    else
      rm -f "${DATA_DIR}"/model_iter_*.json
      SNAP_OK=1
      for snap in $SNAPSHOT_LIST; do
        if ! rsync -az -e "${RSYNC_SSH}" \
            "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/packages/ai/data/${snap}" \
            "${DATA_DIR}/${snap}" 2>/dev/null; then
          SNAP_OK=0
          break
        fi
      done
      if [ "$SNAP_OK" -eq 0 ]; then
        echo "  ! snapshot rsync failed, sleeping ${IDLE_SECONDS}s..."
        sleep "$IDLE_SECONDS"
        continue
      fi
    fi
  fi

  # 2. Always collect — don't wait for model changes. Small batches + continuous
  #    uploads maximize throughput. The coordinator trains when enough arrive.

  # 3. Run a collection batch with a unique seed range.
  BATCH_COUNTER=$((BATCH_COUNTER + 1))
  TS=$(date +%s)
  SEED=$((WORKER_ID * 100000000 + BATCH_COUNTER * 1000))
  BATCH_FILE="${DATA_DIR}/training_W${WORKER_ID}_b$(printf '%05d' "$BATCH_COUNTER")_t${TS}.jsonl"
  rm -f "${DATA_DIR}/training.jsonl"

  echo "[$(date +%H:%M:%S)] collecting batch ${BATCH_COUNTER} (${GAMES_PER_BATCH} games, seed ${SEED})..."
  T0=$(date +%s)
  FOCUS_ARG=""
  [ -n "$FOCUS_POWER" ] && FOCUS_ARG="--focus-power $FOCUS_POWER"
  if ! pnpm collect:parallel --games "$GAMES_PER_BATCH" --seed "$SEED" \
      --workers "$WORKERS" --epsilon 0 \
      --league-size "$LEAGUE_SIZE" --league-mix "$LEAGUE_MIX" $FOCUS_ARG \
      --hof-mix "$HOF_MIX" \
      --out "${DATA_DIR}/training.jsonl" >/dev/null 2>&1; then
    echo "  ! collection failed, retrying after ${IDLE_SECONDS}s"
    sleep "$IDLE_SECONDS"
    continue
  fi
  if [ ! -s "${DATA_DIR}/training.jsonl" ]; then
    echo "  ! collection produced no samples, retrying"
    sleep "$IDLE_SECONDS"
    continue
  fi
  mv "${DATA_DIR}/training.jsonl" "$BATCH_FILE"
  SAMPLES=$(wc -l < "$BATCH_FILE")
  T1=$(date +%s)
  echo "  ✓ ${SAMPLES} samples in $((T1 - T0))s → $(basename "$BATCH_FILE")"

  # 4. Upload to coordinator inbox.
  echo "[$(date +%H:%M:%S)] uploading batch to coordinator inbox..."
  if ! rsync -az -e "${RSYNC_SSH}" \
      "$BATCH_FILE" \
      "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/packages/ai/data/inbox/" 2>/dev/null; then
    echo "  ! upload failed — keeping local file for next attempt"
    sleep "$IDLE_SECONDS"
    continue
  fi
  echo "  ✓ uploaded"

  # 5. (Optional) clean up local copy to save disk on the laptop.
  rm -f "$BATCH_FILE"
done
