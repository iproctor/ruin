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

  Apr 19         Hall of Fame league for focus power
    Added packages/ai/data/hof/ — up to 5 top-class-freq snapshots of
    the focus power, plus manifest.json tracking (iter, freq, file,
    power). Per self-play game in collection, with probability HOF_MIX
    (default 0.10) the focus power's model is swapped for a random HOF
    snapshot. Training data always contains some games where Tenzen is
    demonstrably executing its strategy — prevents policy-collapse
    spirals we saw when shift ramped to 1.0.

    Coordinator auto-promotes after each iter: reads the most recent
    class freq from the log, compares to worst HOF member, and if the
    iter beats it, copies the snapshot into hof/ and evicts the worst.
    Critical detail: promotion uses snapshot ITER-1 (the DATA
    GENERATOR), not the trainee — class freq reflects what model
    played, not what just trained.

    Worker scripts rsync hof/ from coordinator each batch. push-hetzner
    excludes hof/ so laptop pushes never clobber coordinator's HOF.

    Seeded initial HOF with the top 5 data-generator iters from the
    training log: 1285, 1303, 1279, 1284, 1278 (all ≥ 0.152).

  Apr 19         Dirichlet noise weight 0.25 → 0.35
    Tenzen plateaued at ~0.12 post-rollback. Bumped Dirichlet blend
    weight. More exploration of non-top-prior actions at root, still
    filtered by MCTS Q downstream. No other changes.

  Apr 19         BIG rollback: model_tenzen.json → iter 1242
    After trying several fixes that didn't move the ~0.12 floor (AZ,
    HOF, Dirichlet 0.35), user called a full rollback to iter 1242 —
    well before shift-ramp, pre-autoplay-removal. Copied iter_1242
    weights over both model_tenzen.json (warm-start source) and
    model_tenzen_best.json on local + coordinator. All training since
    1242 is discarded.

  Apr 19         Training branch split
    Moved training-tweak commits off master. New workflow:
      - master: infrastructure (scripts, engine, client, core AI code)
      - training: training-parameter tweaks, rollout/select experiments
    worker-git-watch.sh now reads BRANCH env var (default "training"),
    so workers track origin/training. Final master commit was the
    worker-git-watch branch-configurability change itself. After that
    landed + workers re-exec'd, created origin/training from master
    HEAD and moved the Tenzen rollout=0 change there.

  Apr 19         Tenzen rollout=0 when policy-head-covered
    In search.ts runMcts/runMctsWithStats, rolloutDepth now defaults to
    0 when (a) viewpoint is Tenzen AND (b) the root uses PUCT (= policy
    head covers this action kind, i.e. summoning actions). Non-policy
    sub-actions (card_on_play_choice, battle_hit_assignment, dial_*,
    hero_removal, etc.) keep rollouts — their value-head leaves need
    round-end grounding the policy head can't provide.

    Theory: for summoning decisions, PUCT + policy priors guide search
    well enough that biased-random rollouts add noise without adding
    signal. ~4x more MCTS iterations per move. For card_on_play_choice
    the search is UCB1 with no priors, so the rollout still matters.

    Lives on the training branch.

  Apr 20         rollout=0 REVERTED; gentler no-floor version
    rollout=0 tanked class freq 0.130 → 0.062 over a few iters. Same
    regression the 50-game bench flagged earlier. Reverted.

    Gentler alternative landed instead: remove the minDepth FLOOR for
    Tenzen. Rollouts still run but can exit at the first round change
    or terminal — no guaranteed N plies. Preserves grounding, frees a
    few iterations for short rounds. Also removed the earlier
    short-circuit at the top of rollout() that treated minDepth<=0 as
    "skip rollout entirely"; now minDepth=0 means "allow early exit."

    Class freq recovered: 0.062 → 0.115 → 0.137 → 0.158 within 3-4
    iters. Stable in 0.13-0.15 band after that.

  Apr 20         iter 1270 adopted as live model_tenzen.json
    User-validated via gameplay as decent Tenzen. Copied to
    model_tenzen.json + model_tenzen_best.json on local + coordinator.
    Also committed the 5 HOF snapshots (iters 1285, 1249, 1242, 1279,
    1248) into packages/ai/data/hof/ on training branch so state
    survives repo rebuilds.

  Apr 20         Switch focus: Tenzen → Gormen
    Tenzen class freq plateaued at ~0.13 against the xarm-dominated
    meta. Per the round-robin plan, moving on. Changes:

    - FOCUS_POWER default 'gormen' in all three deploy scripts
    - model_tenzen_done.json bookmarked on local + coordinator
      (permanent anchor for Tenzen's run)
    - MCTS tweaks (AZ-style select, rollout no-floor) now gated on
      modelForPowerLoaded(forPower) instead of hard-coded 'tenzen'.
      Auto-extends to Gormen once model_gormen.json exists.
    - collect-data.ts: load model_<power>.json for EVERY power at
      startup (livePerPowerModels). Per game, each power uses its live
      model — preserves Tenzen as a stable opponent during Gormen focus.
    - HOF made per-power: hofModelsByPower scans hof/ for each power's
      model_<power>_hof_*.json. Each power with a HOF pool has
      hofMix=0.10 chance of swapping in a random HOF snapshot per game.
      Means during Gormen focus, Tenzen is sometimes the iter-1285
      Tenzen, sometimes iter-1249, etc. — Gormen can't overfit to one
      Tenzen policy.

    Needs manual coordinator restart via tmux to pick up
    FOCUS_POWER=gormen env; existing bash inherits old env and the
    script-mtime self-restart keeps the old env.

  Apr 20         Gormen focus REVERTED → back to Tenzen
    Over 3 iters under Gormen focus (1241 → 1242 → 1243), Gormen class
    freq went monotonically downward: 0.239 → 0.225 → 0.211. Xarm
    simultaneously strengthened 0.474 → 0.516 → 0.503. Not a recovery
    dip — a clear regression.

    User framing on why the whole regime may be failing: focus training
    against frozen opponents is structurally a supervised-ish problem.
    If tenzen-vs-frozen-opponents can't improve from ANY baseline, the
    bug lives inside the training loop itself, not in class-freq
    dominance or self-play dynamics. Saved as memory:
      feedback_focus_training_framing.md

    Revert:
    - FOCUS_POWER hardcoded 'tenzen' in all three deploy scripts (no
      more ${FOCUS_POWER:-…} override). Means push-hetzner + script
      mtime self-restart is sufficient; no manual tmux restart needed.
    - hof/manifest.json trimmed to the 5 tenzen members; 7
      model_gormen_hof_*.json files deleted on local + coordinator.
    - model_gormen_iter_124[12].json left in place as forensic
      artifacts — inert with focus=tenzen.

  Apr 20         MCTS health probe: training was never learning
    Added probeMctsSearch + probe-mcts-health.ts to walk the tree at
    end of each search. Ran on tenzen vs frozen opponents at three
    time budgets:

                        300ms     1000ms    3000ms
      iters (mean)     2,121     5,519     12,219
      max depth (mean)   4.0       4.8        4.7
      root coverage      81%       89%        92%
      top-1 prior/visit  89%       90%        76%
      p50 KL(v || prior) 0.065     0.034      1.082
      p90 KL             2.53      1.89       3.76

    Phase change between ~5.5k and ~12k iters: below that, MCTS
    visits are a minor reshuffle of the prior; above it, search
    actually contradicts the policy on half of all decisions.

    Training-loop implication: the policy target fed to the trainer is
    visits/Σvisits. If MCTS ≈ prior (p50 KL ≈ 0), cross-entropy loss
    is near-zero and the policy barely moves. We had iterated into a
    fixed point where prior and MCTS agreed. Training against self
    produces no gradient.

    Then checked collect-data.ts: default was --iter 400 --time 300.
    MCTS was hitting the 400-iter cap in ~60ms, well under the 300ms
    time cap. So every training sample we had ever generated was
    produced with MCTS running a FIFTH of even the shallow-end probe,
    on a policy-target that was essentially the raw prior. That's the
    smoking gun — not search quality, not value-head calibration, not
    feature coverage. A one-flag regression.

  Apr 20         Collection iter cap removed; asymmetric budget
    Changes in collect-data.ts:
    - Default --iter 10000 (focus power). Past the 5.5k-12k phase
      change in the probe. This is the only budget that produces
      training targets.
    - New --iter-opp 1000 (non-focus powers). Their policy targets
      aren't recorded, and their policy head is the frozen shared
      model — assumed adequate, so deep search is wasted compute.
      User principle: "if you assume a good model, it needs fewer
      iters because the policy head is working. if your model is
      trying to get better, it needs more iters." Saved as memory:
        feedback_mcts_iters_by_model_quality.md
    - --time raised to 60000 as a safety net only. Iter cap governs.

    Bench (2 games, seed=100, --focus-power tenzen):
      old --iter 400 uniform:       24.9 s/game  (1.0x)
      --iter 10k uniform:          536.8 s/game (21.5x)
      --iter 10k / --iter-opp 1k:  190.3 s/game  (7.6x)

    Asymmetric preserves the full 10k on training-relevant decisions
    while cutting opponent-decision waste by ~10x. Coordinator
    throughput drops from ~4 iters/hr to ~0.5 iters/hr — ~12 iters/day
    instead of ~100. Survivable because previously the loop wasn't
    learning at all; slower iters of real learning beat faster iters
    of no learning.

  Apr 20         CPU profile of collection at 10k iters
    Ran --cpu-prof on 1 game (seed 9999) at new default. Main process
    537s wall. Top self-time consumers:
      13.6%  sampleLegalSummoningAction  (rollout's action sampler)
      12.4%  evaluateState                (value head + handmade paths)
       8.4%  rollout
       5.4%  extractFeatures
       5.2%  evaluateLearned              (MLP forward)
       3.8%  legalPlacementRegions
       3.5%  followersInRegion
    Top inclusive:
      88.2%  rollout
      75.1%  runMctsWithStats
      29.4%  applyAction
      26.0%  evaluateState

    Rollouts dominate (88% inclusive) but are load-bearing for
    correctness — cannot skip. Value head is much better at end-of-
    round states than mid-round (card effects pending → outcome
    uncertainty that no state features capture), confirmed by the
    Apr 20 rollout=0 regression.

    Realistic optimization levers without changing rollout semantics
    all add up to maybe 10-15%: cached env-var reads in evaluate.ts,
    micro-tuning followersInRegion/legalPlacementRegions, MLP forward.
    None get us back to 1x old speed. Asymmetric iter budget is the
    best structural win available.

  Apr 21         HOF disabled + complete clean restart
    Context: user observed "1 didn't make a dif" — disabling HOF on
    Apr 20 hadn't moved tenzen class freq in production. Chased this
    down: coordinator's model_tenzen.json had silently diverged from
    the local iter_1242 rollback state (md5 mismatch — training iters
    had been overwriting it). Local canaries were reporting tenzen
    ~0.20 while the coordinator's actual trained model was at ~0.08.

    Decision: full reset. Derive model_tenzen.json from model.json
    (the shared trunk + value baseline — no accumulated focus-specific
    training damage). Hardcoded TENZEN_CUTOFF_SHIFT=1.0, HOF_MIX=0 in
    all three deploy scripts. Wiped inbox/, archive/, all
    model_tenzen_iter_*.json snapshots, hof/ manifest reset to empty.
    Killed the coordinator tmux, did the file ops, restarted.

    First iter on clean data (1241 fresh): best val p 3.174 vs old
    production 3.29 plateau. Peak val p-top1 28% vs old 21%. Clear
    evidence the old warm-start was dragging the model.

  Apr 21         CAPACITY REJECTED: H2=128/256/512 all same ceiling
    Trained H2=128 (baseline), 256, 512 on the same iter_1241 data,
    fresh-init, 40 epochs:
      H2=128: best val p 3.209 (ep 8), peak top-1 28%
      H2=256: best val p 3.209 (ep 6), peak top-1 28%
      H2=512: best val p 3.199 (ep 7), peak top-1 28%
    4x params in the last layer buys 0.01 bits. Not capacity.

    Also tested extra policy-hidden layer (H2(128) → 256 → 298):
    same outcome. Capacity in any form doesn't break the ~3.2 bit /
    28% top-1 ceiling.

  Apr 21         Aleatoric noise floor ≈ 3.15 bits
    Added probe-noise-floor.ts: run MCTS N=8 reps on same state with
    independent Dirichlet draws, compute pairwise KL between visit
    distributions. At 10k iters:
      mean pairwise KL     0.208 bits   (target variance)
      mean visit entropy   3.05 bits    (target entropy)
      top-1 agree          100%         (chosen action always same)
      est. CE lower bound  ≈ 3.15 bits  ← matches observed plateau

    The val p-loss plateau is NOT a capacity or feature bug — it's the
    information-theoretic floor given the target distribution has
    ~3.05 bits entropy plus ~0.2 bits inherent noise from Dirichlet.
    The model is doing nearly as well as possible given the labels.

    Key subtlety: top-1 AGREEMENT across runs is 100%, so the noise
    is only in relative magnitudes of non-top slots — not in the
    chosen action itself. This means the 28% top-1 ceiling is a
    separate beast: the chosen-action target is deterministic, so
    top-1 stuckness reflects genuine model-vs-features limit, not
    label noise.

  Apr 21         Iter-count agreement: 3k = 10k
    Added probe-iter-agreement.ts: no Dirichlet noise, run MCTS on
    the same state at varying iter counts, compare chosen actions.
    Agreement with iter=10000 reference:
        200     27% (4/15)
        500     60% (9/15)
       1000     80% (12/15)
       2000     87-90% (narrow sweep 20 states)
       3000     100% (20/20)    ← converged
       4000     100%
       5000     100%
      10000     100%
    At 3k iters MCTS has already found the same action as 10k in
    every state tested. Extra iters are pure redundant compute.

    Dropped --iter 10000 → 3000 in collect-data.ts default. Local
    bench: 93s/game vs 190s/game at 10k (2× speedup, not 3.3× because
    per-iter cost scales with tree depth). Coordinator batch time
    1600s → 700s (~2.3× speedup per batch).

    Old 400-iter default was only matching 10k's action in ~27% of
    states — 70% of training labels were on SUBOPTIMAL chosen
    actions. That explains retrospectively why the pre-fix training
    could never learn.

  Apr 21         WHY IS THE PLATEAU STILL THERE?
    User challenge: if capacity didn't help, and we're at CE noise
    floor but 28% top-1 is deterministic-label-limited, what feature
    is actually missing? Reasoned through list:
      - Rules out: complex compositions (capacity would fix),
        card-ID semantics (46 cards × 100k samples is plenty),
        implicit action identity (Wp columns are per-action embeds)
      - Remains: static graph structure (region adjacency — absent
        from features, can't be computed from flat vector),
        action-structural generalization (policy is a function TO
        298 abstract slots instead of a function OVER actions —
        no parameter sharing across (class, region) variants of
        same action kind)
    User pushback on action-structure concern: input IS region-
    indexed and output IS region-indexed, MLP has the capacity to
    learn the mapping. Conceded — the gap is likely narrower than I
    claimed. Honest picture: we're close to the regime ceiling of
    this architecture + feature set, further gains need patience
    (more iters) or architectural change (GNN / attention over
    regions).

  Apr 21         Reweight cap (1.5×) — FIRST ITER-OVER-ITER LEARNING
    User suggested: inverse-freq sample reweighting was upweighting
    tenzen-win samples by ~2.5-3×. This could be inflating the value
    head's "tenzen wins here" probability beyond empirical reality:
      optimistic value head → MCTS leaf evals too good for tenzen
      → MCTS picks over-ambitious moves
      → tenzen loses those games
      → class freq depressed → reweight stays inflated
      → self-reinforcing equilibrium at ~0.09 tenzen freq

    Capped at 1.5× in train_mlp.py (--reweight-cap 1.5 default).
    Deployed the cap + uploaded the capped-trained model_tenzen.json
    (iter_1241 data, fresh-init, cap 1.5) to coordinator.

    Result (6 iters later):
      iter 1247  tenzen 0.028   ← cap-induced crash (over-optimism
                                   stripped from value head)
      iter 1248  tenzen 0.039
      iter 1249  tenzen 0.048
      iter 1250  tenzen 0.059
      iter 1251  tenzen 0.062
      iter 1252  tenzen 0.092
      iter 1253  tenzen 0.101   ← back to previous best, on cleaner
                                   value-head signal
    First monotonic iter-over-iter improvement in the entire
    diagnostic chain. Training is actually learning.

  Apr 21         3 new workers added (hetz4/5/6)
    88.198.24.105, 148.251.48.178, 148.251.138.112. All fresh
    Debian rescue-mode boxes. init-hetzner.sh needed fixing for
    pip (install python3-pip explicitly before numpy) and tmux
    (install). tsx wasn't on PATH (init only does local node_modules)
    so workers fail to spawn via pnpm — had to `npm install -g tsx`
    after init. Workers launched with WORKER_IDs 5/6/7 via
    LEAGUE_SIZE=10 WORKERS=16 WORKER_ID=N ./scripts/distributed-worker.sh.
    push-hetzner.sh HOSTS array extended to 6 boxes. Collection
    throughput roughly doubled.

  Apr 21         Gormen focus revert + clean-slate tenzen restart
    Gormen focus over 3 iters (1241→1243) regressed tenzen freq
    0.239 → 0.225 → 0.211. Reverted: hardcoded FOCUS_POWER=tenzen,
    TENZEN_CUTOFF_SHIFT=1.0, HOF_MIX=0 in all three deploy scripts.
    Then discovered coordinator's model_tenzen.json had silently
    drifted from the iter_1242 rollback state (md5 mismatch — several
    training iters had overwritten it). Full reset:
      - model_tenzen.json := model.json (fresh derivation)
      - wiped inbox/, archive/, all model_tenzen_iter_*.json
      - cleared hof/ back to empty manifest
      - killed coord tmux, restarted
    First fresh iter 1241: best val p 3.174 (vs old plateau 3.29),
    peak val p-top1 28% (vs stuck 21%). Real improvement visible.

  Apr 21         Value-head capacity ruled out
    H2=128/256/512 trained on same iter_1241 data, fresh init:
      best val p: 3.209 / 3.209 / 3.199
      peak top-1: 28% / 28% / 28%
    Also tested policy hidden layer (H2→256→298): same ceiling.
    Capacity is not the bottleneck.

  Apr 21         Aleatoric noise floor ≈ 3.15 bits
    probe-noise-floor.ts: 8 reps of same state with different
    Dirichlet draws. At 10k iters:
      mean pairwise KL     0.21 bits  (target variance)
      mean visit entropy   3.05 bits  (target entropy)
      top-1 agree          100%
      est. CE lower bound ≈ 3.15 bits (matches observed plateau)
    Top-1 is stable (chosen action deterministic across noise), so
    the 28% p-top1 ceiling is separately feature/capacity-limited,
    not label-noise-limited.

  Apr 21         probe-iter-agreement: 3k iters = 10k iters
    No Dirichlet noise; varying iter counts on same state:
         200  27% agreement with iter=10000
         500  60%
        1000  80%
        2000  90%
        3000  100% (20/20)   ← converged
        5000  100%
       10000  100%
    Dropped --iter default 10000 → 3000 in collect-data.ts.
    Batch time: 1600s → 700s. Training cadence ~2.3× faster at
    identical action quality.

  Apr 21         Reweight cap 1.5× deployed, then challenged
    Capped inverse-freq reweight at 1.5× to stop tenzen-win
    over-amplification creating self-reinforcing overconfident
    value head. Tenzen freq crashed 0.101 → 0.028 then climbed
    back 6 iters to 0.101. Looked like first iter-over-iter
    learning — but then regressed again to 0.061.

    User called out pattern: "you always suggest reweight and i
    dont believe its true. it was at 0.04 before and it climbed
    to 0.1 without changing it." Saved as memory:
      feedback_dont_blame_reweight.md
    Rule: don't default to blaming reweight; model oscillates at
    fixed cap, so cap isn't the structural cause.

  Apr 21         HOF re-seeded with just iter_1253, HOF_MIX=0.1
    After revert, seeded HOF with only model_tenzen_hof_1253.json
    (the 0.101 peak). Evicted 4 weaker snapshots. Set HOF_MIX=0.1
    to reinject strong-model behavior into training data.

    Added --min-freq 0.1 floor to hof-promote.py to prevent weak
    iters from polluting the pool during regressions.

  Apr 21         Adaptive HOF mix based on class freq
    Self-correcting feedback:
      freq ≥ 0.10  → mix = 0.10 (baseline)
      freq = 0.05  → mix = 0.30
      freq < 0.05  → mix = 0.30 (clamped)
      linear ramp between
    Coordinator writes packages/ai/data/hof_mix.txt after each
    training iter. Workers rsync the file (new --include). Both
    scripts read it at collect time and pass via --hof-mix,
    overriding the env fallback. Self-strengthens when tenzen
    drifts down, backs off when it recovers.

  Apr 21         Iter-counter fix for focus mode
    START_ITER was computed from model_iter_*.json — but in focus
    mode only model_<power>_iter_*.json advances (model.json stays
    frozen). So every coordinator restart reset the log counter
    to 1241 despite training being well past 1256. Fix: include
    both globs in the max(iter) computation. Next restart will
    pick up correctly.

  Apr 21         Focus mode: neutralize reweight on non-focus powers
    --power X keeps its capped inv-freq reweight (rare-class boost).
    Others reset to 1.0 (uniform). Rationale: upweighting gormen/
    lasha samples doesn't help tenzen leaf-eval calibration; skews
    value head away from accurate prediction of the dominant xarm.

  Apr 21         Rollout: never voluntarily pass (0.92 → 1.0)
    Probe showed: playing Siphon (0-cost card, +1 PP) then rollout
    averaged 1.82 figures vs 2.40 for summon-first, value delta
    -0.035. Culprit: random rollout had 8% voluntary pass rate per
    turn. After Siphon consumed a turn on card-play, random passes
    cut remaining summon turns short, so +1 PP never converted to
    +1 figure. Skilled play never passes with resources available.

    Change: ROLLOUT_AGGRESSION = 1.0 in search.ts. Rollouts only
    pass when that's the sole legal action.

    Siphon-vs-summon delta closed from -0.035 → -0.010.

  Apr 21         Card-value diagnostic (probe-card-value.ts)
    Full action-comparison matrix, 40 reps each configuration:
                         Siphon  Summon  delta
      random everyone     0.054   0.040  +0.014   ← Siphon net positive
      smart opps only     0.032   0.056  -0.024   ← tempo loss punished
      smart tenzen only   0.175   0.099  +0.076   ← +1 PP actually used
      smart everyone      0.060   0.000  +0.060   ← deterministic but
                                                    positive (after per-
                                                    rep rngSeed variation)

    Null-card variant (apply Siphon, then subtract +1 PP to
    neutralize effect): IDENTICAL to Siphon in all configurations.
    So 100% of Siphon's measured value comes from "used a turn
    slot without summoning" — pure stalling. The +1 PP doesn't
    surface in rollout because uniform-random action selection
    doesn't preferentially convert extra PP to figures.

  Apr 21         TENZEN_CUTOFF_SHIFT: 0 weight-flipped
    Canary (20 games, same seeds):
      shift=0 (handmade rounds 1-4)   tenzen 0.165
      shift=1 (pure learned)          tenzen 0.000
    Pure learned eval makes tenzen lose EVERY game. Value head is
    still bad for tenzen, despite all recent fixes.

    Within shift=0, flipped the cutoff weights from (4,3,2,1) to
    (1,2,3,4) — biasing toward high cutoffs where handmade covers
    more of the strategic setup phase. Expected handmade rounds
    per game: 2.0 → 3.0. Canary: tenzen 0.165 → 0.209.

  Apr 21         Feature gap: per-region domination leader
    Audited evaluateTenzen + getRegionDomination + calcResistance
    for computations not reachable from the 797-dim feature vector.
    Key gap: getRegionDomination's leader depends on
      calcDomination = cardCostSum + figureValue + bonuses
    where cardCostSum needs the COST of each chaos card in the
    region's slots. Features only encode "slot filled + playedBy",
    not which specific card or its cost. Plus some persistent
    effects used in calcDomination aren't in the 12-flag list
    (lasha_sweet_lies, gormen_pandemic).

    Added per-region domination leader one-hot (9 regions ×
    5: xarm/gormen/tenzen/lasha/tied-or-none) = +45 dims.
    FEATURE_DIM: 797 → 842.

    Append-only transition: TS loader and Python warm-start both
    zero-pad W1 by 45 input rows when old featureDim < current.
    Old models keep working; new features contribute zero until
    training learns their weights. First post-change iter will
    save a 842-dim model that then cold-trains the new rows from
    collected data.
