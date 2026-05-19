/**
 * Self-play data collection. Plays N headless AI-vs-AI games, recording
 * (feature_vector, target, visits) at every summoning decision point. Writes
 * JSONL to packages/ai/data/training.jsonl.
 *
 * Usage (from repo root):
 *   pnpm collect [--games 100] [--seed 1] [--out path]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createInitialState, applyAction, autoAdvance, GameLog,
  getLegalActions,
  type GameState, type Action, type Power,
} from '@ruin/engine';
import {
  runMcts, runMctsWithStats, greedyAction, extractFeatures, POWERS, powerIndex,
  canonicalActionIndex, ACTION_DIM, loadModelForPower, type ModelJson,
} from '@ruin/ai';
import { loadLearnedModelIfPresent } from './load-model.js';

loadLearnedModelIfPresent();

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
}

const gameCount = parseInt(getArg('--games', '50'), 10);
const baseSeed = parseInt(getArg('--seed', '1'), 10);
const maxActions = parseInt(getArg('--max-actions', '2000'), 10);
const outPath = getArg('--out', path.resolve('packages/ai/data/training.jsonl'));

// MCTS budget. Iter cap governs; time cap is a safety net. 5k uniform —
// post-r0 rollback (2026-05-03) bumped from 3k to 5k for all powers since
// r0 throws away the rollout signal and depth becomes the only refutation.
const mctsIterations = parseInt(getArg('--iter', '5000'), 10);
const mctsTimeMs = parseInt(getArg('--time', '60000'), 10);

// Playout-cap randomization: most turns use a cheap, no-noise search only to
// advance the game and produce value data. A sampled subset uses the full
// search budget and records a policy target. This spends deliberation where it
// creates labels instead of treating every shallow move distribution as sacred.
const fullSearchProb = parseFloat(getArg('--full-search-prob', '0.10'));
const fullSearchImportantBonus = parseFloat(getArg('--full-search-important-bonus', '0.20'));
const fastMctsIterations = parseInt(
  getArg('--fast-iter', String(Math.max(1, Math.floor(mctsIterations * 0.2)))),
  10,
);
const fastMctsTimeMs = parseInt(getArg('--fast-time', String(mctsTimeMs)), 10);

// All-r0 trial: rolloutDepth=-1 skips rollouts entirely; the value head is
// the leaf eval. All 4 power models adapt together to the resulting state
// distribution. --no-rollout-zero falls back to default rollout.
const allRolloutZero = !process.argv.includes('--no-rollout-zero');
const rolloutDepth: number | undefined = allRolloutZero ? -1 : undefined;

// Dirichlet noise on root priors (training-time exploration). Weight 0
// disables — useful for canary runs that isolate noise as a variable.
const dirichletWeight = parseFloat(getArg('--dirichlet-weight', '0.35'));
const dirichletAlpha = parseFloat(getArg('--dirichlet-alpha', '0.3'));
const dirichletNoise = dirichletWeight > 0
  ? { alpha: dirichletAlpha, weight: dirichletWeight }
  : undefined;

// HOF mix: per game, for each power, with this probability swap the live
// per-power model for a random hall-of-fame snapshot for that power. Reduces
// overfitting to the current opponent policy distribution. 0 disables.
// Restored 2026-05-03 (post-r0 rollback to iter 1650 era).
const hofMix = parseFloat(getArg('--hof-mix', '0'));

// Temperature on summoning move selection. For rounds <= tempRounds, sample
// the action proportional to MCTS visit counts (τ=1) instead of taking
// max-visits (τ=0). AlphaZero-style exploration: generates diverse opening
// trajectories so off-policy lines enter training data, breaking r0 mutual
// blindness over many games. Set 0 to disable. Visit counts in the training
// sample are unchanged — temperature only affects which action is *played*.
const tempRounds = parseInt(getArg('--temp-rounds', '2'), 10);

// Auxiliary "suppress xarm" reward shaping at MCTS selection. Read from
// XARM_SUPPRESSION_LAMBDA env var (default 0 = disabled). When > 0 and the
// acting power is non-xarm, the exploitation Q at each MCTS node becomes
// own_avg_progress - λ × xarm_avg_progress instead of pure own_progress. This
// biases gormen/tenzen/lasha play toward lines that retard xarm's dial in
// addition to advancing their own VP. Anneal toward 0 as defence is learned.
const xarmSuppression = parseFloat(process.env.XARM_SUPPRESSION_LAMBDA ?? '0');
if (xarmSuppression > 0) {
  console.log(`[mcts] xarm suppression λ = ${xarmSuppression}`);
}

// Value-target blend: target = w_rank · final_rank + (1 - w_rank) · progress.
// Rank assigns 1.0 / 0.66 / 0.33 / 0.0 to 1st-4th place; winners (per
// state.winners) outrank all non-winners, then non-winners are tiebroken by
// progress; ties at any level share the average rank value. Incomplete games
// fall back to pure progress. Default 0.75 per the May 2026 reintroduction.
const rankBlendWeight = parseFloat(process.env.RANK_BLEND_WEIGHT ?? '0.75');
if (rankBlendWeight > 0) {
  console.log(`[target] rank blend weight = ${rankBlendWeight} (rank + progress)`);
}

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

// Snapshot the live per-power models (loaded by loadLearnedModelIfPresent)
// and the HOF pools BEFORE any HOF swap, so each game can pick its lineup
// fresh. Empty pools = HOF inactive for that power.
const livePerPowerModels: Partial<Record<Power, ModelJson>> = {};
const hofModelsByPower: Partial<Record<Power, ModelJson[]>> = {};
{
  const dataDir = path.resolve('packages/ai/data');
  for (const p of ALL_POWERS) {
    const live = path.join(dataDir, `model_${p}.json`);
    if (fs.existsSync(live)) {
      try { livePerPowerModels[p] = JSON.parse(fs.readFileSync(live, 'utf-8')) as ModelJson; }
      catch { /* malformed file — fall through to shared model */ }
    }
    if (hofMix > 0) {
      const hofDir = path.join(dataDir, 'hof', p);
      if (fs.existsSync(hofDir)) {
        const files = fs.readdirSync(hofDir)
          .filter(f => f.endsWith('.json') && f !== 'manifest.json');
        const pool: ModelJson[] = [];
        for (const f of files) {
          try { pool.push(JSON.parse(fs.readFileSync(path.join(hofDir, f), 'utf-8')) as ModelJson); }
          catch { /* skip malformed */ }
        }
        if (pool.length > 0) {
          hofModelsByPower[p] = pool;
          console.log(`[hof] ${p}: ${pool.length} snapshots loaded (mix=${hofMix})`);
        }
      }
    }
  }
}

