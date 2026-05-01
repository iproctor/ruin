#!/bin/bash
#
# Run fork-demo-data.ts in parallel across N most recent tenzen-won games.
# Each game runs in its own subprocess; outputs concatenated at end.
#
# Usage:
#   ./scripts/fork-demos-parallel.sh [GAMES] [PARALLEL] [FROM_ROUND]
#     GAMES       — number of recent demo games to fork (default 10)
#     PARALLEL    — max concurrent processes (default 8)
#     FROM_ROUND  — round to start AI takeover from (default 2)

set -euo pipefail

GAMES=${1:-10}
PARALLEL=${2:-8}
FROM_ROUND=${3:-2}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

OUT_DIR=/tmp/fork_demos
mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/fork_*.jsonl

DATABASE_URL=${DATABASE_URL:-postgres://localhost:5432/ruin}
export DATABASE_URL

echo "Pulling $GAMES tenzen-won game IDs from DB..."
GAME_IDS=$(npx tsx packages/server/src/scripts/list-tenzen-wins.ts "$GAMES" 2>/dev/null)
GAME_COUNT=$(echo "$GAME_IDS" | wc -l | tr -d ' ')
echo "Found $GAME_COUNT games. Forking $PARALLEL at a time, AI from round $FROM_ROUND."
echo

T0=$(date +%s)

run_one() {
  local game="$1"
  local out="$OUT_DIR/fork_${game}.jsonl"
  local log="$OUT_DIR/fork_${game}.log"
  npx tsx packages/server/src/scripts/fork-demo-data.ts \
    --game "$game" \
    --from-round "$FROM_ROUND" \
    --out "$out" >"$log" 2>&1
  local samples
  samples=$(wc -l < "$out" 2>/dev/null || echo 0)
  local last_status
  last_status=$(grep -E "Wrote|fork [0-9]+/" "$log" | tail -1)
  echo "[$game] ${samples} samples — ${last_status}"
}

export -f run_one
export OUT_DIR FROM_ROUND

echo "$GAME_IDS" | xargs -n 1 -P "$PARALLEL" -I {} bash -c 'run_one "$@"' _ {}

T1=$(date +%s)
echo
echo "All forks done in $((T1 - T0))s."

OUT_FILE=/tmp/tenzen_forks.jsonl
cat "$OUT_DIR"/fork_*.jsonl > "$OUT_FILE"
TOTAL=$(wc -l < "$OUT_FILE")
echo "Concatenated $TOTAL samples → $OUT_FILE"
