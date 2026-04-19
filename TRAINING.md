Fork at 1235

Tenzen
 bench timestamps, the recent changes:

  ┌──────────────┬────────────────────────────────────────┬────────────────────────────┐
  │ Commit time  │                 Change                 │        Approx iter         │
  ├──────────────┼────────────────────────────────────────┼────────────────────────────┤
  │ Apr 17 20:04 │ cutoff → 4 (fresh model)               │ ~1231 (iter counter reset) │
  ├──────────────┼────────────────────────────────────────┼────────────────────────────┤
  │ Apr 18 13:06 │ cutoff 4 → 3                           │ ~1245 pre-restart          │
  ├──────────────┼────────────────────────────────────────┼────────────────────────────┤
  │ Apr 18 14:20 │ cutoff 3 → 4 (brief revert)            │ ~1248 pre-restart          │
  ├──────────────┼────────────────────────────────────────┼────────────────────────────┤
  │ Apr 18 14:28 │ cutoff 4 → 3 (restore, "dip expected") │ ~1249 pre-restart          │
  ├──────────────┼────────────────────────────────────────┼────────────────────────────┤
  │ Apr 18 16:52 │ cutoff 3 → 2                           │ ~1246 post-restart         │
  └──────────────┴────────────────────────────────────────┴────────────────────────────┘

  Apr 18 ~17:00  DATA LOSS EVENT
    push-hetzner's rsync --delete excludes didn't cover per-power
    models. Deploying the epsilon change wiped model_tenzen.json +
    model_tenzen_iter_1239..1261 on the coordinator. Restored
    model_tenzen.json by copying model_tenzen_iter_1238.json. Training
    resumed from 1238.

  Apr 18 17:xx   ε 0.15 → 0.08
    Uniform-random exploration was taxing Tenzen ~1.6 wasted summons per
    game. Narrows the gap between training-freq (~0.11) and greedy play.

  Apr 18 17:xx   push-hetzner excludes fix
    Added model_<power>.json, model_<power>_iter_*.json, and
    model_<power>_best.json to RSYNC_EXCLUDES. Data-loss event cannot
    recur.

  Apr 18 17:xx   load-model.ts auto-loads per-power models
    loadLearnedModelIfPresent now scans for model_<power>.json next to
    model.json and calls loadModelForPower(power, json). Before this
    fix, every bench on the coordinator was measuring Tenzen on the
    frozen shared model — the 25%/19%/10%/17% bench trajectory we'd
    been reacting to was MCTS seed jitter, not real focus-training
    progress. Bench_1265 was the first honest read.

  Apr 18 ~17:00  bookmark mechanic
    Introduced model_tenzen_best.json as a named anchor (copied from
    latest snapshot on each stage advance). push-hetzner excludes
    model_<power>_best.json so anchors persist across deploys.

  Apr 19 ~02:00  NEW MECHANISM: TENZEN_CUTOFF_SHIFT
    Replaced the 20% [1,4] cutoff randomizer with a schedulable per-game
    distribution. Single env var TENZEN_CUTOFF_SHIFT ∈ [0,1]:
      shift=0 → P({1,2,3,4}) = (0.4, 0.3, 0.2, 0.1), P(0)=0
      shift=1 → P(0) = 1
      intermediate: P(0)=shift, remaining (1-shift) on (4,3,2,1)/10
    Each self-play game samples a cutoff at start, uses it end-to-end.
    Training data is now a mixture of strategies rather than specialised
    to one cutoff value. Lets the policy discover lines the handmade
    evaluator boxed out.

  Apr 19         shift ramp (every ~30 min via cron):
    ┌──────┬───────────┬─────────────────┬──────────┐
    │ Time │ shift     │ 3-iter avg freq │ anchor   │
    ├──────┼───────────┼─────────────────┼──────────┤
    │ 02:xx│ 0 → 0.1   │ 0.132           │ iter_1276│
    │ 02:xx│ 0.1 → 0.2 │ 0.140           │ iter_1278│
    │ 03:xx│ 0.2 → 0.3 │ 0.146           │ iter_1280│
    │ 03:xx│ 0.3 → 0.4 │ 0.140           │ iter_1282│
    │ 03:xx│ 0.4 → 0.5 │ 0.130           │ iter_1284│
    │ 04:xx│ 0.5 → 0.6 │ 0.147 (peak .161)│ iter_1286│
    │ 04:xx│ 0.6 → 0.7 │ 0.150           │ iter_1288│
    │ 04:xx│ 0.7 → 0.8 │ 0.131           │ iter_1290│
    │ 05:xx│ 0.8 → 0.9 │ 0.131           │ iter_1292│
    │ 05:xx│ 0.9 → 1.0 │ 0.144 — Stage 1 done │ iter_1294│
    └──────┴───────────┴─────────────────┴──────────┘

  Apr 19         TENZEN_EVAL_CUTOFF default 2 → 0 in evaluate.ts
    Server/bench fallback when the env var isn't set is now pure
    learned. Brings non-collection call sites in line with the
    collection schedule's terminal state.

  Apr 19 (now)   Stage 2 gate
    Shift=1.0, bestSiphonPlay + forceZeroCostFlush still active.
    Class freq oscillating 0.12–0.15; needs 3-iter avg > 0.15 to strip
    bestSiphonPlay. Holding.

  Meta
    - distributed scripts re-exec themselves when their file mtime
      changes (picks up push-hetzner rsync without manual restart).
    - class freq (130k rows/iter, ±0.2% CI) is the decision signal.
      Bench (48 games, ±13% CI) is context only.
