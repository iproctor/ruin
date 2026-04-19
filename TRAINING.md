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

  Apr 19         Stages 2 + 3 forced early
    User: "growing impatient. let me try dropping the autoplay now to see
    if autoplay itself is the ceiling." Disabled bestSiphonPlay (was
    force-placing Tenzen's Siphon Power in "max opponents + highest
    threat" slot) and forceZeroCostFlush (was forcing cheap-card flushes
    at PP<3). Both became call-site no-ops; functions kept for reference.
    Class freq promptly dropped from ~0.14 to ~0.09-0.11 — autoplay was
    helping, not capping. Tenzen stabilised at the new floor rather than
    recovering.

  Apr 19         ε 0.08 → 0.05
    Tenzen just lost handmade + autoplay scaffolds; ε=0.08 was adding
    ~1 wasted random summon per game on top of an already noisy policy.
    Dropping ε cleans the training signal.

  Apr 19         "train weakest until dominant" cron
    Hourly cron at :23 checks 5-iter-avg class freq. If current focus
    power becomes the class-freq leader, bookmarks its model_<power>.json
    as model_<power>_done.json, rewires FOCUS_POWER to the new weakest
    power in all three scripts, and prompts user to manually restart the
    coordinator (systemd inherits env, self-restart on mtime alone won't
    flip FOCUS_POWER). Round-robin training strategy.

  Apr 19         bench rolloutDepth=0 experiment
    Tested pure-value-head leaves (no rollout). Fixed a bug first:
    minDepth=0 wasn't actually disabling rollout — it kept simulating
    until round change. Added short-circuit at the top of rollout().
    50-game bench: all powers at rolloutDepth=0 → Tenzen 16% (unchanged
    from baseline ~17%). Tenzen-only rolloutDepth=0 → Tenzen 8%, Xarm
    surged to 48%. Tenzen's value head isn't well-calibrated enough for
    pure AlphaZero-style leaf eval; rollouts advance past battles to
    states where payoffs are visible. Rolled back; kept --rollout-depth
    and --rollout-depth-power CLI flags on benchmark for future
    isolation experiments.

  Apr 19         tree-depth probe
    Instrumented search.ts to walk the MCTS tree at end of run. Tree is
    very shallow: ~500 iters, ~30 root children, max-depth 3 (rarely 4+),
    avg leaf depth 2.3. Most search budget broadens at depth 1-2 rather
    than deepening. Reason: select() only descended when a node had zero
    untried actions — forced full breadth-first expansion before PUCT
    could pick among children.

  Apr 19         AZ-style select (then isolated to Tenzen)
    Rewrote select() to jointly score children and untried actions (FPU
    for untried) via PUCT. When an untried wins, it's swapped to the end
    of untriedActions so expand() pops the chosen one. Let promising
    lines deepen earlier. Also raised DEFAULT_ITERATIONS 2000 → 100000
    so iteration cap is purely a safety net; 300ms time cap is the real
    budget.

    50-game benches:
      - classic, all powers        → Tenzen 17% (baseline)
      - AZ-style, all powers       → Tenzen 16%
      - AZ-style, Tenzen only      → Tenzen 12%
    AZ-style did not help Tenzen and may be hurting (within noise).
    Hypothesis: Tenzen's policy priors aren't sharp enough; AZ focuses
    on top-prior actions and misses alternatives that classic's
    broaden-first would have tried. Left AZ-style gated on forPower ===
    'tenzen' to observe its interaction with Tenzen's training dynamics
    over time.

  Apr 19         ε-greedy → Dirichlet root-prior noise
    Swapped destructive ε=0.05 uniform-random summons for AlphaZero-style
    Dirichlet(α=0.3) noise blended at weight 0.25 into root priors.
    Training-only (collect-data.ts); bench and server use raw priors.

    Why: ε was sabotaging games — a random cultist in a losing region
    gets the state labeled "Tenzen lost" when the real cause was the
    random summon. Dirichlet just perturbs WHICH actions PUCT considers
    first; MCTS still picks the best action it finds. Sensible games,
    diverse distributions.

    Implementation: sampleGamma (Marsaglia-Tsang for α≥1, α<1 recursion)
    drives a per-root simplex draw over unique canonical action slots.
    Math.random() — not replay-seeded, since training noise isn't
    meant to be reproducible per-game.

    ε default 0 in collect-data.ts and all three deploy scripts; --epsilon
    kept as a CLI override for back-compat.

  Meta
    - distributed scripts (coordinator + both workers) re-exec themselves
      when their file mtime changes (picks up push-hetzner rsync without
      manual restart).
    - class freq (130k rows/iter, ±0.2% CI) is the decision signal.
      Bench (48 games, ±13% CI) is context only.
    - benchmark + benchmark-parallel now support --rollout-depth-power
      for per-power rollout depth isolation.
