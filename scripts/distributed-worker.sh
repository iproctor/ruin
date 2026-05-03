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

GAMES_PER_BATCH=${GAMES_PER_BATCH:-32}
WORKERS=${WORKERS:-7}
IDLE_SECONDS=${IDLE_SECONDS:-30}
# Co-training era: no FOCUS_POWER, no LEAGUE_SIZE. Every game uses all
# 4 power models (with HOF mix), records all powers' visit distributions.
# Coordinator trains all 4 model_<power>.json each iter from the same batch.
LEAGUE_SIZE=0
LEAGUE_MIX=0
TENZEN_CUTOFF_SHIFT=1.0
export TENZEN_CUTOFF_SHIFT
HOF_MIX=0.15
export HOF_MIX

LOCAL_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA_DIR="$LOCAL_ROOT/packages/ai/data"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new"
RSYNC_SSH="ssh ${SSH_OPTS}"

mkdir -p "$DATA_DIR"

# One-shot cleanup: the abandoned gormen focus experiment left a stale
# model_gormen.json on every box. load-model.ts auto-loads per-power
# overrides if the file exists, so gormen has been playing with that
# stale brain in every self-play game. Delete on startup so workers
# fall back to model.json for gormen.
rm -f "$DATA_DIR/model_gormen.json"

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

  # 1. Pull canonical + per-power models, the worker_config, the HOF dir,
  # and the reference (h2h baseline) dir. worker_config.json drives task
  # dispatch below; coord rewrites it between phases.
  echo "[$(date +%H:%M:%S)] syncing from coordinator..."
  if ! rsync -az -e "${RSYNC_SSH}" \
      --include='model.json' --include='model_xarm.json' --include='model_gormen.json' \
      --include='model_tenzen.json' --include='model_lasha.json' \
      --include='worker_config.json' \
      --include='hof_mix.txt' --exclude='*' \
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

  # 1a.1. Mirror the reference snapshot dir (frozen baseline for h2h benches).
  mkdir -p "${DATA_DIR}/ref"
  rsync -az --delete -e "${RSYNC_SSH}" \
    "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/packages/ai/data/ref/" \
    "${DATA_DIR}/ref/" 2>/dev/null || true

  # 1b. Read worker_config.json. Falls back to a default "collect" task if
  # the coord hasn't written one. Coord transitions task between collect and
  # bench_h2h to drive worker behaviour without changing scripts.
  CONFIG_PATH="${DATA_DIR}/worker_config.json"
  if [ -f "$CONFIG_PATH" ]; then
    TASK=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('task','collect'))" "$CONFIG_PATH" 2>/dev/null || echo collect)
    CONFIG_ITER=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('iter',0))" "$CONFIG_PATH" 2>/dev/null || echo 0)
  else
    TASK="collect"
    CONFIG_ITER=0
  fi

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

  # 2. Dispatch on task.
  BATCH_COUNTER=$((BATCH_COUNTER + 1))
  TS=$(date +%s)
  SEED=$((WORKER_ID * 100000000 + BATCH_COUNTER * 1000))

  case "$TASK" in
    collect)
      BATCH_FILE="${DATA_DIR}/training_W${WORKER_ID}_b$(printf '%05d' "$BATCH_COUNTER")_t${TS}.jsonl"
      rm -f "${DATA_DIR}/training.jsonl"
      echo "[$(date +%H:%M:%S)] collect batch ${BATCH_COUNTER} (${GAMES_PER_BATCH} games, seed ${SEED}, iter ${CONFIG_ITER})..."
      T0=$(date +%s)
      if ! pnpm collect:parallel --games "$GAMES_PER_BATCH" --seed "$SEED" \
          --workers "$WORKERS" --epsilon 0 \
          --league-size 0 \
          --hof-mix "$HOF_MIX" \
          --dirichlet-weight 0.25 \
          --out "${DATA_DIR}/training.jsonl" 2>&1; then
        echo "  ! collection failed, retrying after ${IDLE_SECONDS}s"
        sleep "$IDLE_SECONDS"
        continue
      fi
      if [ ! -s "${DATA_DIR}/training.jsonl" ]; then
        echo "  ! no samples, retrying"
        sleep "$IDLE_SECONDS"
        continue
      fi
      mv "${DATA_DIR}/training.jsonl" "$BATCH_FILE"
      SAMPLES=$(wc -l < "$BATCH_FILE")
      T1=$(date +%s)
      echo "  ✓ ${SAMPLES} samples in $((T1 - T0))s → $(basename "$BATCH_FILE")"

      echo "[$(date +%H:%M:%S)] uploading to inbox..."
      if ! rsync -az -e "${RSYNC_SSH}" \
          "$BATCH_FILE" \
          "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/packages/ai/data/inbox/" 2>/dev/null; then
        echo "  ! upload failed — keeping local for retry"
        sleep "$IDLE_SECONDS"
        continue
      fi
      echo "  ✓ uploaded"
      rm -f "$BATCH_FILE"
      ;;

    bench_h2h)
      H2H_POWER=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('current_power',''))" "$CONFIG_PATH" 2>/dev/null)
      H2H_GAMES=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('games_per_box',100))" "$CONFIG_PATH" 2>/dev/null)
      H2H_ITER=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('mcts_iter',1000))" "$CONFIG_PATH" 2>/dev/null)
      if [ -z "$H2H_POWER" ]; then
        echo "  ! bench_h2h task has no current_power, sleeping"
        sleep "$IDLE_SECONDS"
        continue
      fi
      OUT_FILE="${DATA_DIR}/bench_h2h_${H2H_POWER}_W${WORKER_ID}_b$(printf '%05d' "$BATCH_COUNTER")_t${TS}.json"
      OUT_DIR="bench_inbox_${H2H_POWER}"
      echo "[$(date +%H:%M:%S)] h2h ${H2H_POWER} batch ${BATCH_COUNTER} (${H2H_GAMES} games, seed ${SEED}, iter ${H2H_ITER})..."
      T0=$(date +%s)
      if ! npx tsx packages/server/src/scripts/bench-h2h-parallel.ts \
          --current-power "$H2H_POWER" \
          --games "$H2H_GAMES" --seed "$SEED" \
          --iter "$H2H_ITER" --workers "$WORKERS" \
          --ref-dir "${DATA_DIR}/ref" \
          --out "$OUT_FILE" 2>&1; then
        echo "  ! bench failed, retrying"
        sleep "$IDLE_SECONDS"
        continue
      fi
      T1=$(date +%s)
      echo "  ✓ bench done in $((T1 - T0))s → $(basename "$OUT_FILE")"

      echo "[$(date +%H:%M:%S)] uploading to ${OUT_DIR}..."
      ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p ${REMOTE_PATH}/packages/ai/data/${OUT_DIR}"
      if ! rsync -az -e "${RSYNC_SSH}" \
          "$OUT_FILE" \
          "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/packages/ai/data/${OUT_DIR}/" 2>/dev/null; then
        echo "  ! upload failed — keeping local for retry"
        sleep "$IDLE_SECONDS"
        continue
      fi
      echo "  ✓ uploaded"
      rm -f "$OUT_FILE"
      ;;

    idle)
      # Coord asks workers to pause (e.g., during training). Sleep then re-poll.
      sleep "$IDLE_SECONDS"
      ;;

    *)
      echo "  ! unknown task '$TASK', sleeping"
      sleep "$IDLE_SECONDS"
      ;;
  esac
done
