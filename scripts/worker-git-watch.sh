#!/bin/bash
#
# Self-play worker that checks git master between batches.
# After each batch: fetch, and if there's a new commit, reset + rebuild.
#
# Usage:
#   WORKER_ID=3 COORD_HOST=78.46.79.158 ./scripts/worker-git-watch.sh

set -uo pipefail

WORKER_ID=${WORKER_ID:?WORKER_ID env var required}
COORD_HOST=${COORD_HOST:-78.46.79.158}
COORD_USER=${COORD_USER:-iain}
COORD_PATH=${COORD_PATH:-/home/iain/code/chaos}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519_hetzner}

GAMES_PER_BATCH=${GAMES_PER_BATCH:-16}
WORKERS=${WORKERS:-7}
HOF_MIX=${HOF_MIX:-0.15}
IDLE_SECONDS=${IDLE_SECONDS:-30}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA_DIR="$ROOT/packages/ai/data"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new"

BATCH_COUNTER=0
mkdir -p "$DATA_DIR"

# One-shot cleanup: the abandoned gormen focus experiment left a stale
# model_gormen.json on every box. load-model.ts auto-loads per-power
# overrides if the file exists, so gormen has been playing with that
# stale brain in every self-play game. Delete on startup so workers
# fall back to model.json for gormen.
rm -f "$DATA_DIR/model_gormen.json"

echo "──────────────────────────────────────────────────"
echo "Git-watching worker"
echo "  WORKER_ID: $WORKER_ID  WORKERS: $WORKERS  GAMES: $GAMES_PER_BATCH"
echo "  COORD: ${COORD_USER}@${COORD_HOST}"
echo "──────────────────────────────────────────────────"

# Track script mtime so we can re-exec when `git reset --hard` (or any
# other path) rewrites the file. Without this the worker keeps running
# the old logic until restarted by hand.
SELF_MTIME=$(stat -c %Y "$0" 2>/dev/null || stat -f %m "$0")

BRANCH=${BRANCH:-training}

check_and_update() {
  cd "$ROOT"
  git fetch origin "$BRANCH" --quiet 2>/dev/null
  local LOCAL=$(git rev-parse HEAD)
  local REMOTE=$(git rev-parse "origin/$BRANCH")
  if [ "$LOCAL" = "$REMOTE" ]; then return 1; fi

  echo "[$(date +%H:%M:%S)] new commit: $(git log --oneline "origin/$BRANCH" -1)"
  local OLD_LOCK=$(md5sum pnpm-lock.yaml 2>/dev/null | cut -d' ' -f1)
  git reset --hard "origin/$BRANCH"
  local NEW_LOCK=$(md5sum pnpm-lock.yaml 2>/dev/null | cut -d' ' -f1)
  [ "$OLD_LOCK" != "$NEW_LOCK" ] && pnpm install --frozen-lockfile 2>&1 | tail -3
  pnpm --filter engine build && pnpm --filter ai build
  echo "[$(date +%H:%M:%S)] rebuild done"
  return 0
}

pull_model() {
  rsync -az -e "ssh ${SSH_OPTS}" \
    --include='model.json' --include='model_xarm.json' --include='model_gormen.json' \
    --include='model_tenzen.json' --include='model_lasha.json' \
    --include='worker_config.json' \
    --include='hof_mix.txt' --exclude='*' \
    "${COORD_USER}@${COORD_HOST}:${COORD_PATH}/packages/ai/data/" \
    "${DATA_DIR}/" 2>/dev/null
}

pull_hof() {
  mkdir -p "${DATA_DIR}/hof"
  rsync -az --delete -e "ssh ${SSH_OPTS}" \
    "${COORD_USER}@${COORD_HOST}:${COORD_PATH}/packages/ai/data/hof/" \
    "${DATA_DIR}/hof/" 2>/dev/null || true
}

pull_ref() {
  mkdir -p "${DATA_DIR}/ref"
  rsync -az --delete -e "ssh ${SSH_OPTS}" \
    "${COORD_USER}@${COORD_HOST}:${COORD_PATH}/packages/ai/data/ref/" \
    "${DATA_DIR}/ref/" 2>/dev/null || true
}

