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
 * Per-power value target. Most powers get rank-decay (1.0 → 0.0 by projected
 * rounds-to-win); tenzen is overridden with VP/50 because rank collapsed to
 * 0 every game during the plateau and provided no gradient.
 */
function computeRankTarget(state: GameState, winners: Power[] | null): number[] {
  const target = new Array<number>(POWERS.length).fill(0);
  const N = POWERS.length;
  const winnerSet = new Set(winners ?? []);
  const rounds = Math.max(state.round, 1);
  const VP_TARGET = 50;
  const THREAT_TARGET = 35;
  const roundsToWin = (p: Power): number => {
    const ps = state.powers[p];
    const vpRate = ps.victoryPoints / rounds;
    const threatRate = ps.threatValue / rounds;
    const vpProj = vpRate > 0 ? (VP_TARGET - ps.victoryPoints) / vpRate : Infinity;
    const threatProj = threatRate > 0 ? (THREAT_TARGET - ps.threatValue) / threatRate : Infinity;
    return Math.min(vpProj, threatProj);
  };
  const ranked = [...POWERS].sort((a, b) => {
    const aWin = winnerSet.has(a), bWin = winnerSet.has(b);
    if (aWin !== bWin) return aWin ? -1 : 1;
    return roundsToWin(a) - roundsToWin(b);
  });
  for (let i = 0; i < ranked.length; i++) {
    target[POWERS.indexOf(ranked[i]!)] = (N - 1 - i) / (N - 1);
  }
  // Tenzen: continuous VP/50 instead of rank.
  const tenzenIdx = POWERS.indexOf('tenzen');
  target[tenzenIdx] = Math.min(state.powers['tenzen'].victoryPoints / VP_TARGET, 1.0);
  return target;
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
  // Deterministic per-game RNG for HOF lineup selection so a re-run of the
  // same seed reproduces the exact opponent assignment. Linear-congruential
  // — quality is fine for biased sampling.
  let rngState = (seed * 2654435761) >>> 0;
  const rand = (): number => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0xffffffff;
  };

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
        action = stats.action;
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
    target: computeRankTarget(state, state.winners),
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
