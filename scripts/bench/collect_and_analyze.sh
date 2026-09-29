#!/bin/bash
# Pull out/*.jsonl from every box, merge per arm, run paired analysis.
S=${BENCH_DIR:-$(cd "$(dirname "$0")" && pwd)}
TAG=${1:-e1}
R=${RESULTS_DIR:-/tmp}/results_$TAG; rm -rf $R; mkdir -p $R
for h in 78.46.79.158 188.40.109.160 65.21.15.12 88.198.24.105 148.251.48.178 148.251.138.112; do
  mkdir -p $R/$h
  rsync -az -e "ssh -i $HOME/.ssh/id_ed25519_hetzner" "root@$h:/home/iain/claude-bench/out/*.jsonl" $R/$h/ 2>/dev/null &
done
wait
mkdir -p $R/merged
for f in $R/*/*.jsonl; do a=$(basename $f); [ "$(dirname $f)" = "$R/merged" ] && continue; cat $f >> $R/merged/$a; done
python3 $S/analyze_paired.py $R/merged
