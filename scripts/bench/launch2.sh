#!/bin/bash
# usage: launch2.sh <jobs_file> <tag>
S=${BENCH_DIR:-$(cd "$(dirname "$0")" && pwd)}
JOBS=$1; TAG=$2
HOSTS=(78.46.79.158 78.46.79.158 188.40.109.160 65.21.15.12 88.198.24.105 148.251.48.178 148.251.138.112)
UNIQ=(78.46.79.158 188.40.109.160 65.21.15.12 88.198.24.105 148.251.48.178 148.251.138.112)
par() { [ "$1" = 78.46.79.158 ] && echo 24 || echo 16; }
for h in "${UNIQ[@]}"; do : > ${SPLIT_DIR:-/tmp}/split_${TAG}_$h.txt; done
i=0
while IFS= read -r line; do
  h=${HOSTS[$((i % ${#HOSTS[@]}))]}; echo "$line" >> ${SPLIT_DIR:-/tmp}/split_${TAG}_$h.txt; i=$((i+1))
done < $JOBS
for h in "${UNIQ[@]}"; do
  scp -q -i ~/.ssh/id_ed25519_hetzner ${SPLIT_DIR:-/tmp}/split_${TAG}_$h.txt root@$h:/home/iain/claude-bench/jobs_${TAG}.txt
  scp -q -i ~/.ssh/id_ed25519_hetzner $S/run_job.sh root@$h:/home/iain/claude-bench/run_job.sh
  ssh -n -i ~/.ssh/id_ed25519_hetzner root@$h "chown iain:iain /home/iain/claude-bench/jobs_${TAG}.txt /home/iain/claude-bench/run_job.sh; chmod +x /home/iain/claude-bench/run_job.sh; su - iain -c \"tmux new-session -d -s bench_${TAG} 'cd /home/iain/claude-bench && xargs -P $(par $h) -L 1 ./run_job.sh < jobs_${TAG}.txt; echo DONE > done_${TAG}'\""
  echo "$h: $(wc -l < ${SPLIT_DIR:-/tmp}/split_${TAG}_$h.txt) jobs, P=$(par $h)"
done
