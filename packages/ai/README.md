# @ruin/ai

MCTS-based AI player for Ruin, with a learned dual-head MLP (value + policy) trained from self-play.

## Public API

Exported from `src/index.ts`:

- **MCTS**: `runMcts(state, power, opts?)`, `runMctsWithStats(state, power, opts?)` (returns visit distribution for policy training)
- **Greedy**: `greedyAction(state, power)` — 1-ply lookahead, used as a fallback / cheap policy
- **Evaluator**: `evaluateState(state, power)` — value head if a model is loaded, hand-tuned heuristic otherwise
- **Features**: `extractFeatures(state, viewpoint)` — 736-dim float vector
- **Action canon**: `canonicalActionIndex(action)`, `inverseCanonicalAction(idx)` — 298-slot encoding for the policy head
- **Model**: `loadModel(json)`, `loadModelForPower(power, json)`, `Mlp`, `ModelJson`

## Layout

```
src/
├── evaluate.ts           hand-tuned heuristic value (bootstrap fallback)
├── greedy.ts             1-ply greedy action selector
├── mcts/
│   ├── search.ts         runMcts / runMctsWithStats main loop
│   ├── node.ts           MctsNode + UCB1 + PUCT (with FPU)
│   ├── filter-actions.ts pointless-action filter + always-keep biases
│   └── hit-allocation.ts per-(power, class) battle hit enumeration
└── learn/
    ├── features.ts       state → 736-dim feature vector
    ├── mlp.ts            dual-head TS MLP inference (v3 DualHeadMlpJson)
    ├── evaluator.ts      model loading + caching + policyForState
    └── action-canon.ts   298-slot canonical action space
```

## How it fits together

1. **Search loop** in `runMcts`:
   - Selection: walk tree by PUCT (or UCB1 if no policy loaded)
   - Expansion: pop one untried action, apply it, create child
   - Rollout: biased-random play until end of round + minDepth, value at the leaf
   - Backprop: visits + total score up the tree
2. **Value head** evaluates leaf states (4-dim softmax over which power wins).
3. **Policy head** seeds root child priors for PUCT — actions the policy likes get more search.
4. **Visit distribution** at the root is the training target for the next iteration of the policy head.

## Self-play training pipeline

```
collect-data.ts (in @ruin/server)
  ↓ runs runMctsWithStats per decision, dumps {features, winner, visits} to JSONL
training_iter_NNNN.jsonl
  ↓ rolling window concatenation
train_mlp.py (in scripts/, Python)
  ↓ dual-head training (cross-entropy for value, KL for policy)
model.json (v3 DualHeadMlpJson)
  ↓ loadModel() at next collect/bench startup
```

The orchestration loop is `scripts/training-loop.sh` in the repo root.

## Hand-coded biases

Three "always-keep" categories bypass the random root prune in `pruneActions`:

- **`isZeroCostCardPlay`** — 0-PP cards with met preconditions are free utility, never drop them
- **`isXarmDelayPlay`** — War Cry / Bloody Rebirth when their delay value is high (their reward is indirect and the value head undervalues them)
- **`isDacCompletion`** — tenzen-only nudges for the "one move from triggering DAC" cases (magic-symbol card into a region with a chaos stone, cultist into a region whose effective magic+stone count is already ≥2)

These exist because the value head systematically undervalues delayed-payoff cards. They're nudges, not constraints.

## Build

```bash
pnpm --filter ai build
```

The Python trainer (`scripts/train_mlp.py`) is invoked separately by the training loop and reads/writes `packages/ai/data/`.