while true; do
  # Restart into the latest script if it's been updated on disk.
  NOW_MTIME=$(stat -c %Y "$0" 2>/dev/null || stat -f %m "$0")
  if [ "$NOW_MTIME" != "$SELF_MTIME" ]; then
    echo "[$(date +%H:%M:%S)] script updated on disk, re-execing..."
    exec "$0" "$@"
  fi

  # Check git + pull model + worker_config + hof + ref
  check_and_update && echo "  → updated from git"
  pull_model
  pull_hof
  pull_ref

  # Read task from worker_config.json (default collect if absent).
  CONFIG_PATH="${DATA_DIR}/worker_config.json"
  if [ -f "$CONFIG_PATH" ]; then
    TASK=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('task','collect'))" "$CONFIG_PATH" 2>/dev/null || echo collect)
  else
    TASK="collect"
  fi

  BATCH_COUNTER=$((BATCH_COUNTER + 1))
  TS=$(date +%s)
  SEED=$((WORKER_ID * 100000000 + BATCH_COUNTER * 1000))
  cd "$ROOT"

  case "$TASK" in
    collect)
      BATCH_FILE="${DATA_DIR}/training_W${WORKER_ID}_b$(printf '%05d' "$BATCH_COUNTER")_t${TS}.jsonl"
      rm -f "${DATA_DIR}/training.jsonl"
      echo "[$(date +%H:%M:%S)] collect batch ${BATCH_COUNTER} (${GAMES_PER_BATCH} games, seed ${SEED})"
      if pnpm collect:parallel --games "$GAMES_PER_BATCH" --seed "$SEED" \
          --workers "$WORKERS" --epsilon 0 --league-size 0 \
          --hof-mix "$HOF_MIX" --dirichlet-weight 0.25 \
          --temp-rounds 2 --iter 1000 \
          --out "${DATA_DIR}/training.jsonl" >/dev/null 2>&1 && [ -s "${DATA_DIR}/training.jsonl" ]; then
        mv "${DATA_DIR}/training.jsonl" "$BATCH_FILE"
        SAMPLES=$(wc -l < "$BATCH_FILE")
        echo "  ✓ ${SAMPLES} samples"
        rsync -az -e "ssh ${SSH_OPTS}" "$BATCH_FILE" \
          "${COORD_USER}@${COORD_HOST}:${COORD_PATH}/packages/ai/data/inbox/" 2>/dev/null \
          && rm -f "$BATCH_FILE"
      else
        echo "  ! collection failed"
        sleep 5
      fi
      ;;

    bench_h2h)
      H2H_POWER=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('current_power',''))" "$CONFIG_PATH" 2>/dev/null)
      H2H_GAMES=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('games_per_box',16))" "$CONFIG_PATH" 2>/dev/null)
      H2H_ITER=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('mcts_iter',1000))" "$CONFIG_PATH" 2>/dev/null)
      if [ -z "$H2H_POWER" ]; then sleep "$IDLE_SECONDS"; continue; fi
      OUT_FILE="${DATA_DIR}/bench_h2h_${H2H_POWER}_W${WORKER_ID}_b$(printf '%05d' "$BATCH_COUNTER")_t${TS}.json"
      OUT_DIR="bench_inbox_${H2H_POWER}"
      echo "[$(date +%H:%M:%S)] h2h ${H2H_POWER} batch ${BATCH_COUNTER} (${H2H_GAMES} games, seed ${SEED})"
      if npx tsx packages/server/src/scripts/bench-h2h-parallel.ts \
          --current-power "$H2H_POWER" \
          --games "$H2H_GAMES" --seed "$SEED" \
          --iter "$H2H_ITER" --workers "$WORKERS" \
          --ref-dir "${DATA_DIR}/ref" \
          --out "$OUT_FILE" >/dev/null 2>&1; then
        ssh ${SSH_OPTS} "${COORD_USER}@${COORD_HOST}" "mkdir -p ${COORD_PATH}/packages/ai/data/${OUT_DIR}"
        rsync -az -e "ssh ${SSH_OPTS}" "$OUT_FILE" \
          "${COORD_USER}@${COORD_HOST}:${COORD_PATH}/packages/ai/data/${OUT_DIR}/" 2>/dev/null \
          && rm -f "$OUT_FILE"
        echo "  ✓ uploaded"
      else
        echo "  ! h2h batch failed"
        sleep 5
      fi
      ;;

    bench_baseline)
      H2H_GAMES=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('games_per_box',16))" "$CONFIG_PATH" 2>/dev/null)
      H2H_ITER=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('mcts_iter',1000))" "$CONFIG_PATH" 2>/dev/null)
      OUT_FILE="${DATA_DIR}/bench_baseline_W${WORKER_ID}_b$(printf '%05d' "$BATCH_COUNTER")_t${TS}.json"
      OUT_DIR="bench_inbox_baseline"
      echo "[$(date +%H:%M:%S)] baseline batch ${BATCH_COUNTER} (${H2H_GAMES} games, seed ${SEED})"
      if npx tsx packages/server/src/scripts/bench-h2h-parallel.ts \
          --baseline \
          --games "$H2H_GAMES" --seed "$SEED" \
          --iter "$H2H_ITER" --workers "$WORKERS" \
          --ref-dir "${DATA_DIR}/ref" \
          --out "$OUT_FILE" >/dev/null 2>&1; then
        ssh ${SSH_OPTS} "${COORD_USER}@${COORD_HOST}" "mkdir -p ${COORD_PATH}/packages/ai/data/${OUT_DIR}"
        rsync -az -e "ssh ${SSH_OPTS}" "$OUT_FILE" \
          "${COORD_USER}@${COORD_HOST}:${COORD_PATH}/packages/ai/data/${OUT_DIR}/" 2>/dev/null \
          && rm -f "$OUT_FILE"
        echo "  ✓ uploaded"
      else
        echo "  ! baseline batch failed"
        sleep 5
      fi
      ;;

    idle)
      sleep "$IDLE_SECONDS"
      ;;

    *)
      echo "  ! unknown task '$TASK', sleeping"
      sleep "$IDLE_SECONDS"
      ;;
  esac
done
