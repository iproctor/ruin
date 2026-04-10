#!/bin/bash
#
# Push the repo + enough recent training data to resume on the Hetzner box.
#
# Strategy:
#   1. Sync source code (excluding node_modules, dist, and the bulk of training data)
#   2. Sync the current model.json
#   3. Sync the most recent N training_iter_*.jsonl files (the rolling window)
#      so the box can train its first iteration without re-collecting from scratch
#
# Usage:  ./scripts/push-hetzner.sh

set -euo pipefail

REMOTE_USER=${REMOTE_USER:-iain}
REMOTE_HOST=${REMOTE_HOST:-78.46.79.158}
REMOTE_PATH=${REMOTE_PATH:-/home/iain/code/chaos}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519_hetzner}
WINDOW=${WINDOW:-6}

LOCAL_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SSH_OPTS="-i $SSH_KEY"

echo "→ Pushing source code to ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}"

rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='packages/*/dist' \
  --exclude='packages/client/dist' \
  --exclude='packages/ai/data/training_iter_*.jsonl' \
  --exclude='packages/ai/data/training_recent.jsonl' \
  --exclude='packages/ai/data/training_w*.jsonl' \
  --exclude='packages/ai/data/training.jsonl' \
  --exclude='packages/ai/data/model_iter_*.json' \
  --exclude='packages/ai/data/bench_iter_*.json' \
  --exclude='/tmp' \
  -e "ssh ${SSH_OPTS}" \
  "${LOCAL_ROOT}/" \
  "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/"

echo "→ Ensuring remote data dir exists"
ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_HOST}" \
  "mkdir -p ${REMOTE_PATH}/packages/ai/data"

echo "→ Pushing current model.json"
if [ -f "${LOCAL_ROOT}/packages/ai/data/model.json" ]; then
  rsync -avz -e "ssh ${SSH_OPTS}" \
    "${LOCAL_ROOT}/packages/ai/data/model.json" \
    "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/packages/ai/data/model.json"
else
  echo "  (no local model.json — skipping)"
fi

echo "→ Pushing latest model snapshot so the loop can resume from a known iter"
LATEST_MODEL_ITER=$(ls -t "${LOCAL_ROOT}/packages/ai/data/"model_iter_*.json 2>/dev/null | head -1 || true)
if [ -n "${LATEST_MODEL_ITER}" ]; then
  rsync -avz -e "ssh ${SSH_OPTS}" \
    "${LATEST_MODEL_ITER}" \
    "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/packages/ai/data/"
  echo "  → $(basename "${LATEST_MODEL_ITER}")"
fi

echo "→ Pushing the last ${WINDOW} training_iter files (rolling window)"
RECENT_TRAINING=$(ls -t "${LOCAL_ROOT}/packages/ai/data/"training_iter_*.jsonl 2>/dev/null | head -"${WINDOW}" || true)
if [ -n "${RECENT_TRAINING}" ]; then
  echo "${RECENT_TRAINING}" | while read -r f; do
    rsync -avz -e "ssh ${SSH_OPTS}" "$f" \
      "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/packages/ai/data/"
    echo "  → $(basename "$f")"
  done
else
  echo "  (no local training_iter files — box will start collecting from scratch)"
fi

echo
echo "✓ Push complete."
echo
echo "Next steps on the box:"
echo "  ssh -i ${SSH_KEY} ${REMOTE_USER}@${REMOTE_HOST}"
echo "  cd ${REMOTE_PATH}"
echo "  pnpm install                                          # first time only"
echo "  pnpm --filter engine build && pnpm --filter ai build  # first time / after source changes"
echo "  tmux new -s ruin"
echo "  ITERATIONS=200 WORKERS=14 BENCH_GAMES=48 ./scripts/training-loop.sh"
