/**
 * Head-to-head benchmark. Runs N games of one "current" power model against
 * three reference (frozen) models for the other powers. Records winners and
 * basic VP/round stats. No training samples; this exists purely to measure
 * "does the new model_<power>.json beat the reference for this power."
 *
 * Usage:
 *   pnpm tsx packages/server/src/scripts/bench-h2h.ts \
 *     --current-power xarm \
 *     --ref-dir packages/ai/data/ref \
 *     --games 100 --seed 100000 --iter 1000 \
 *     --out /tmp/bench_h2h_xarm.json
 *
 * Lineup for --current-power xarm: model_xarm = packages/ai/data/model_xarm.json
 * (the live "candidate"); model_<other> = ref-dir/model_<other>_ref.json (the
 * frozen baseline). Same logic for any other --current-power.
 *
 * No Dirichlet, no temperature, no HOF — eval-time only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createInitialState, applyAction, autoAdvance, GameLog,
  type GameState, type Action, type Power,
} from '@ruin/engine';
import {
  runMcts, greedyAction, loadModelForPower, type ModelJson,
} from '@ruin/ai';

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
}

const baselineMode = process.argv.includes('--baseline');
const currentPower = getArg('--current-power', '') as Power;
const refDir = getArg('--ref-dir', path.resolve('packages/ai/data/ref'));
const dataDir = getArg('--data-dir', path.resolve('packages/ai/data'));
const gameCount = parseInt(getArg('--games', '100'), 10);
const baseSeed = parseInt(getArg('--seed', '100000'), 10);
const maxActions = parseInt(getArg('--max-actions', '2000'), 10);
const mctsIterations = parseInt(getArg('--iter', '1000'), 10);
const mctsTimeMs = parseInt(getArg('--time', '60000'), 10);
const outPath = getArg('--out', '');
// r0 by default — matches training regime. Override with --no-rollout-zero.
const allRolloutZero = !process.argv.includes('--no-rollout-zero');
const rolloutDepth: number | undefined = allRolloutZero ? -1 : undefined;

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

if (!baselineMode && !ALL_POWERS.includes(currentPower)) {
  console.error(`--current-power must be one of ${ALL_POWERS.join('|')}, or pass --baseline`);
  process.exit(1);
}

// Load lineup. Errors here are fatal — the whole point is to bench against
// a specific reference, so silently falling back would be wrong.
function loadModel(p: string): ModelJson {
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as ModelJson;
}

const lineup: Record<Power, string> = {
  xarm: '', gormen: '', tenzen: '', lasha: '',
};
for (const p of ALL_POWERS) {
  // baseline mode: every power loads from ref/. h2h mode: current_power
  // loads from data/, others from ref/.
  if (!baselineMode && p === currentPower) {
    lineup[p] = path.join(dataDir, `model_${p}.json`);
  } else {
    lineup[p] = path.join(refDir, `model_${p}_ref.json`);
  }
  if (!fs.existsSync(lineup[p])) {
    console.error(`missing model for ${p}: ${lineup[p]}`);
    process.exit(1);
  }
  loadModelForPower(p, loadModel(lineup[p]));
}
const tag = baselineMode ? '[baseline]' : '[h2h]';
console.log(`${tag} lineup: ${ALL_POWERS.map(p => `${p}=${path.basename(lineup[p])}`).join(' ')}`);

const MCTS_SUBACTION_KINDS = new Set<string>([
  'battle_hit_assignment', 'tenzen_discard', 'dial_place_token',
  'dial_remove_corruption', 'dial_remove_world_token', 'upgrade_choice',
  'world_choice', 'hero_removal', 'corruption_harvest_choice',
  'card_on_play_choice',
]);

interface GameOutcome {
  winners: Power[];
  rounds: number;
  vp: Record<Power, number>;
  dial: Record<Power, number>;
}

function runGame(seed: number): GameOutcome {
  let { state } = autoAdvance({
    state: createInitialState({
      gameId: `bench-h2h-${seed}`,
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
    try {
      if (pending.actionKind === 'summoning_action' || MCTS_SUBACTION_KINDS.has(pending.actionKind)) {
        action = runMcts(state, pending.waitingFor, {
          iterations: mctsIterations,
          timeMs: mctsTimeMs,
          ...(rolloutDepth !== undefined ? { rolloutDepth } : {}),
        });
      } else {
        action = greedyAction(state, pending.waitingFor);
      }
    } catch (err) {
      console.error(`MCTS threw at ${pending.actionKind}/${pending.waitingFor}:`, err);
      break;
    }

    try {
      state = applyAction(state, action).state;
    } catch (err) {
      console.error(`applyAction threw:`, err);
      break;
    }
    actionCount++;
  }

  return {
    winners: state.winners ?? [],
    rounds: state.round,
    vp: {
      xarm: state.powers.xarm.victoryPoints,
      gormen: state.powers.gormen.victoryPoints,
      tenzen: state.powers.tenzen.victoryPoints,
      lasha: state.powers.lasha.victoryPoints,
    },
    dial: {
      xarm: state.powers.xarm.dialPosition,
      gormen: state.powers.gormen.dialPosition,
      tenzen: state.powers.tenzen.dialPosition,
      lasha: state.powers.lasha.dialPosition,
    },
  };
}

if (baselineMode) {
  console.log(`[baseline] all-ref | games=${gameCount} seed=${baseSeed} iter=${mctsIterations}`);
} else {
  console.log(`[h2h] ${currentPower} current vs others=ref | games=${gameCount} seed=${baseSeed} iter=${mctsIterations}`);
}

const t0 = Date.now();
const wins: Record<Power, number> = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 };
let coWins = 0;
let noWinners = 0;
let totalRounds = 0;
let completed = 0;
const vpSum: Record<Power, number> = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 };
const dialSum: Record<Power, number> = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 };

for (let i = 0; i < gameCount; i++) {
  const seed = baseSeed + i;
  const t = Date.now();
  const r = runGame(seed);
  if (r.winners.length === 0) noWinners++;
  if (r.winners.length > 1) coWins++;
  for (const w of r.winners) wins[w]++;
  totalRounds += r.rounds;
  for (const p of ALL_POWERS) vpSum[p] += r.vp[p];
  for (const p of ALL_POWERS) dialSum[p] += r.dial[p];
  if (r.winners.length > 0) completed++;
  if ((i + 1) % 10 === 0 || i + 1 === gameCount) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  [${i+1}/${gameCount}] last ${((Date.now() - t)/1000).toFixed(1)}s, total ${elapsed}s, wins so far: ${ALL_POWERS.map(p => `${p}:${wins[p]}`).join(' ')}`);
  }
}

const wallTimeS = (Date.now() - t0) / 1000;

const result = {
  current_power: baselineMode ? 'baseline' : currentPower,
  baseline: baselineMode,
  games: gameCount,
  completed,
  no_winners: noWinners,
  co_wins: coWins,
  wins,
  win_rates: Object.fromEntries(ALL_POWERS.map(p => [p, wins[p] / gameCount])) as Record<Power, number>,
  avg_rounds: totalRounds / gameCount,
  vp_mean: Object.fromEntries(ALL_POWERS.map(p => [p, vpSum[p] / gameCount])) as Record<Power, number>,
  dial_mean: Object.fromEntries(ALL_POWERS.map(p => [p, dialSum[p] / gameCount])) as Record<Power, number>,
  iter: mctsIterations,
  seed_base: baseSeed,
  wall_time_s: wallTimeS,
};

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n[h2h] wrote ${outPath}`);
}

if (baselineMode) {
  console.log(`\n[baseline] ${ALL_POWERS.map(p => `${p}:${(result.win_rates[p]*100).toFixed(1)}%`).join(' ')} (${gameCount} games, ${wallTimeS.toFixed(0)}s)`);
} else {
  console.log(`\n[h2h] ${currentPower}: ${(result.win_rates[currentPower] * 100).toFixed(1)}% win rate (${wins[currentPower]}/${gameCount}, ${wallTimeS.toFixed(0)}s)`);
}
