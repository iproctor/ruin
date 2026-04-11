#!/bin/bash
#
# Pull the model + recent training data + bench results back from the Hetzner box.
#
# Use this when:
#   - You want to bring the trained model back to your laptop for local benching
#   - You want to inspect bench results / training samples produced on the box
#
# Usage:  ./scripts/pull-hetzner.sh

set -euo pipefail

REMOTE_USER=${REMOTE_USER:-iain}
REMOTE_HOST=${REMOTE_HOST:-78.46.79.158}
REMOTE_PATH=${REMOTE_PATH:-/home/iain/code/chaos}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519_hetzner}

LOCAL_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SSH_OPTS="-i $SSH_KEY"

echo "→ Pulling current model.json from ${REMOTE_USER}@${REMOTE_HOST}"
rsync -avz -e "ssh ${SSH_OPTS}" \
  "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/packages/ai/data/model.json" \
  "${LOCAL_ROOT}/packages/ai/data/model.json"

echo "→ Pulling all model_iter_*.json snapshots (incremental, then clean remote)"
rsync -avz -e "ssh ${SSH_OPTS}" \
  --include='model_iter_*.json' --exclude='*' \
  "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/packages/ai/data/" \
  "${LOCAL_ROOT}/packages/ai/data/"
# Keep only the latest snapshot on the box, delete the rest
ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_HOST}" \
  "cd ${REMOTE_PATH}/packages/ai/data && ls -t model_iter_*.json 2>/dev/null | tail -n +2 | xargs rm -f"

echo "→ Pulling all bench_iter_*.json results (incremental, then clean remote)"
rsync -avz -e "ssh ${SSH_OPTS}" \
  --include='bench_iter_*.json' --exclude='*' \
  "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/packages/ai/data/" \
  "${LOCAL_ROOT}/packages/ai/data/"
ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_HOST}" \
  "rm -f ${REMOTE_PATH}/packages/ai/data/bench_iter_*.json"

echo "→ Pulling training_loop.log (training progress / bench summaries)"
rsync -avz -e "ssh ${SSH_OPTS}" \
  "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/packages/ai/data/training_loop.log" \
  "${LOCAL_ROOT}/packages/ai/data/training_loop.log" || true

echo
echo "✓ Pull complete."
echo
echo "Latest local model snapshot:"
ls -t "${LOCAL_ROOT}/packages/ai/data/"model_iter_*.json 2>/dev/null | head -1 || echo "  (none)"
echo
echo "Latest local bench:"
LATEST_BENCH=$(ls -t "${LOCAL_ROOT}/packages/ai/data/"bench_iter_*.json 2>/dev/null | head -1 || true)
if [ -n "${LATEST_BENCH}" ]; then
  echo "  ${LATEST_BENCH}"
  echo "  → review with:  python3 -m json.tool ${LATEST_BENCH}"
fi
