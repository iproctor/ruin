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
}

interface GameResult {
  samples: Sample[];
  winners: Power[] | null;
  rounds: number;
  target: number[];                // value-head target per power
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
  while (state.winners === null && state.phase !== 'completed') {
    if (actionCount >= maxActions) break;
    const pending = state.pendingAction;
    if (!pending) break;

    let action: Action;
    let visitsForSample: Record<string, number> | undefined;
    try {
      if (pending.actionKind === 'summoning_action') {
        const stats = runMctsWithStats(state, pending.waitingFor, {
          iterations: mctsIterations,
          timeMs: mctsTimeMs,
          ...(rolloutDepth !== undefined ? { rolloutDepth } : {}),
          ...(dirichletNoise ? { dirichletNoise } : {}),
        });
        // τ=1 visit-proportional sampling for opening rounds, but ONLY for
        // the per-game explorer (one randomly-chosen power). Other powers
        // play max-visit so the explorer's exploration produces a clean
        // win/loss signal rather than noise blurred across all 4 powers.
        action = (tempRounds > 0 && state.round <= tempRounds && pending.waitingFor === explorerPower)
          ? sampleActionByVisits(stats.visitCounts, rand)
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
      } else if (MCTS_SUBACTION_KINDS.has(pending.actionKind)) {
        action = runMcts(state, pending.waitingFor, {
          iterations: mctsIterations,
          timeMs: mctsTimeMs,
          ...(rolloutDepth !== undefined ? { rolloutDepth } : {}),
          ...(dirichletNoise ? { dirichletNoise } : {}),
        });
      } else {
        action = greedyAction(state, pending.waitingFor);
      }
    } catch (err) {
      logCollectError(seed, 'action_select', state, pending, err);
      break;
    }

    if (pending.actionKind === 'summoning_action') {
      const sample: Sample = {
        x: Array.from(extractFeatures(state, pending.waitingFor)),
        p: powerIndex(pending.waitingFor),
      };
      if (visitsForSample) sample.visits = visitsForSample;
      samples.push(sample);
    }

    try {
      const result = applyAction(state, action);
      state = result.state;
    } catch (err) {
      logCollectError(seed, 'apply', state, pending, err, { action });
      break;
    }
    actionCount++;
  }

  return {
    samples,
    winners: state.winners,
    rounds: state.round,
    target: computeProgressTarget(state),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log(`\n=== Self-play data collection ===`);
console.log(`Games: ${gameCount}  |  Base seed: ${baseSeed}  |  Out: ${outPath}\n`);

const startMs = Date.now();
let totalSamples = 0;
let completedGames = 0;
const winCounts: Record<string, number> = {};

for (let i = 0; i < gameCount; i++) {
  const seed = baseSeed + i;
  const t0 = Date.now();
  const { samples, winners, rounds, target } = runGame(seed);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  for (const s of samples) {
    const row: { x: number[]; t: number[]; p: number; visits?: Record<string, number> } = {
      x: s.x,
      t: target,
      p: s.p,
    };
    if (s.visits && Object.keys(s.visits).length > 0) row.visits = s.visits;
    fs.writeSync(out, JSON.stringify(row) + '\n');
  }

  totalSamples += samples.length;
  completedGames++;
  const winStr = winners && winners.length > 0 ? winners.join('+') : 'NO_WINNER';
  winCounts[winStr] = (winCounts[winStr] ?? 0) + 1;
  console.log(`  Game ${i + 1}/${gameCount} (seed ${seed}): ${winStr.padEnd(14)} (${rounds}r, ${samples.length} samples, ${elapsed}s)`);
}

fs.closeSync(out);

const totalSec = ((Date.now() - startMs) / 1000).toFixed(1);
console.log(`\n────────────────────────────────────────`);
console.log(`Completed: ${completedGames}/${gameCount} games`);
console.log(`Samples written: ${totalSamples}`);
console.log(`Total time: ${totalSec}s`);
console.log(`\nWinner distribution:`);
for (const [w, c] of Object.entries(winCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${w.padEnd(20)} ${c}`);
}
console.log();
