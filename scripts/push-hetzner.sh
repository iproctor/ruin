#!/bin/bash
#
# Push the repo + current model to the Hetzner box.
#
# Strategy:
#   1. Sync source code (excluding node_modules, dist, training artifacts)
#   2. Sync the current model.json so the box resumes from where the laptop left off
#
# Usage:  ./scripts/push-hetzner.sh

set -euo pipefail

REMOTE_USER=${REMOTE_USER:-iain}
REMOTE_HOST=${REMOTE_HOST:-78.46.79.158}
REMOTE_PATH=${REMOTE_PATH:-/home/iain/code/chaos}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519_hetzner}

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
  --exclude='packages/ai/data/inbox' \
  --exclude='packages/ai/data/archive' \
  --exclude='packages/ai/data/training_loop.log' \
  --exclude='packages/ai/data/training_W*' \
  --exclude='packages/ai/data/training_smoke.jsonl' \
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