// Output dir + append-mode handle (multiple runs accumulate).
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const out = fs.openSync(outPath, 'a');

// ── Sample shape and target ──────────────────────────────────────────────────

interface Sample {
  x: number[];                     // feature vector
  p: number;                       // acting power index (0-3) — routes policy targets
  visits?: Record<string, number>; // sparse visit counts per canonical action slot
  meta: SampleMeta;
}

interface GameResult {
  samples: Sample[];
  policySamples: number;
  winners: Power[] | null;
  rounds: number;
  complete: boolean;
  stopReason: string;
  actionCount: number;
  target: number[];                // value-head target per power
  finalVp: Record<Power, number>;
  finalThreat: Record<Power, number>;
  ruinationCount: number;
}

interface SampleMeta {
  version: 1;
  seed: number;
  gamePly: number;
  round: number;
  actionKind: string;
  actingPower: Power;
  legalCount: number;
  fullSearch: boolean;
  policyRow: boolean;
  visitEntropy: number | null;
  top1Share: number | null;
  powerPoints: number;
  ruinedRegions: number;
  nearRuinRegions: number;
  vp: Record<Power, number>;
  threat: Record<Power, number>;
}

/**
 * Per-power value target: continuous progress = max(vp/55, threat/35), clipped
 * to 1.0. VP normalizer is 55 (not 50) so overshoot-in-ties produces a
 * non-saturated signal. Replaces the prior rank-decay scheme — winners reach
 * 1.0 naturally by hitting a threshold, losers' targets reflect actual
 * proximity to victory rather than a comparative ranking.
 */
