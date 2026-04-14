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
  runMcts, runMctsWithStats, greedyAction, extractFeatures, POWERS,
  canonicalActionIndex, ACTION_DIM,
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
// pick a random legal summoning action instead of MCTS's best. Breaks the AI
// out of dominant strategies and produces more diverse training data.
const epsilon = parseFloat(getArg('--epsilon', '0.1'));
const outPath = getArg('--out', path.resolve('packages/ai/data/training.jsonl'));

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

// ── Ensure output directory exists ────────────────────────────────────────────

fs.mkdirSync(path.dirname(outPath), { recursive: true });
// Open in append mode so multiple runs accumulate.
const out = fs.openSync(outPath, 'a');

// ── Run one game, record samples ──────────────────────────────────────────────

interface Sample {
  x: number[];       // feature vector
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

// Dial lengths per power — kept locally so this script doesn't import the
// engine's full constants. Mirror of features.ts DIAL_MAX.
const DIAL_MAX: Record<Power, number> = {
  xarm: 9, gormen: 10, tenzen: 8, lasha: 7,
};
const VP_THRESHOLD = 60;

function progressToVictory(finalState: import('@ruin/engine').GameState, power: Power): number {
  const ps = finalState.powers[power];
  if (!ps) return 0;
  // Use per-round gain (efficiency) rather than absolute progress. A power
  // that gets 40 VP in 5 rounds is playing better than one at 40 VP in 8
  // rounds. Absolute targets encourage slow grinds; per-round targets reward
  // efficiency and shorter games.
  const rounds = Math.max(1, finalState.round);
  const vpPerRound = ps.victoryPoints / rounds;
  const dialPerRound = ps.dialPosition / rounds;
  // Normalize: winning requires ~60 VP or DIAL_MAX. In a 5-round game that's
  // 12 VP/round or DIAL_MAX/5 per round as the "winning pace".
  const vpFrac = Math.min(vpPerRound / (VP_THRESHOLD / 5), 1);
  const dialFrac = Math.min(dialPerRound / (DIAL_MAX[power] / 5), 1);
  return Math.max(vpFrac, dialFrac);
}

function computeSoftTarget(finalState: import('@ruin/engine').GameState, winners: Power[]): number[] {
  // 80% mass on actual winners (split if tie), 20% distributed by progress
  // toward any victory condition (VP threshold OR dial position). Crediting
  // dial progress matters because some powers (xarm) win primarily by dial,
  // and crediting only VP share underweights "I was about to win by dial."
  const winnerMass = 0.4;
  const progressMass = 0.6;
  const target = new Array(POWERS.length).fill(0);

  if (winners.length > 0) {
    const per = winnerMass / winners.length;
    for (const w of winners) target[POWERS.indexOf(w)] += per;
  }

  const progress = POWERS.map(p => progressToVictory(finalState, p));
  const total = progress.reduce((a, b) => a + b, 0);
  if (total > 0) {
    for (let i = 0; i < POWERS.length; i++) {
      target[i] += progressMass * (progress[i]! / total);
    }
  } else {
    for (let i = 0; i < POWERS.length; i++) target[i] += progressMass / POWERS.length;
  }
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
          ? runMcts(state, pending.waitingFor, { iterations: mctsIterations, timeMs: mctsTimeMs })
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

    // Sample at every summoning decision point. We record the feature vector
    // AND (when MCTS ran) the visit distribution as the policy training signal.
    if (pending.actionKind === 'summoning_action') {
      const sample: Sample = {
        x: Array.from(extractFeatures(state, pending.waitingFor)),
      };
      if (visitsForSample) sample.visits = visitsForSample;
      samples.push(sample);
    }

    try {
      const result = applyAction(state, action);
      const prevRound = state.round;
      state = result.state;
      // Sample at the FIRST state of each new round (post-end-phase snapshot).
      // Use the upcoming acting power's viewpoint (what they'd see when MCTS
      // queries from their perspective on the next decision).
      if (state.round !== prevRound && state.winners === null && state.phase !== 'completed') {
        const viewpoint = state.pendingAction?.waitingFor ?? ALL_POWERS[0]!;
        samples.push({ x: Array.from(extractFeatures(state, viewpoint)) });
      }
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

  // Sample down Xarm-win games to balance training data. Xarm wins ~80% of
  // self-play games which biases the value head heavily. Target ~50/50 Xarm/other
  // by keeping each Xarm-win game with probability 0.25. Deterministic per-seed.
  if (winners.length === 1 && winners[0] === 'xarm') {
    const h = ((seed * 2654435761) >>> 0) / 0xffffffff;
    if (h >= 0.25) {
      console.log(`  Game ${i + 1}/${gameCount} (seed ${seed}): xarm win, dropped (balance filter)`);
      continue;
    }
  }

  // Each sample gets the same soft target vector for the value head, plus
  // its own visit distribution (when present) for the policy head.
  for (const s of samples) {
    const row: { x: number[]; t: number[]; visits?: Record<string, number> } = {
      x: s.x,
      t: target,
    };
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
