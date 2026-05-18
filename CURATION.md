# Training Data Curation

This project now treats self-play data as a measured training window, not just
"new rows plus some old rows". The goal is to keep the learner on-policy enough
to improve against its current opponents while deliberately preserving coverage
of hard, rare, and strategically important states.

## Data Flow

Collection writes JSONL rows from summoning decisions:

```json
{
  "x": [...],
  "t": [0.82, 0.74, 0.91, 0.66],
  "p": 2,
  "visits": { "13": 80, "22": 40 },
  "meta": { "...": "..." }
}
```

`scripts/distributed-coordinator.sh` now builds:

- `packages/ai/data/training_recent_raw.jsonl`: raw concatenation of inbox plus archive fill.
- `packages/ai/data/training_recent.jsonl`: curated training set used by `train_mlp.py`.
- `packages/ai/data/training_recent_report.json`: coverage report for the raw and curated sets.

If curation fails, the coordinator falls back to the raw window.

## Row Metadata

New rows include `meta` from `packages/server/src/scripts/collect-data.ts`.

Important fields:

- `round`: game round at the sampled decision.
- `actingPower`: power making the decision.
- `legalCount`: number of legal summoning actions.
- `fullSearch`: whether this row came from a full MCTS search.
- `policyRow`: whether `visits` were emitted.
- `visitEntropy`: entropy of MCTS visit distribution. Higher means MCTS saw multiple plausible actions.
- `top1Share`: visit share of the most-visited action. Lower means less obvious.
- `powerPoints`: actor PP at the decision.
- `ruinedRegions`: count of already ruined regions.
- `nearRuinRegions`: non-ruined regions with corruption already present and within 2 corruption of ruination.
- `vp` / `threat`: current per-power progress signals.
- `complete`: whether the game reached a real terminal/completed state.
- `stopReason`: `complete`, `maxActions`, `noPendingAction`, `actionSelectError`, or `applyError`.
- `winners`, `finalVp`, `finalThreat`, `finalRounds`, `finalRuinationCount`.
- `targetVersion`: currently `progress_v1`.

Legacy rows without `meta` are still supported by the curator. It infers only
what it can from `x`, `p`, `t`, and `visits`.

## Curator

Script:

```bash
python3 packages/ai/scripts/curate_training.py \
  --in packages/ai/data/training_recent_raw.jsonl \
  --out packages/ai/data/training_recent.jsonl \
  --max-samples 240000 \
  --seed "$ITER" \
  --report packages/ai/data/training_recent_report.json
```

Current quota targets:

- 25% high-information policy rows.
- 18% late-game rows.
- 15% actor-behind rows.
- 12% close-leader rows.
- 10% near-ruin rows.
- Remaining rows balanced by round and acting power.

These are overlapping strata, not disjoint buckets. A late, close, high-entropy
policy row can satisfy several goals.

Coordinator knobs:

```bash
TRAIN_CURATE=1          # enable curation; set 0 to use raw recent window
TRAIN_MAX_SAMPLES=240000
TRAIN_WINDOW=180        # raw batch window before curation
```

## Reading The Report

`training_recent_report.json` has `input` and `selected` sections. Compare them
every few iterations.

Core fields:

- `rows`: total rows.
- `power`: rows per acting power.
- `round`: rows by round bucket.
- `policy_pct`: fraction with policy targets.
- `complete_pct`: fraction from completed games.
- `late_pct`: round 4+ rows.
- `behind_pct`: actor target trails best target by at least 0.15.
- `close_pct`: top two final targets within 0.08.
- `near_ruin_pct`: sampled state has at least one real near-ruin region.
- `visit_entropy_avg`: average entropy across policy rows.
- `top1_share_avg`: average top-action visit share across policy rows.

Healthy values are not fixed. Watch trends and correlations with h2h results.

## What To Look For

### Power Imbalance

If one power is overrepresented by rows but not improving, check whether its
rows are mostly easy/early decisions.

Symptoms:

- `power.<P>` is high.
- `policy_pct` for that power is low, or policy rows are low-entropy.
- h2h for that power is flat.

Tweaks:

- Increase balanced fill pressure by lowering `TRAIN_MAX_SAMPLES`.
- Add a per-power cap or per-power minimum inside `curate_training.py`.
- Increase collection full-search probability for the weak power if needed.

### Too Many Easy Policy Rows

Symptoms:

- `top1_share_avg` rises toward 0.75+.
- `visit_entropy_avg` falls.
- policy top-1 metrics look good, but h2h is flat.

Why it matters:

The net is mostly imitating obvious decisions. It gets confident without
learning the tactical branches where search actually adds value.

Tweaks:

- Raise the high-information quota.
- Tighten `high_info_policy`: increase entropy threshold or lower top1 threshold.
- Increase `fullSearchImportantBonus` during collection.

### Missing Late Game

Symptoms:

- `late_pct` below roughly 20-30%.
- h2h games lose from winning or close positions.
- value MAE looks good early but probes near endgame are unstable.

Tweaks:

- Raise late quota.
- Add a round 5+ minimum.
- Keep `TRAIN_WINDOW` larger if late-game samples are sparse.

### Missing Recovery / Defensive States

Symptoms:

- weak powers never learn to slow a leader.
- h2h shows runaway wins.
- `behind_pct` is low.

Tweaks:

- Raise actor-behind quota.
- Reduce actor-behind threshold from `0.15` to `0.10`.
- Add a quota for "leader is not actor and actor still has PP".

### Missing Ruination Tactics

Symptoms:

- poor region timing, bad domination decisions, or wasted corruption.
- `near_ruin_pct` low.

Tweaks:

- Raise near-ruin quota.
- Relax near-ruin definition from within 2 corruption to within 3.
- Add separate quotas for `nearRuinRegions >= 2` and `finalRuinationCount >= 4`.

### Too Much Curation / Too Little On-Policy Data

Symptoms:

- training loss improves but h2h regresses.
- policy prior/search agreement worsens across fresh games.
- new strategic adaptations do not enter the train set quickly.

Tweaks:

- Raise `TRAIN_MAX_SAMPLES`.
- Lower hard strata quotas.
- Add an explicit "recent natural self-play" reserve, e.g. always include 30-40%
  of newest rows before stratified selection.

## Suggested Operating Routine

Every few training iterations:

1. Open `packages/ai/data/training_recent_report.json`.
2. Compare `input` vs `selected`.
3. Check whether curation is meaningfully changing the window.
4. Compare h2h deltas against report trends.
5. Adjust one quota at a time and let it run long enough to see h2h movement.

Do not chase a single perfect distribution. The report is there to catch blind
spots and drift: too few hard policy rows, too little late game, missing
recovery states, or a power silently starving of useful examples.

## Current Baseline Observation

A probe on the current legacy `training_recent.jsonl` showed:

- input rows: 257,949
- curated rows: 240,000
- policy rows: about 20% -> 21%
- late rows: about 51% -> 51%
- behind rows: about 40% -> 40%
- close rows: about 55% -> 55%

That means the existing window was already late/close heavy. The new metadata
will make future reports more useful because `nearRuinRegions`, completion,
legal counts, full-search flags, and per-game outcomes will be real instead of
legacy fallbacks.