function computeProgressTarget(state: GameState): number[] {
  const target = new Array<number>(POWERS.length).fill(0);
  for (let i = 0; i < POWERS.length; i++) {
    const ps = state.powers[POWERS[i]!];
    const vpProgress = ps.victoryPoints / 55;
    const threatProgress = ps.threatValue / 35;
    target[i] = Math.min(Math.max(vpProgress, threatProgress), 1.0);
  }
  return target;
}

const RANK_VALUES = [1.0, 0.66, 0.33, 0.0];

/**
 * Final-placement rank target. Winners (state.winners) outrank all non-winners;
 * non-winners are ordered by their progress score. Ties share the average of
 * their position rank values. Returns null if the game ended without winners,
 * in which case the caller should fall back to pure progress.
 */
function computeRankTarget(state: GameState): number[] | null {
  if (state.winners === null || state.winners.length === 0) return null;
  const winnerSet = new Set<Power>(state.winners);
  const scores = POWERS.map((p, i) => {
    const ps = state.powers[p];
    const progress = Math.max(ps.victoryPoints / 55, ps.threatValue / 35);
    return { i, score: (winnerSet.has(p) ? 1000 : 0) + progress };
  });
  scores.sort((a, b) => b.score - a.score);
  const target = new Array<number>(POWERS.length).fill(0);
  let pos = 0;
  while (pos < scores.length) {
    let end = pos + 1;
    while (end < scores.length && scores[end]!.score === scores[pos]!.score) end++;
    let sum = 0;
    for (let k = pos; k < end; k++) sum += RANK_VALUES[k]!;
    const avg = sum / (end - pos);
    for (let k = pos; k < end; k++) target[scores[k]!.i] = avg;
    pos = end;
  }
  return target;
}

function computeBlendedTarget(state: GameState, rankWeight: number): number[] {
  const progress = computeProgressTarget(state);
  if (rankWeight <= 0) return progress;
  const rank = computeRankTarget(state);
  if (rank === null) return progress;
  const out = new Array<number>(progress.length);
  for (let i = 0; i < progress.length; i++) {
    out[i] = rankWeight * rank[i]! + (1 - rankWeight) * progress[i]!;
  }
  return out;
}

/**
 * Sample an action proportional to MCTS visit counts (τ=1). Falls back to
 * the highest-visit action if visit totals are 0. Caller passes a per-game
 * deterministic RNG so re-running the same seed reproduces the trajectory.
 */
function sampleActionByVisits(
  visitCounts: ReadonlyArray<{ action: Action; visits: number }>,
  rand: () => number,
): Action {
  if (visitCounts.length === 0) {
    throw new Error('sampleActionByVisits: empty visit list');
  }
  let total = 0;
  for (const vc of visitCounts) total += vc.visits;
  if (total <= 0) return visitCounts[0]!.action;
  let r = rand() * total;
  for (const vc of visitCounts) {
    r -= vc.visits;
    if (r <= 0) return vc.action;
  }
  return visitCounts[visitCounts.length - 1]!.action;
}

function regionCorruptionTotal(state: GameState, regionId: keyof GameState['regions']): number {
  const c = state.regions[regionId].corruptionTokens;
  return c.xarm + c.gormen + c.tenzen + c.lasha;
}

function tacticalImportance(state: GameState, power: Power): number {
  let score = 0;

  // Opening placements and first card commitments shape the whole game tree.
  if (state.round <= 2) score += 0.2;

  // Low PP means this is likely one of the final meaningful choices before
  // passing; those are high-leverage in summoning.
  if (state.powers[power].powerPoints <= 2) score += 0.2;

  // Near-ruin regions create sharp tactical incentives around domination,
  // corruption placement, and card disruption.
  for (const regionId of Object.keys(state.regions) as Array<keyof GameState['regions']>) {
    const region = state.regions[regionId];
    if (region.ruinationCardIndex !== null) continue;
    if (regionCorruptionTotal(state, regionId) >= region.resistance - 2) {
      score += 0.35;
      break;
    }
  }

  // Close-to-winning positions deserve more exact policy labels.
  const ps = state.powers[power];
  if (ps.victoryPoints >= 40 || ps.threatValue >= 28) score += 0.25;

  return Math.min(score, 1);
}

function shouldRunFullSearch(state: GameState, power: Power, rand: () => number): boolean {
  const p = Math.min(1, Math.max(0, fullSearchProb)
    + Math.max(0, fullSearchImportantBonus) * tacticalImportance(state, power));
  return rand() < p;
}

