#!/bin/bash
#
# Push the repo + current model to all Hetzner boxes in parallel.
#
# Usage:  ./scripts/push-hetzner.sh

set -euo pipefail

REMOTE_USER=${REMOTE_USER:-iain}
REMOTE_PATH=${REMOTE_PATH:-/home/iain/code/chaos}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519_hetzner}

# All boxes to push to. First is the coordinator, rest are workers.
HOSTS=(
  78.46.79.158     # hetz1 — coordinator
  188.40.109.160   # hetz2 — worker
  65.21.15.12      # hetz3 — worker
  88.198.24.105    # hetz4 — worker
  148.251.48.178   # hetz5 — worker
  148.251.138.112  # hetz6 — worker
)

LOCAL_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new"

RSYNC_EXCLUDES=(
  --exclude='node_modules'
  --exclude='.git'
  --exclude='packages/*/dist'
  --exclude='packages/client/dist'
  --exclude='packages/ai/data/training_iter_*.jsonl'
  --exclude='packages/ai/data/training_recent.jsonl'
  --exclude='packages/ai/data/training_w*.jsonl'
  --exclude='packages/ai/data/training.jsonl'
  --exclude='packages/ai/data/training_recent_tenzen.jsonl'
  --exclude='packages/ai/data/demos.jsonl'
  --exclude='packages/ai/data/model_iter_*.json'
  --exclude='packages/ai/data/model_xarm_iter_*.json'
  --exclude='packages/ai/data/model_gormen_iter_*.json'
  --exclude='packages/ai/data/model_tenzen_iter_*.json'
  --exclude='packages/ai/data/model_lasha_iter_*.json'
  --exclude='packages/ai/data/model_xarm.json'
  --exclude='packages/ai/data/model_gormen.json'
  --exclude='packages/ai/data/model_tenzen.json'
  --exclude='packages/ai/data/model_lasha.json'
  --exclude='packages/ai/data/model_tenzen_best.json'
  --exclude='packages/ai/data/model_xarm_best.json'
  --exclude='packages/ai/data/model_gormen_best.json'
  --exclude='packages/ai/data/model_lasha_best.json'
  --exclude='packages/ai/data/bench_iter_*.json'
  --exclude='packages/ai/data/inbox'
  --exclude='packages/ai/data/inbox2'
  --exclude='packages/ai/data/hof'
  --exclude='packages/ai/data/archive'
  --exclude='packages/ai/data/worker_config.json'
  --exclude='packages/ai/data/ref_baseline.json'
  --exclude='packages/ai/data/ref/'
  --exclude='packages/ai/data/fresh_powers'
  --exclude='packages/ai/data/bench_inbox_*'
  --exclude='packages/ai/data/bench_h2h_iter_*.json'
  --exclude='packages/ai/data/training_loop.log'
  --exclude='packages/ai/data/training_W*'
  --exclude='packages/ai/data/training_smoke.jsonl'
  --exclude='packages/ai/data/training_padded.jsonl'
  --exclude='packages/ai/data/training_test.jsonl'
  --exclude='packages/ai/data/model_box_latest.json'
  --exclude='/tmp'
)

push_one() {
  local host=$1
  echo "[$host] pushing source..."
  rsync -az --delete \
    "${RSYNC_EXCLUDES[@]}" \
    -e "ssh ${SSH_OPTS}" \
    "${LOCAL_ROOT}/" \
    "${REMOTE_USER}@${host}:${REMOTE_PATH}/"

  ssh ${SSH_OPTS} "${REMOTE_USER}@${host}" \
    "mkdir -p ${REMOTE_PATH}/packages/ai/data"

  if [ -f "${LOCAL_ROOT}/packages/ai/data/model.json" ]; then
    rsync -az -e "ssh ${SSH_OPTS}" \
      "${LOCAL_ROOT}/packages/ai/data/model.json" \
      "${REMOTE_USER}@${host}:${REMOTE_PATH}/packages/ai/data/model.json"
  fi

  echo "[$host] building..."
  ssh ${SSH_OPTS} "${REMOTE_USER}@${host}" \
    "cd ${REMOTE_PATH} && pnpm install && pnpm --filter engine build && pnpm --filter ai build && make -C packages/ai/native" 2>&1 \
    | sed "s/^/[$host] /"
  echo "[$host] ✓ done"
}

echo "Pushing to ${#HOSTS[@]} boxes in parallel..."
echo

pids=()
for host in "${HOSTS[@]}"; do
  push_one "$host" &
  pids+=($!)
done

# Wait for all
failed=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    failed=$((failed + 1))
  fi
done

echo
if [ "$failed" -gt 0 ]; then
  echo "⚠ ${failed} box(es) failed"
else
  echo "✓ All ${#HOSTS[@]} boxes pushed."
fi
