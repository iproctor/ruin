/**
 * Self-play data collection. Plays N headless AI-vs-AI games, recording
 * (feature_vector, winner_power) at every summoning decision point. Writes
 * JSONL to packages/ai/data/training.jsonl.
 *
 * Usage (from repo root):
 *   pnpm collect [--games 100] [--seed 1] [--out path]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createInitialState, applyAction, autoAdvance, getLegalActions, GameLog, type GameState, type Action, type Power,
} from '@ruin/engine';
import {
  runMcts, runMctsWithStats, greedyAction, extractFeatures, POWERS, powerIndex,
  canonicalActionIndex, ACTION_DIM,
  loadModelForPower, clearPerPowerModels, type ModelJson,
} from '@ruin/ai';
import { loadLearnedModelIfPresent } from './load-model.js';

// Bootstrap: use the learned model if one exists (iterative self-play).
// First run falls back to the hand-tuned evaluator.
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
const mctsIterations = parseInt(getArg('--iter', '400'), 10);
const mctsTimeMs = parseInt(getArg('--time', '300'), 10);
// epsilon-greedy exploration during data collection: with this probability,
// pick a random legal summoning action instead of MCTS's best. Mostly superseded
// by Dirichlet noise on root priors (cleaner exploration that doesn't sabotage
// games) — default 0. Kept available via --epsilon for back-compat.
const epsilon = parseFloat(getArg('--epsilon', '0'));
// League training: with --league-size K, the K most recent snapshot models
// are loaded into a pool. Per game, one power is the "learner" (rotated by
// seed) and uses the current model; each other power, with probability
// --league-mix, is assigned a random snapshot as its opponent policy.
// Value-head samples are recorded for all powers (outcome is valid from any
// viewpoint). Policy-head visits are only recorded for the learner —
// snapshot-driven visits would regress the current policy toward snapshots.
// Default 0 = disabled (pure self-play).
const leagueSize = parseInt(getArg('--league-size', '0'), 10);
const leagueMix = parseFloat(getArg('--league-mix', '0.5'));
// Focus power: if set, that power ALWAYS uses its dedicated model (loaded at
// startup via loadModelForPower from model_<power>.json), other powers draw
// from the league pool. Only the focus power's visits are recorded. Used for
// single-power training experiments.
const focusPower = getArg('--focus-power', '');
const outPath = getArg('--out', path.resolve('packages/ai/data/training.jsonl'));

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

// ── Snapshot pool (league training) ───────────────────────────────────────────

const snapshotPool: ModelJson[] = [];
if (leagueSize > 0) {
  const snapDir = path.resolve('packages/ai/data');
  if (fs.existsSync(snapDir)) {
    const files = fs.readdirSync(snapDir)
      .filter(f => /^model_iter_\d+\.json$/.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)![0], 10);
        const nb = parseInt(b.match(/\d+/)![0], 10);
        return na - nb;
      })
      .slice(-leagueSize);
    for (const f of files) {
      snapshotPool.push(JSON.parse(fs.readFileSync(path.join(snapDir, f), 'utf-8')) as ModelJson);
    }
    console.log(`[league] pool size=${snapshotPool.length}: ${files.join(', ')}`);
  }
  if (snapshotPool.length === 0) {
    console.log(`[league] no snapshots found — league mode inactive`);
  }
}
const leagueActive = snapshotPool.length > 0;

// ── Focus power model (if --focus-power set) ──────────────────────────────────

let focusPowerModel: ModelJson | null = null;
if (focusPower) {
  const focusPath = path.resolve(`packages/ai/data/model_${focusPower}.json`);
  if (fs.existsSync(focusPath)) {
    focusPowerModel = JSON.parse(fs.readFileSync(focusPath, 'utf-8')) as ModelJson;
    console.log(`[focus] loaded model for ${focusPower} from ${focusPath}`);
  } else {
    console.log(`[focus] no ${focusPath} — ${focusPower} will use the shared model`);
  }
}

// ── Ensure output directory exists ────────────────────────────────────────────

fs.mkdirSync(path.dirname(outPath), { recursive: true });
// Open in append mode so multiple runs accumulate.
const out = fs.openSync(outPath, 'a');

// ── Run one game, record samples ──────────────────────────────────────────────

interface Sample {
  x: number[];       // feature vector
  // Power index (0-3) of the acting power. Used to route policy targets
  // to the correct per-power policy head during training.
  p?: number;
  // Optional policy training signal: visit counts on root children at this
  // decision point, mapped to canonical action slots. Sparse map for efficiency.
  visits?: Record<string, number>;
}

interface GameResult {
  samples: Sample[];
  winners: Power[] | null;
  rounds: number;
  // Soft target: each power's share of "winning quality" at game end.
  // Mix of: 1.0 for actual winners, partial credit for VP share otherwise.
  // Always sums to 1.0.
  target: number[];
}

function computeSoftTarget(_finalState: import('@ruin/engine').GameState, winners: Power[]): number[] {
  // Hard one-hot target on the winner(s). The trainer applies inverse-frequency
  // reweighting to balance rare-winner samples; combining a soft progress target
  // with weighting double-counted and leaked xarm-favor into every sample.
  const target = new Array(POWERS.length).fill(0);
  if (winners.length === 0) {
    // No winner (shouldn't happen in training data — filtered upstream)
    return target.fill(1 / POWERS.length);
  }
  const per = 1 / winners.length;
  for (const w of winners) target[POWERS.indexOf(w)] += per;
  return target;
}

function runGame(seed: number): GameResult {
  const samples: Sample[] = [];
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
  // Deterministic per-game RNG for exploration noise
  let rngState = (seed * 2654435761) >>> 0;
  const rand = (): number => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0xffffffff;
  };

  // Per-game Tenzen cutoff sampled from a schedule controlled by
  // TENZEN_CUTOFF_SHIFT ∈ [0, 1]:
  //
  //   - At shift=0, draw cutoff from {1,2,3,4} with weights (4,3,2,1)/10.
  //     Handmade eval steers the setup phase; cutoff=0 never sampled.
  //   - At shift=1, always cutoff=0. Learned head runs the whole game.
  //   - At intermediate shift, linearly mix: P(0) = shift, and the rest
  //     of the mass (1 − shift) follows the base (4,3,2,1) shape.
  //
  // Operationally: bump the shift toward 1 over many iters. Training data
  // becomes a mixture of "handmade-assisted" and "learned-only" Tenzen
  // games, so the learned policy is never trained against just one slice.
  const savedTenzenCutoff = process.env['TENZEN_EVAL_CUTOFF'];
  const shift = Math.min(1, Math.max(0,
    parseFloat(process.env['TENZEN_CUTOFF_SHIFT'] ?? '0')));
  let sampledCutoff: number;
  if (rand() < shift) {
    sampledCutoff = 0;
  } else {
    const r = rand() * 10;
    sampledCutoff = r < 4 ? 1 : r < 7 ? 2 : r < 9 ? 3 : 4;
  }
  process.env['TENZEN_EVAL_CUTOFF'] = String(sampledCutoff);

  // League assignment. Two modes:
  //  - focus mode: only the focus power uses its dedicated model (current
  //    training target). All others draw from the snapshot pool. Only the
  //    focus power's visits are recorded as policy training data.
  //  - normal mode: 2 powers on current, 2 may draw from pool.
  const currentModelPowers = new Set<Power>();
  if (focusPower) {
    // Focus mode: only focus power's visits are recorded.
    clearPerPowerModels();
    if (focusPowerModel) loadModelForPower(focusPower as Power, focusPowerModel);
    currentModelPowers.add(focusPower as Power);
    for (const p of ALL_POWERS) {
      if (p === focusPower) continue;
      if (leagueActive) {
        const snap = snapshotPool[Math.floor(rand() * snapshotPool.length)]!;
        loadModelForPower(p, snap);
      }
    }
  } else if (leagueActive) {
    clearPerPowerModels();
    const offset = seed % ALL_POWERS.length;
    currentModelPowers.add(ALL_POWERS[offset]!);
    currentModelPowers.add(ALL_POWERS[(offset + 1) % ALL_POWERS.length]!);
    for (const p of ALL_POWERS) {
      if (currentModelPowers.has(p)) continue;
      if (rand() < leagueMix) {
        const snap = snapshotPool[Math.floor(rand() * snapshotPool.length)]!;
        loadModelForPower(p, snap);
      } else {
        currentModelPowers.add(p);
      }
    }
  } else {
    for (const p of ALL_POWERS) currentModelPowers.add(p);
  }

  while (state.winners === null && state.phase !== 'completed') {
    if (actionCount >= maxActions) break;
    const pending = state.pendingAction;
    if (!pending) break;

    let action: Action;
    let visitsForSample: Record<string, number> | undefined;
    try {
      // Epsilon-greedy: occasionally pick a random legal action instead of MCTS best.
      // Only applies to summoning actions (the strategically interesting ones).
      const explore =
        pending.actionKind === 'summoning_action' && epsilon > 0 && rand() < epsilon;
      if (explore) {
        const legal = getLegalActions(state, pending.waitingFor);
        const candidates = legal.filter(a => a.kind !== 'summoning_pass');
        const pool = candidates.length > 0 ? candidates : legal;
        action = pool[Math.floor(rand() * pool.length)]!;
      } else if (pending.actionKind === 'summoning_action') {
        // Use the stats variant so we can record the visit distribution for
        // policy head training.
        const stats = runMctsWithStats(state, pending.waitingFor, {
          iterations: mctsIterations,
          timeMs: mctsTimeMs,
          dirichletNoise: { alpha: 0.3, weight: 0.25 },
        });
        action = stats.action;
        // Collapse to canonical slot indices and accumulate visits per slot
        // (multiple legal actions may map to the same slot — sum their visits).
        const slotVisits: Record<string, number> = {};
        for (const { action: a, visits } of stats.visitCounts) {
          const idx = canonicalActionIndex(a, state);
          if (idx >= 0 && idx < ACTION_DIM) {
            slotVisits[String(idx)] = (slotVisits[String(idx)] ?? 0) + visits;
          }
        }
        visitsForSample = slotVisits;
      } else {
        const useMcts =
          pending.actionKind === 'battle_hit_assignment' ||
          pending.actionKind === 'tenzen_discard' ||
          pending.actionKind === 'dial_place_token' ||
          pending.actionKind === 'dial_remove_corruption' ||
          pending.actionKind === 'dial_remove_world_token' ||
          pending.actionKind === 'upgrade_choice' ||
          pending.actionKind === 'world_choice' ||
          pending.actionKind === 'hero_removal' ||
          pending.actionKind === 'corruption_harvest_choice' ||
          pending.actionKind === 'card_on_play_choice';
        action = useMcts
          ? runMcts(state, pending.waitingFor, {
              iterations: mctsIterations,
              timeMs: mctsTimeMs,
              dirichletNoise: { alpha: 0.3, weight: 0.25 },
            })
          : greedyAction(state, pending.waitingFor);
      }
    } catch (err) {
      const e = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err), stack: null };
      try {
        fs.appendFileSync(
          '/tmp/collect-errors.log',
          `\n=== ${new Date().toISOString()} seed=${seed} ===\n` +
          `kind=action_select round=${state.round} phase=${state.phase} ` +
          `actionKind=${pending.actionKind} power=${pending.waitingFor}\n` +
          `message: ${e.message}\n` +
          (e.stack ? `stack:\n${e.stack}\n` : ''),
        );
      } catch {}
      break;
    }

    // Sample at every summoning decision point. Feature vector trains the
    // value head (any viewpoint is valid). Policy visits are only kept for
    // powers on the current model — snapshot-driven visits would regress
    // the current policy.
    if (pending.actionKind === 'summoning_action') {
      const sample: Sample = {
        x: Array.from(extractFeatures(state, pending.waitingFor)),
        p: powerIndex(pending.waitingFor),
      };
      if (visitsForSample && currentModelPowers.has(pending.waitingFor)) {
        sample.visits = visitsForSample;
      }
      samples.push(sample);
    }

    try {
      const result = applyAction(state, action);
      state = result.state;
    } catch (err) {
      const e = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err), stack: null };
      try {
        fs.appendFileSync(
          '/tmp/collect-errors.log',
          `\n=== ${new Date().toISOString()} seed=${seed} ===\n` +
          `kind=apply round=${state.round} phase=${state.phase} ` +
          `actionKind=${pending.actionKind} power=${pending.waitingFor}\n` +
          `action=${JSON.stringify(action)}\n` +
          `message: ${e.message}\n` +
          (e.stack ? `stack:\n${e.stack}\n` : ''),
        );
      } catch {}
      break;
    }
    actionCount++;
  }

  if (leagueActive) clearPerPowerModels();
  // Restore Tenzen cutoff after per-game randomization
  if (savedTenzenCutoff !== undefined) process.env['TENZEN_EVAL_CUTOFF'] = savedTenzenCutoff;
  else delete process.env['TENZEN_EVAL_CUTOFF'];

  const winners = state.winners;
  const target = winners && winners.length > 0
    ? computeSoftTarget(state, winners)
    : new Array(POWERS.length).fill(1 / POWERS.length);
  return { samples, winners, rounds: state.round, target };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n=== Self-play data collection ===`);
console.log(`Games: ${gameCount}  |  Base seed: ${baseSeed}  |  Out: ${outPath}\n`);

const start = Date.now();
let totalSamples = 0;
let completedGames = 0;
const winCounts: Record<string, number> = {};

for (let i = 0; i < gameCount; i++) {
  const seed = baseSeed + i;
  const t0 = Date.now();
  const { samples, winners, rounds, target } = runGame(seed);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!winners || winners.length === 0) {
    console.log(`  Game ${i + 1}/${gameCount} (seed ${seed}): NO WINNER — skipping samples`);
    continue;
  }

  // No collect-time balance filter — trainer already applies inverse-frequency
  // reweighting on the full dataset (train_mlp.py).

  // Each sample gets the same soft target vector for the value head, plus
  // its own visit distribution (when present) for the policy head.
  for (const s of samples) {
    const row: { x: number[]; t: number[]; p?: number; visits?: Record<string, number> } = {
      x: s.x,
      t: target,
    };
    if (s.p !== undefined) row.p = s.p;
    if (s.visits && Object.keys(s.visits).length > 0) row.visits = s.visits;
    fs.writeSync(out, JSON.stringify(row) + '\n');
  }

  totalSamples += samples.length;
  completedGames++;
  const winStr = winners.join('+');
  winCounts[winStr] = (winCounts[winStr] ?? 0) + 1;
  console.log(`  Game ${i + 1}/${gameCount} (seed ${seed}): ${winStr.padEnd(14)} (${rounds}r, ${samples.length} samples, ${elapsed}s)`);
}

fs.closeSync(out);

const total = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\n────────────────────────────────────────`);
console.log(`Completed: ${completedGames}/${gameCount} games`);
console.log(`Samples written: ${totalSamples}`);
console.log(`Total time: ${total}s`);
console.log(`\nWinner distribution:`);
for (const [w, c] of Object.entries(winCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${w.padEnd(20)} ${c}`);
}
console.log();