function ruinedRegionCount(state: GameState): number {
  let n = 0;
  for (const region of Object.values(state.regions)) {
    if (region.ruinationCardIndex !== null) n++;
  }
  return n;
}

function nearRuinRegionCount(state: GameState): number {
  let n = 0;
  for (const regionId of Object.keys(state.regions) as Array<keyof GameState['regions']>) {
    const region = state.regions[regionId];
    if (region.ruinationCardIndex !== null) continue;
    const corruption = regionCorruptionTotal(state, regionId);
    if (corruption > 0 && corruption >= region.resistance - 2) n++;
  }
  return n;
}

function powerNumbers(state: GameState, field: 'victoryPoints' | 'threatValue'): Record<Power, number> {
  return Object.fromEntries(ALL_POWERS.map(p => [p, state.powers[p][field]])) as Record<Power, number>;
}

function visitStats(visits: Record<string, number> | undefined): { entropy: number | null; top1Share: number | null } {
  if (!visits) return { entropy: null, top1Share: null };
  const counts = Object.values(visits).filter(v => v > 0);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return { entropy: null, top1Share: null };
  let entropy = 0;
  let top = 0;
  for (const c of counts) {
    const p = c / total;
    entropy -= p * Math.log2(p);
    if (c > top) top = c;
  }
  return { entropy, top1Share: top / total };
}

// ── Subaction kinds that go through MCTS (anything strategic, not stylistic) ─

const MCTS_SUBACTION_KINDS = new Set<string>([
  'battle_hit_assignment',
  'tenzen_discard',
  'dial_place_token',
  'dial_remove_corruption',
  'dial_remove_world_token',
  'upgrade_choice',
  'world_choice',
  'hero_removal',
  'corruption_harvest_choice',
  'card_on_play_choice',
]);

// ── One game ─────────────────────────────────────────────────────────────────

function logCollectError(seed: number, kind: string, state: GameState, pending: NonNullable<GameState['pendingAction']>, err: unknown, extra: Record<string, unknown> = {}): void {
  const e = err instanceof Error
    ? { message: err.message, stack: err.stack ?? null }
    : { message: String(err), stack: null };
  try {
    fs.appendFileSync(
      '/tmp/collect-errors.log',
      `\n=== ${new Date().toISOString()} seed=${seed} kind=${kind} ===\n`
      + `round=${state.round} phase=${state.phase} `
      + `actionKind=${pending.actionKind} power=${pending.waitingFor}\n`
      + (Object.keys(extra).length > 0 ? `${JSON.stringify(extra)}\n` : '')
      + `message: ${e.message}\n`
      + (e.stack ? `stack:\n${e.stack}\n` : ''),
    );
  } catch { /* best-effort logging */ }
}

