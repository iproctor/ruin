# AI — notes for Claude

This package is on the hot path of self-play training. Changes here affect how every iteration plays. A subtle bug in features, rollout, or MCTS can poison thousands of training samples before anyone notices.

## Architecture in one paragraph

`runMcts` runs PUCT-based MCTS. The root child priors come from the policy head of `model.json`. Selection uses PUCT with First-Play Urgency (parent_avg − 0.1 for unvisited children). Expansion pops one untried action. Rollouts are biased-random until either the round number changes (so battle/corruption resolve) or a hard cap of 120 plies. Leaf value comes from the value head (or the hand-tuned heuristic if no model is loaded). Visit counts at the root are dumped as policy training targets by `runMctsWithStats`.

## Invariants — do not violate

- **Features are append-only.** `extractFeatures` returns a 736-dim vector. Reordering or inserting features mid-vector silently invalidates every existing model. Always add to the end and bump the dimension constant in lockstep.
- **Hidden info must respect viewpoint.** The hand encoding is viewpoint-conditional (features.ts). Don't add features that leak other powers' hands.
- **Action canonicalization is fixed.** 298 slots: `[0, 27)` summons (3 classes × 9 regions), `[27, 297)` card plays (30 cards × 9 regions), `[297]` pass. Multiple legal actions can map to the same slot — the policy aggregates them.
- **Rollout deliberately skips `filterPointlessActions`.** Profiling showed it was ~14% of total runtime in rollouts and didn't change leaf value estimates meaningfully. Don't re-add it inside the rollout loop. Root + tree expansion still use it.
- **`isPointlessAction` is precondition-based, not strategic.** Only block actions whose card text genuinely cannot fire. Strategy goes in the value/policy head, not the filter.
- **`MAX_ROOT_ACTIONS = 24`** — root branching cap. The class-aware sampling in `pruneActions` ensures cards get half the budget so the policy head sees them in training data despite the value head's bias toward summons.

## Common pitfalls

- **Tree-empty crashes.** `bestAction` throws when both `root.children` and `root.untriedActions` are empty. That can only happen if `expand` failed for every popped action — meaning `applyAction` threw on apply for everything. The new logging in `expand` (search.ts) writes the full failing state to `/tmp/mcts-expand-throws.log` when it fires; treat any entry there as a bug to root-cause, not to paper over.
- **Adding a new always-keep bias.** New biases go in `filter-actions.ts` as a function returning `boolean`, then wired into `pruneActions` in `search.ts` where the existing biases are. Keep them narrow — broad biases distort training and produce a brittle model.
- **MCTS sims and time caps.** Default 2000 iterations, 300ms time cap. Both come from `MctsOptions`. The collection script (`collect-data.ts`) currently passes `--iter 400 --time 300` for speed.
- **Worker threads load the model lazily.** `loadLearnedModelIfPresent` runs at process startup. If you spawn a worker mid-process and want it to share the model, the worker needs to call it itself.
- **Dist drift.** The package compiles to `dist/` which is what `tsx`-spawned worker processes import. After editing `src/`, run `pnpm --filter ai build` before relying on the change in a running loop.

## Don't add to this package

- React, JSX, browser globals
- Express / DB code
- Engine rules — those belong in `@ruin/engine`
- Synchronous file I/O on the hot path (rollouts run millions of times per training iter)

## Profiling

The bottleneck is rollouts (~68% inclusive). To re-profile:

```bash
mkdir -p /tmp/cpuprof
NODE_OPTIONS="--cpu-prof --cpu-prof-dir=/tmp/cpuprof --cpu-prof-interval=500" \
  npx tsx packages/server/src/scripts/collect-data.ts --games 2 --seed 9999 --out /tmp/prof.jsonl
```

Then load the .cpuprofile file in Chrome devtools (Performance tab → Load profile).
