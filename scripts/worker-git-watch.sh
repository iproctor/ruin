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

GAMES_PER_BATCH=${GAMES_PER_BATCH:-50}
WORKERS=${WORKERS:-7}
# League training: non-zero LEAGUE_SIZE pulls the last N snapshots from the
# coordinator before each batch and passes them to collect:parallel as an
# opponent pool.
LEAGUE_SIZE=${LEAGUE_SIZE:-0}
LEAGUE_MIX=${LEAGUE_MIX:-0.5}
FOCUS_POWER=${FOCUS_POWER:-}
# Tenzen cutoff shift ∈ [0,1] — passed through to collect:parallel.
TENZEN_CUTOFF_SHIFT=${TENZEN_CUTOFF_SHIFT:-1.0}
export TENZEN_CUTOFF_SHIFT

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA_DIR="$ROOT/packages/ai/data"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new"

BATCH_COUNTER=0
mkdir -p "$DATA_DIR"

echo "──────────────────────────────────────────────────"
echo "Git-watching worker"
echo "  WORKER_ID: $WORKER_ID  WORKERS: $WORKERS  GAMES: $GAMES_PER_BATCH"
echo "  COORD: ${COORD_USER}@${COORD_HOST}"
echo "──────────────────────────────────────────────────"

# Track script mtime so we can re-exec when `git reset --hard` (or any
# other path) rewrites the file. Without this the worker keeps running
# the old logic until restarted by hand.
SELF_MTIME=$(stat -c %Y "$0" 2>/dev/null || stat -f %m "$0")

check_and_update() {
  cd "$ROOT"
  git fetch origin master --quiet 2>/dev/null
  local LOCAL=$(git rev-parse HEAD)
  local REMOTE=$(git rev-parse origin/master)
  if [ "$LOCAL" = "$REMOTE" ]; then return 1; fi

  echo "[$(date +%H:%M:%S)] new commit: $(git log --oneline origin/master -1)"
  local OLD_LOCK=$(md5sum pnpm-lock.yaml 2>/dev/null | cut -d' ' -f1)
  git reset --hard origin/master
  local NEW_LOCK=$(md5sum pnpm-lock.yaml 2>/dev/null | cut -d' ' -f1)
  [ "$OLD_LOCK" != "$NEW_LOCK" ] && pnpm install --frozen-lockfile 2>&1 | tail -3
  pnpm --filter engine build && pnpm --filter ai build
  echo "[$(date +%H:%M:%S)] rebuild done"
  return 0
}

pull_model() {
  rsync -az -e "ssh ${SSH_OPTS}" \
    --include='model.json' --include='model_xarm.json' --include='model_gormen.json' \
    --include='model_tenzen.json' --include='model_lasha.json' --exclude='*' \
    "${COORD_USER}@${COORD_HOST}:${COORD_PATH}/packages/ai/data/" \
    "${DATA_DIR}/" 2>/dev/null
}

pull_snapshots() {
  # Pull the most recent LEAGUE_SIZE snapshot filenames from coordinator and
  # replace local ones so the league pool stays fresh.
  [ "$LEAGUE_SIZE" -gt 0 ] || return 0
  local SNAPS
  SNAPS=$(ssh ${SSH_OPTS} "${COORD_USER}@${COORD_HOST}" \
    "cd ${COORD_PATH}/packages/ai/data && ls model_iter_*.json 2>/dev/null | sort | tail -${LEAGUE_SIZE}")
  [ -z "$SNAPS" ] && return 0
  rm -f "${DATA_DIR}"/model_iter_*.json
  for snap in $SNAPS; do
    rsync -az -e "ssh ${SSH_OPTS}" \
      "${COORD_USER}@${COORD_HOST}:${COORD_PATH}/packages/ai/data/${snap}" \
      "${DATA_DIR}/${snap}" 2>/dev/null || return 1
  done
}

while true; do
  # Restart into the latest script if it's been updated on disk.
  NOW_MTIME=$(stat -c %Y "$0" 2>/dev/null || stat -f %m "$0")
  if [ "$NOW_MTIME" != "$SELF_MTIME" ]; then
    echo "[$(date +%H:%M:%S)] script updated on disk, re-execing..."
    exec "$0" "$@"
  fi

  # Check git + pull model (+ snapshots if league is on)
  check_and_update && echo "  → updated from git"
  pull_model
  pull_snapshots

  # Collect a batch
  BATCH_COUNTER=$((BATCH_COUNTER + 1))
  TS=$(date +%s)
  SEED=$((WORKER_ID * 100000000 + BATCH_COUNTER * 1000))
  BATCH_FILE="${DATA_DIR}/training_W${WORKER_ID}_b$(printf '%05d' "$BATCH_COUNTER")_t${TS}.jsonl"

  echo "[$(date +%H:%M:%S)] batch ${BATCH_COUNTER} (${GAMES_PER_BATCH} games, seed ${SEED})"
  cd "$ROOT"
  rm -f "${DATA_DIR}/training.jsonl"
  FOCUS_ARG=""
  [ -n "$FOCUS_POWER" ] && FOCUS_ARG="--focus-power $FOCUS_POWER"
  if pnpm collect:parallel --games "$GAMES_PER_BATCH" --seed "$SEED" \
      --workers "$WORKERS" --epsilon 0 \
      --league-size "$LEAGUE_SIZE" --league-mix "$LEAGUE_MIX" $FOCUS_ARG \
      --out "${DATA_DIR}/training.jsonl" >/dev/null 2>&1 && [ -s "${DATA_DIR}/training.jsonl" ]; then
    mv "${DATA_DIR}/training.jsonl" "$BATCH_FILE"
    SAMPLES=$(wc -l < "$BATCH_FILE")
    echo "  ✓ ${SAMPLES} samples"

    # Upload to coordinator inbox
    rsync -az -e "ssh ${SSH_OPTS}" \
      "$BATCH_FILE" \
      "${COORD_USER}@${COORD_HOST}:${COORD_PATH}/packages/ai/data/inbox/" 2>/dev/null \
      && rm -f "$BATCH_FILE"
  else
    echo "  ! collection failed"
    sleep 5
  fi
done