function runGame(seed: number): GameResult {
  const samples: Sample[] = [];
  let policySamples = 0;
  // Deterministic per-game RNG, shared by HOF lineup selection and τ=1
  // visit-proportional move sampling so a re-run of the same seed reproduces
  // the same trajectory. Linear-congruential — quality is fine for biased
  // sampling.
  let rngState = (seed * 2654435761) >>> 0;
  const rand = (): number => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0xffffffff;
  };

  // τ=1 affects ONE power per game (the "explorer"). Other 3 powers play
  // max-visit (τ=0). Idea: when only one player explores, their bad picks
  // produce clean loss signal — vs everyone exploring, where noise blurs
  // who caused the outcome. Cycles which power is explorer across seeds.
  const explorerPower: Power = ALL_POWERS[Math.floor(rand() * ALL_POWERS.length)]!;

  // HOF lineup: per power, with probability hofMix replace the live model
  // with a random HOF snapshot for that power. Live model is the default.
  // Models persist between games, so we always re-load every power's choice
  // at the start of each game (no carry-over from the previous game's HOF
  // selection).
  if (hofMix > 0) {
    const swaps: string[] = [];
    for (const p of ALL_POWERS) {
      const pool = hofModelsByPower[p];
      const useHof = pool && pool.length > 0 && rand() < hofMix;
      if (useHof) {
        const pick = pool![Math.floor(rand() * pool!.length)]!;
        loadModelForPower(p, pick);
        swaps.push(p);
      } else if (livePerPowerModels[p]) {
        loadModelForPower(p, livePerPowerModels[p]!);
      }
    }
    if (swaps.length > 0 && seed % 8 === 0) {
      // Logging every game would flood; sample to keep the tail readable.
      console.log(`  · seed ${seed} HOF lineup: ${swaps.join(',')}`);
    }
  }

  let { state } = autoAdvance({
    state: createInitialState({
      gameId: `collect-${seed}`,
      activePowers: ALL_POWERS,
      playerTypes: Object.fromEntries(ALL_POWERS.map(p => [p, 'ai'])) as Record<Power, 'ai'>,
      seed,
    }),
    log: new GameLog(),
  });

  let actionCount = 0;
  let stopReason = 'complete';
  while (state.winners === null && state.phase !== 'completed') {
    if (actionCount >= maxActions) { stopReason = 'maxActions'; break; }
    const pending = state.pendingAction;
    if (!pending) { stopReason = 'noPendingAction'; break; }

    let action: Action;
    let visitsForSample: Record<string, number> | undefined;
    let legalCountForSample = 0;
    let fullSearchForSample = false;
    try {
      if (pending.actionKind === 'summoning_action') {
        legalCountForSample = getLegalActions(state, pending.waitingFor).length;
        const fullSearch = shouldRunFullSearch(state, pending.waitingFor, rand);
        fullSearchForSample = fullSearch;
        if (fullSearch) {
          const stats = runMctsWithStats(state, pending.waitingFor, {
            iterations: mctsIterations,
            timeMs: mctsTimeMs,
            ...(rolloutDepth !== undefined ? { rolloutDepth } : {}),
            ...(dirichletNoise ? { dirichletNoise } : {}),
            ...(xarmSuppression > 0 ? { xarmSuppression } : {}),
          });
          // τ=1 visit-proportional sampling for opening rounds, but ONLY for
          // the per-game explorer (one randomly-chosen power). Other powers
          // play max-visit so the explorer's exploration produces a clean
          // win/loss signal rather than noise blurred across all 4 powers.
          // Use raw search counts here; stats.visitCounts is the denoised
          // policy target with forced root playouts pruned.
          action = (tempRounds > 0 && state.round <= tempRounds && pending.waitingFor === explorerPower)
            ? sampleActionByVisits(stats.searchVisitCounts, rand)
            : stats.action;
          // Multiple legal actions can canonicalise to the same slot — sum visits.
          const slotVisits: Record<string, number> = {};
          for (const { action: a, visits } of stats.visitCounts) {
            const idx = canonicalActionIndex(a, state);
            if (idx >= 0 && idx < ACTION_DIM) {
              slotVisits[String(idx)] = (slotVisits[String(idx)] ?? 0) + visits;
            }
          }
          visitsForSample = slotVisits;
          policySamples++;
        } else {
          action = runMcts(state, pending.waitingFor, {
            iterations: fastMctsIterations,
            timeMs: fastMctsTimeMs,
            ...(rolloutDepth !== undefined ? { rolloutDepth } : {}),
            ...(xarmSuppression > 0 ? { xarmSuppression } : {}),
          });
        }
      } else if (MCTS_SUBACTION_KINDS.has(pending.actionKind)) {
        action = runMcts(state, pending.waitingFor, {
          iterations: fastMctsIterations,
          timeMs: fastMctsTimeMs,
          ...(rolloutDepth !== undefined ? { rolloutDepth } : {}),
          ...(xarmSuppression > 0 ? { xarmSuppression } : {}),
        });
      } else {
        action = greedyAction(state, pending.waitingFor);
      }
    } catch (err) {
      logCollectError(seed, 'action_select', state, pending, err);
      stopReason = 'actionSelectError';
      break;
    }

    if (pending.actionKind === 'summoning_action') {
      const stats = visitStats(visitsForSample);
      const sample: Sample = {
        x: Array.from(extractFeatures(state, pending.waitingFor)),
        p: powerIndex(pending.waitingFor),
        meta: {
          version: 1,
          seed,
          gamePly: actionCount,
          round: state.round,
          actionKind: pending.actionKind,
          actingPower: pending.waitingFor,
          legalCount: legalCountForSample,
          fullSearch: fullSearchForSample,
          policyRow: visitsForSample !== undefined && Object.keys(visitsForSample).length > 0,
          visitEntropy: stats.entropy,
          top1Share: stats.top1Share,
          powerPoints: state.powers[pending.waitingFor].powerPoints,
          ruinedRegions: ruinedRegionCount(state),
          nearRuinRegions: nearRuinRegionCount(state),
          vp: powerNumbers(state, 'victoryPoints'),
          threat: powerNumbers(state, 'threatValue'),
        },
      };
      if (visitsForSample) sample.visits = visitsForSample;
      samples.push(sample);
    }

    try {
      const result = applyAction(state, action);
      state = result.state;
    } catch (err) {
      logCollectError(seed, 'apply', state, pending, err, { action });
      stopReason = 'applyError';
      break;
    }
    actionCount++;
  }

  const complete = state.winners !== null || state.phase === 'completed';
  return {
    samples,
    policySamples,
    winners: state.winners,
    rounds: state.round,
    complete,
    stopReason: complete ? 'complete' : stopReason,
    actionCount,
    target: computeBlendedTarget(state, rankBlendWeight),
    finalVp: powerNumbers(state, 'victoryPoints'),
    finalThreat: powerNumbers(state, 'threatValue'),
    ruinationCount: ruinedRegionCount(state),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log(`\n=== Self-play data collection ===`);
console.log(`Games: ${gameCount}  |  Base seed: ${baseSeed}  |  Out: ${outPath}\n`);
console.log(`Search: full ${mctsIterations} iters @ p=${fullSearchProb} (+${fullSearchImportantBonus} tactical), fast ${fastMctsIterations} iters`);
console.log(`Noise: ${dirichletNoise ? `Dirichlet alpha=${dirichletAlpha} weight=${dirichletWeight} on full searches only` : 'off'}\n`);

const startMs = Date.now();
let totalSamples = 0;
let totalPolicySamples = 0;
let completedGames = 0;
const winCounts: Record<string, number> = {};

for (let i = 0; i < gameCount; i++) {
  const seed = baseSeed + i;
  const t0 = Date.now();
  const { samples, policySamples, winners, rounds, target, complete, stopReason, actionCount, finalVp, finalThreat, ruinationCount } = runGame(seed);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  for (const s of samples) {
    const row: {
      x: number[];
      t: number[];
      p: number;
      visits?: Record<string, number>;
      meta: SampleMeta & {
        targetVersion: 'rank_progress_blend_v1';
        complete: boolean;
        stopReason: string;
        finalRounds: number;
        finalActionCount: number;
        winners: Power[] | null;
        finalVp: Record<Power, number>;
        finalThreat: Record<Power, number>;
        finalRuinationCount: number;
      };
    } = {
      x: s.x,
      t: target,
      p: s.p,
      meta: {
        ...s.meta,
        targetVersion: 'rank_progress_blend_v1',
        complete,
        stopReason,
        finalRounds: rounds,
        finalActionCount: actionCount,
        winners,
        finalVp,
        finalThreat,
        finalRuinationCount: ruinationCount,
      },
    };
    if (s.visits && Object.keys(s.visits).length > 0) row.visits = s.visits;
    fs.writeSync(out, JSON.stringify(row) + '\n');
  }

  totalSamples += samples.length;
  totalPolicySamples += policySamples;
  completedGames++;
  const winStr = winners && winners.length > 0 ? winners.join('+') : 'NO_WINNER';
  winCounts[winStr] = (winCounts[winStr] ?? 0) + 1;
  console.log(`  Game ${i + 1}/${gameCount} (seed ${seed}): ${winStr.padEnd(14)} (${rounds}r, ${samples.length} value, ${policySamples} policy, ${stopReason}, ${elapsed}s)`);
}

fs.closeSync(out);

const totalSec = ((Date.now() - startMs) / 1000).toFixed(1);
console.log(`\n────────────────────────────────────────`);
console.log(`Completed: ${completedGames}/${gameCount} games`);
console.log(`Samples written: ${totalSamples} value rows, ${totalPolicySamples} policy rows`);
console.log(`Total time: ${totalSec}s`);
console.log(`\nWinner distribution:`);
for (const [w, c] of Object.entries(winCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${w.padEnd(20)} ${c}`);
}
console.log();
