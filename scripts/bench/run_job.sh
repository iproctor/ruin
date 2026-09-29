#!/bin/bash
# Benchmark job runner, copied to /home/iain/claude-bench on every box.
# usage: run_job.sh <arm> <seed> [audit-games args...]
arm=$1; seed=$2; shift 2
cd /home/iain/claude-bench
RUIN_MLP_BF16=1 npx tsx packages/server/src/scripts/audit-games.ts --seed $seed --games 4 --out out/$arm.jsonl "$@" > /dev/null 2>> out/$arm.err
