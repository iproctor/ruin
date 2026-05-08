# Chaos / Ruin — notes for Claude

## Distributed training regime

Orchestrated by `scripts/distributed-coordinator.sh` on the coord box
(78.46.79.158). Workers run `scripts/worker-git-watch.sh`, auto-pulling code
via `git fetch + reset --hard` between batches and re-execing on script-mtime
change.

### Per-iter cycle

1. **Collect** — workers + coord play self-play, drop
   `training_W<id>_b<batch>_t<ts>.jsonl` into `packages/ai/data/inbox/`.
2. **Train** (coord) — concatenate last `TRAIN_WINDOW=90` archived batches +
   new ones; train all 4 power models for `TRAIN_EPOCHS=25` epochs warm-start.
   Writes `model_<P>.json` and snapshot `model_<P>_iter_NNNN.json`.
3. **H2H gate** (coord) — fires every iter after `H2H_AFTER_ITERS=5` warm-up.
   - If `ref_baseline.json` missing, **calibrate**: play all-ref self-play
     games (target `H2H_TARGET_GAMES=1024`), aggregate win rates →
     `ref_baseline.json`.
   - **H2H cycle**: for each of {xarm, gormen, tenzen, lasha}, set
     `worker_config = {task: bench_h2h, current_power: P}`; workers + coord
     play games where slot P is the candidate `model_<P>.json` and the
     other 3 slots use `ref/model_<other>_ref.json`. Aggregate to
     `bench_h2h_iter_NNNN_<P>.json`.
   - **Promote/revert per power**: if candidate win rate exceeds baseline
     by ≥ `H2H_PROMOTE_DELTA=0.02`, copy `model_<P>.json` →
     `ref/model_<P>_ref.json` (and add HOF entry). Otherwise **revert**:
     copy ref back to live so the next iter trains from the known-good
     model. AlphaZero discipline — rejected iters do **not** compound.
   - Any promotion invalidates the baseline (`rm ref_baseline.json`); next
     cycle recalibrates against the new ref set.

### What "iter N" means

- `model_<P>_iter_NNNN.json` is the **candidate** trained at iter N. Whether
  it became ref depends on the iter-N h2h verdict.
- `bench_h2h_iter_NNNN_<P>.json` is the h2h cycle that judged it. The
  number is candidate-P vs current ref-{others} 4-way self-play.
- Live `model_<P>.json` after revert == `ref/model_<P>_ref.json` exactly.

### Per-game τ-explorer (current self-play regime, May 7 2026)

`packages/server/src/scripts/collect-data.ts`: only one randomly-chosen
power per game uses τ=1 sampling for the first 2 rounds; other 3 play
max-visit. Clean loss attribution when only one player explores. Combined
with 1k MCTS iters, no rollout, no demos, 90-batch training window.

### Key tunables (env vars on coord)

| var | default | meaning |
|---|---|---|
| `TRAIN_WINDOW` | 180 | recent batches concatenated per train pass |
| `TRAIN_EPOCHS` | 25 | epochs per train pass |
| `H2H_AFTER_ITERS` | 5 | warm-up before h2h gate fires |
| `H2H_TARGET_GAMES` | 768 | games per power per cycle |
| `H2H_PROMOTE_DELTA` | 0.04 | win rate margin required to promote |
| `H2H_ITER` | 1000 | MCTS iters during h2h |

### Empirical cadence

Each h2h cycle (4 powers × 1024 games) takes ~80 min wall. Plus ~5 min
training, plus baseline recalibration after any promotion (~25 min). So
even though the gate fires every iter, h2h-bearing iters are spaced ~1.5h
apart, and a promotion event adds another ~25min before the next cycle.

### Reading bench results

- `ref_baseline.json` = current ref-vs-ref 4-way win rates. Treat it as
  the bar; deltas vs baseline are the only meaningful comparison.
- A promotion event shifts the baseline. After tenzen-promotion, baseline
  tenzen rises and the others fall (zero-sum 4-way). Deltas across a
  promotion boundary are not directly comparable to pre-promotion deltas.
