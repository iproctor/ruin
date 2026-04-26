/**
 * AI benchmark — runs N headless games and reports structured metrics:
 *
 *   - Win rate per power
 *   - Average rounds per game
 *   - DAC-per-round per power, capped at 1 per round per power (to reward
 *     engagement without biasing toward dial-rush strategies)
 *   - Xarm DAC rate (special metric — if near 0, xarm isn't attacking)
 *   - Double-tick rate: fraction of rounds where a power got ≥2 dial advances
 *   - Game completion rate
 *
 * Usage (from repo root):
 *   pnpm benchmark [--games 20] [--seed 1] [--out metrics.json]
 */

import {
  createInitialState, applyAction, getLegalActions, enumerateBattleHitStrategies, autoAdvance, GameLog,
} from '@ruin/engine';
import { runMcts, greedyAction } from '@ruin/ai';
import type { Power, Action, GameEvent } from '@ruin/engine';
import { followersInRegion } from '@ruin/engine';
import { loadLearnedModelIfPresent } from './load-model.js';
import * as fs from 'node:fs';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
}

const gameCount = parseInt(getArg('--games', '10'), 10);
const playerCount = parseInt(getArg('--players', '4'), 10) as 2 | 3 | 4;
const baseSeed = parseInt(getArg('--seed', '1'), 10);
const maxActions = parseInt(getArg('--max-actions', '2000'), 10);
const outPath = getArg('--out', '');
// Optional explicit model path. If omitted, falls back to packages/ai/data/model.json.
// Lets benches load any historical iter snapshot without touching model.json.
const modelPath = getArg('--model', '');
const rolloutDepthArg = getArg('--rollout-depth', '');
const rolloutDepthPowerArg = getArg('--rollout-depth-power', '');
const mctsOpts = rolloutDepthArg && !rolloutDepthPowerArg
  ? { rolloutDepth: parseInt(rolloutDepthArg, 10) }
  : undefined;
// When --rollout-depth-power is set, the depth only applies to that power;
// other powers use the default. Lets us isolate the effect of pure-value-head
// mode on a single power.
const perPowerRolloutDepth: Partial<Record<Power, number>> = {};
if (rolloutDepthArg && rolloutDepthPowerArg) {
  perPowerRolloutDepth[rolloutDepthPowerArg as Power] = parseInt(rolloutDepthArg, 10);
}

loadLearnedModelIfPresent(modelPath || undefined);

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
const activePowers = ALL_POWERS.slice(0, playerCount);

// ── Per-game runner ───────────────────────────────────────────────────────────

interface PlayIndicators {
  // Lasha — should be moving nobles via Hidden Influence
  lashaNobleMoves: number;
  // Lasha — VP scoring events from ruination (one per scoring event, ties counted)
  lashaRuinScores: number;
  // Xarm — corruption tokens "prevented" by War Cry plays. Computed as
  // count of enemy cultists in the region at the moment War Cry was played
  // (each cultist would have placed 1 corruption next phase).
  xarmWarCryPrevented: number;
  // Gormen — count of dominations in populous regions (volensk, mittelreich,
  // normagne, almerida). Repeated dominations across rounds count separately.
  gormenPopulousDominations: number;
  // Tenzen — average count of tenzen cultists alive per round (sampled at
  // each round transition). Higher = more cultist-engine play.
  tenzenAvgCultists: number;
  // Tenzen — total cards played per game. Tenzen draws to 5 each round and
  // should be playing many cards (its strategy is card-driven). Low values
  // indicate the model isn't using tenzen's deck.
  tenzenCardsPlayed: number;
  // Per-power VP earned from domination and ruination, parsed from logs.
  vpFromDomination: Record<Power, number>;
  vpFromRuination: Record<Power, number>;
  // Internal: rolling sum + count for tenzen cultists
  _tenzenCultistSum: number;
  _tenzenCultistSamples: number;
}

interface GameResult {
  winners: Power[];
  winCondition: string;
  rounds: number;
  // Round → Power → true if power earned ≥1 DAC that round (capped at 1)
  dacByRound: Record<number, Partial<Record<Power, boolean>>>;
  // Round → Power → raw count of dial_advance events that round.
  // A "double tick" is a round where this count is ≥ 2 for a given power.
  dialAdvancesByRound: Record<number, Partial<Record<Power, number>>>;
  indicators: PlayIndicators;
  finalVP: Record<Power, number>;
  error?: string;
}

function emptyIndicators(): PlayIndicators {
  return {
    lashaNobleMoves: 0,
    lashaRuinScores: 0,
    xarmWarCryPrevented: 0,
    gormenPopulousDominations: 0,
    tenzenAvgCultists: 0,
    tenzenCardsPlayed: 0,
    vpFromDomination: { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 },
    vpFromRuination: { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 },
    _tenzenCultistSum: 0,
    _tenzenCultistSamples: 0,
  };
}

const POPULOUS_REGIONS = new Set(['volensk', 'mittelreich', 'normagne', 'almerida']);

// Error log sidecar — verbose error capture for debugging. Append-only.
const ERROR_LOG_PATH = '/tmp/benchmark-errors.log';
function writeErrorLog(entry: Record<string, unknown>): void {
  try {
    fs.appendFileSync(
      ERROR_LOG_PATH,
      `\n=== ${new Date().toISOString()} ===\n` + JSON.stringify(entry, null, 2) + '\n',
    );
  } catch {
    // ignore
  }
}

function captureErr(err: unknown): { message: string; stack: string | null } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack ?? null };
  }
  return { message: String(err), stack: null };
}

function scanLogForDac(
  events: GameEvent[],
  round: number,
  dacByRound: Record<number, Partial<Record<Power, boolean>>>,
): void {
  for (const event of events) {
    if (event.type === 'dial_counter') {
      if (!dacByRound[round]) dacByRound[round] = {};
      dacByRound[round]![event.power] = true;
    }
  }
}

function scanLogForDialAdvances(
  events: GameEvent[],
  round: number,
  dialAdvancesByRound: Record<number, Partial<Record<Power, number>>>,
): void {
  for (const event of events) {
    if (event.type === 'dial_advance') {
      if (!dialAdvancesByRound[round]) dialAdvancesByRound[round] = {};
      const bucket = dialAdvancesByRound[round]!;
      bucket[event.power] = (bucket[event.power] ?? 0) + 1;
    }
  }
}

function scanLogForIndicators(events: GameEvent[], indicators: PlayIndicators): void {
  for (const event of events) {
    // Noble moves via Hidden Influence
    if (event.type === 'card_effect' && event.subtype === 'hidden_influence' && event.tokenType === 'noble') {
      indicators.lashaNobleMoves++;
      continue;
    }
    // Ruination scoring — lasha involvement
    if (event.type === 'ruination_scoring' && (event.first.includes('lasha') || event.second.includes('lasha'))) {
      indicators.lashaRuinScores++;
    }
    // Domination results
    if (event.type === 'domination_result' && event.conquered && event.power !== null) {
      indicators.vpFromDomination[event.power] += event.vp;
      if (event.power === 'gormen' && POPULOUS_REGIONS.has(event.regionId)) {
        indicators.gormenPopulousDominations++;
      }
      continue;
    }
    // Ruination end-phase scoring — VP attribution
    if (event.type === 'ruination_scoring') {
      for (const p of event.first) {
        indicators.vpFromRuination[p] += event.firstVP;
      }
      for (const p of event.second) {
        indicators.vpFromRuination[p] += event.secondVP;
      }
      continue;
    }
  }
}

function runGame(seed: number): GameResult {
  const dacByRound: Record<number, Partial<Record<Power, boolean>>> = {};
  const dialAdvancesByRound: Record<number, Partial<Record<Power, number>>> = {};
  const indicators = emptyIndicators();

  let { state, log: initialLog } = autoAdvance({
    state: createInitialState({
      gameId: `bench-${seed}`,
      activePowers,
      playerTypes: Object.fromEntries(activePowers.map(p => [p, 'ai'])) as Record<Power, 'ai'>,
      seed,
    }),
    log: new GameLog(),
  });

  // Scan initial setup log too
  scanLogForDac(initialLog.events, state.round, dacByRound);
  scanLogForDialAdvances(initialLog.events, state.round, dialAdvancesByRound);
  scanLogForIndicators(initialLog.events, indicators);

  // Sample tenzen cultist count at game start
  const sampleTenzen = (): void => {
    const ts = state.powers.tenzen;
    if (!ts) return;
    const live = ts.followers.filter(
      f => f.regionId !== null && !f.tipped && f.class === 'cultist',
    ).length;
    indicators._tenzenCultistSum += live;
    indicators._tenzenCultistSamples += 1;
  };
  sampleTenzen();

  let actionCount = 0;

  while (state.winners === null && state.phase !== 'completed') {
    if (actionCount >= maxActions) {
      return { winners: [], winCondition: 'timeout', rounds: state.round, dacByRound, dialAdvancesByRound, indicators, finalVP: { xarm: state.powers.xarm!.victoryPoints, gormen: state.powers.gormen!.victoryPoints, tenzen: state.powers.tenzen!.victoryPoints, lasha: state.powers.lasha!.victoryPoints }, error: `maxActions` };
    }
    const pending = state.pendingAction;
    if (!pending) {
      return { winners: [], winCondition: 'stuck', rounds: state.round, dacByRound, dialAdvancesByRound, indicators, finalVP: { xarm: state.powers.xarm!.victoryPoints, gormen: state.powers.gormen!.victoryPoints, tenzen: state.powers.tenzen!.victoryPoints, lasha: state.powers.lasha!.victoryPoints }, error: `no pendingAction` };
    }

    let legal: Action[];
    try {
      legal = pending.actionKind === 'battle_hit_assignment'
        ? enumerateBattleHitStrategies(state, pending.waitingFor)
        : getLegalActions(state, pending.waitingFor);
    } catch (err) {
      const e = captureErr(err);
      writeErrorLog({
        seed, kind: 'getLegalActions threw',
        round: state.round, phase: state.phase,
        actionKind: pending.actionKind, power: pending.waitingFor,
        context: pending.context,
        message: e.message, stack: e.stack,
      });
      return { winners: [], winCondition: 'error', rounds: state.round, dacByRound, dialAdvancesByRound, indicators, finalVP: { xarm: state.powers.xarm!.victoryPoints, gormen: state.powers.gormen!.victoryPoints, tenzen: state.powers.tenzen!.victoryPoints, lasha: state.powers.lasha!.victoryPoints }, error: `getLegalActions: ${e.message}` };
    }
    if (legal.length === 0) {
      writeErrorLog({
        seed, kind: 'no legal actions',
        round: state.round, phase: state.phase,
        actionKind: pending.actionKind, power: pending.waitingFor,
        context: pending.context,
      });
      return { winners: [], winCondition: 'error', rounds: state.round, dacByRound, dialAdvancesByRound, indicators, finalVP: { xarm: state.powers.xarm!.victoryPoints, gormen: state.powers.gormen!.victoryPoints, tenzen: state.powers.tenzen!.victoryPoints, lasha: state.powers.lasha!.victoryPoints }, error: 'no legal actions' };
    }

    let action: Action;
    try {
      // Use MCTS for any decision where lookahead matters strategically.
      // - summoning_action: the main strategic phase
      // - battle_hit_assignment: per-(power, class) kill commitments
      // - dial_*: rewards from advancing the dial — affect long-term board state
      // - world_choice / world_card_effect: token placements that shape the game
      // - upgrade_choice: a permanent, game-changing choice
      // These are all infrequent enough that MCTS overhead is acceptable.
      const useMcts =
        pending.actionKind === 'summoning_action' ||
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
      const perPowerOverride = perPowerRolloutDepth[pending.waitingFor as Power];
      const effectiveOpts = perPowerOverride !== undefined
        ? { rolloutDepth: perPowerOverride }
        : mctsOpts;
      action = useMcts
        ? runMcts(state, pending.waitingFor, effectiveOpts)
        : greedyAction(state, pending.waitingFor);
    } catch (err) {
      const e = captureErr(err);
      writeErrorLog({
        seed, kind: 'action selection threw',
        round: state.round, phase: state.phase,
        actionKind: pending.actionKind, power: pending.waitingFor,
        context: pending.context,
        legalSample: legal.slice(0, 5).map(a => ({ kind: a.kind, ...((a as { cardId?: string }).cardId ? { cardId: (a as { cardId: string }).cardId } : {}) })),
        legalCount: legal.length,
        message: e.message, stack: e.stack,
      });
      return { winners: [], winCondition: 'error', rounds: state.round, dacByRound, dialAdvancesByRound, indicators, finalVP: { xarm: state.powers.xarm!.victoryPoints, gormen: state.powers.gormen!.victoryPoints, tenzen: state.powers.tenzen!.victoryPoints, lasha: state.powers.lasha!.victoryPoints }, error: `select: ${e.message}` };
    }

    // War Cry prevented: compute BEFORE applying — count enemy cultists
    // currently in the region xarm is War-Crying. Each cultist would have
    // placed 1 corruption in the next corruption phase; War Cry blocks them.
    if (
      action.kind === 'summoning_play_card' &&
      action.cardId === 'xarm_war_cry' &&
      action.power === 'xarm'
    ) {
      const region = state.regions[action.toRegion];
      if (region) {
        const enemyCultists = followersInRegion(state, action.toRegion).filter(
          f =>
            !f.tipped &&
            f.class === 'cultist' &&
            (f.controlledBy ?? f.power) !== 'xarm',
        ).length;
        indicators.xarmWarCryPrevented += enemyCultists;
      }
    }

    // Tenzen cards played: count any card play action by tenzen.
    if (action.kind === 'summoning_play_card' && action.power === 'tenzen') {
      indicators.tenzenCardsPlayed++;
    }

    try {
      const result = applyAction(state, action);
      const prevRound = state.round;
      // Dial advances happen at end-of-round; use the round BEFORE the
      // transition so the advance is attributed to the round it summed from.
      scanLogForDac(result.log.events, state.round, dacByRound);
      scanLogForDialAdvances(result.log.events, state.round, dialAdvancesByRound);
      scanLogForIndicators(result.log.events, indicators);
      state = result.state;
      // Sample tenzen cultists on every round transition (post-end-phase
      // snapshot of the durable cultist count).
      if (state.round !== prevRound && state.winners === null) sampleTenzen();
    } catch (err) {
      const e = captureErr(err);
      writeErrorLog({
        seed, kind: 'applyAction threw',
        round: state.round, phase: state.phase,
        actionKind: pending.actionKind, power: pending.waitingFor,
        action,
        message: e.message, stack: e.stack,
      });
      return { winners: [], winCondition: 'error', rounds: state.round, dacByRound, dialAdvancesByRound, indicators, finalVP: { xarm: state.powers.xarm!.victoryPoints, gormen: state.powers.gormen!.victoryPoints, tenzen: state.powers.tenzen!.victoryPoints, lasha: state.powers.lasha!.victoryPoints }, error: `apply: ${e.message}` };
    }

    actionCount++;
  }

  // Finalize tenzen cultist average
  if (indicators._tenzenCultistSamples > 0) {
    indicators.tenzenAvgCultists =
      indicators._tenzenCultistSum / indicators._tenzenCultistSamples;
  }

  return {
    winners: (state.winners ?? []) as Power[],
    winCondition: state.winCondition ?? 'unknown',
    rounds: state.round,
    dacByRound,
    dialAdvancesByRound,
    indicators,
    finalVP: {
      xarm: state.powers.xarm!.victoryPoints,
      gormen: state.powers.gormen!.victoryPoints,
      tenzen: state.powers.tenzen!.victoryPoints,
      lasha: state.powers.lasha!.victoryPoints,
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n=== AI Benchmark ===`);
console.log(`Games: ${gameCount}  |  Players: ${activePowers.join(', ')}  |  Seed: ${baseSeed}`);
console.log(`────────────────────────────────────────`);

const totalStart = Date.now();
const wins: Record<Power, number> = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 };
const winConditions: Record<string, number> = {};
const roundCounts: number[] = [];
// Sum of "rounds where power earned ≥1 DAC" across all games:
const dacRoundsByPower: Record<Power, number> = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 };
// Sum of "rounds where power earned ≥2 dial advances" across all games:
const doubleTickRoundsByPower: Record<Power, number> = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 };
// Per-power play indicators aggregated across games (sums; averaged below)
const vpSamples: Record<Power, number[]> = { xarm: [], gormen: [], tenzen: [], lasha: [] };
const spreadSamples: number[] = []; // winner VP minus last-place VP, per game
const aggIndicators = {
  lashaNobleMoves: 0,
  lashaRuinScores: 0,
  xarmWarCryPrevented: 0,
  gormenPopulousDominations: 0,
  tenzenAvgCultistsSum: 0, // sum of per-game averages → divide by completed
  tenzenCardsPlayed: 0,
  vpFromDomination: { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 } as Record<Power, number>,
  vpFromRuination: { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 } as Record<Power, number>,
};
const errors: string[] = [];
const noWinners: string[] = [];
let completed = 0;

for (let i = 0; i < gameCount; i++) {
  const seed = baseSeed + i;
  process.stdout.write(`  ${String(i + 1).padStart(3)}/${gameCount} seed ${seed}: `);
  const t0 = Date.now();
  const result = runGame(seed);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (result.error) {
    errors.push(`seed ${seed}: ${result.error}`);
    console.log(`ERROR ${result.error} (${elapsed}s)`);
    continue;
  }
  if (result.winners.length === 0) {
    // World exhaustion under the no-winners rule = expected outcome, not a
    // bug. Track separately from real errors so bench output isn't misleading.
    noWinners.push(`seed ${seed}: ${result.winCondition}`);
    winConditions[result.winCondition] = (winConditions[result.winCondition] ?? 0) + 1;
    console.log(`NO WINNER ${result.winCondition} (${elapsed}s)`);
    continue;
  }

  completed++;
  roundCounts.push(result.rounds);
  winConditions[result.winCondition] = (winConditions[result.winCondition] ?? 0) + 1;
  for (const w of result.winners) wins[w] += 1 / result.winners.length;

  // VP samples per power, and per-game spread (max - min)
  for (const p of activePowers) vpSamples[p].push(result.finalVP[p]);
  const vpVals = activePowers.map(p => result.finalVP[p]);
  spreadSamples.push(Math.max(...vpVals) - Math.min(...vpVals));

  // Tally play indicators
  aggIndicators.lashaNobleMoves        += result.indicators.lashaNobleMoves;
  aggIndicators.lashaRuinScores        += result.indicators.lashaRuinScores;
  aggIndicators.xarmWarCryPrevented    += result.indicators.xarmWarCryPrevented;
  aggIndicators.gormenPopulousDominations += result.indicators.gormenPopulousDominations;
  aggIndicators.tenzenAvgCultistsSum   += result.indicators.tenzenAvgCultists;
  aggIndicators.tenzenCardsPlayed      += result.indicators.tenzenCardsPlayed;
  for (const p of activePowers) {
    aggIndicators.vpFromDomination[p] += result.indicators.vpFromDomination[p];
    aggIndicators.vpFromRuination[p]  += result.indicators.vpFromRuination[p];
  }

  // Tally DAC-rounds
  for (const roundKey of Object.keys(result.dacByRound)) {
    const bucket = result.dacByRound[parseInt(roundKey, 10)]!;
    for (const p of activePowers) {
      if (bucket[p]) dacRoundsByPower[p]++;
    }
  }

  // Tally double-tick rounds (dial advanced ≥ 2 in the same round)
  for (const roundKey of Object.keys(result.dialAdvancesByRound)) {
    const bucket = result.dialAdvancesByRound[parseInt(roundKey, 10)]!;
    for (const p of activePowers) {
      if ((bucket[p] ?? 0) >= 2) doubleTickRoundsByPower[p]++;
    }
  }

  // Short per-game DAC string: x/g/t/l counts over this game
  const thisGameDac: Record<Power, number> = { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 };
  for (const roundKey of Object.keys(result.dacByRound)) {
    const bucket = result.dacByRound[parseInt(roundKey, 10)]!;
    for (const p of activePowers) if (bucket[p]) thisGameDac[p]++;
  }
  const dacStr = `DAC:${thisGameDac.xarm}/${thisGameDac.gormen}/${thisGameDac.tenzen}/${thisGameDac.lasha}`;
  console.log(
    `${result.winners.join('+').padEnd(14)} ${result.winCondition.padEnd(16)} ${result.rounds}r ${dacStr} (${elapsed}s)`
  );
}

const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);

console.log(`\n────────────────────────────────────────`);
console.log(`WIN RATES (${completed}/${gameCount} completed):`);
const sortedWins = Object.entries(wins).sort((a, b) => b[1] - a[1]);
for (const [power, w] of sortedWins) {
  const pct = completed > 0 ? ((w / completed) * 100).toFixed(1) : '0.0';
  const bar = '█'.repeat(Math.round(Number(pct) / 5));
  console.log(`  ${power.padEnd(8)} ${pct.padStart(5)}%  ${bar}`);
}

const avgRounds = roundCounts.length > 0
  ? roundCounts.reduce((a, b) => a + b, 0) / roundCounts.length
  : 0;
const totalRounds = roundCounts.reduce((a, b) => a + b, 0);

console.log(`\nDAC METRIC (rounds-with-DAC / total-rounds, capped at 1/round/power):`);
for (const p of activePowers) {
  const rate = totalRounds > 0 ? dacRoundsByPower[p] / totalRounds : 0;
  const bar = '█'.repeat(Math.round(rate * 20));
  const marker = p === 'xarm' ? ' ← xarm is critical' : '';
  console.log(`  ${p.padEnd(8)} ${(rate * 100).toFixed(1).padStart(5)}%  ${bar}${marker}`);
}

console.log(`\nDOUBLE TICK RATE (rounds with ≥2 dial advances / total-rounds):`);
for (const p of activePowers) {
  const rate = totalRounds > 0 ? doubleTickRoundsByPower[p] / totalRounds : 0;
  const bar = '█'.repeat(Math.round(rate * 20));
  console.log(`  ${p.padEnd(8)} ${(rate * 100).toFixed(1).padStart(5)}%  ${bar}`);
}

console.log(`\nPLAY INDICATORS (per game avg, ${completed} games):`);
const perGame = (n: number): string => completed > 0 ? (n / completed).toFixed(2) : '0.00';
console.log(`  lasha    noble moves:           ${perGame(aggIndicators.lashaNobleMoves)}`);
console.log(`  lasha    ruination scores:      ${perGame(aggIndicators.lashaRuinScores)}`);
console.log(`  xarm     war cry prevented:     ${perGame(aggIndicators.xarmWarCryPrevented)}  (cultists blocked)`);
console.log(`  gormen   populous dominations:  ${perGame(aggIndicators.gormenPopulousDominations)}`);
console.log(`  tenzen   avg cultists alive:    ${perGame(aggIndicators.tenzenAvgCultistsSum)}  (per round)`);
console.log(`  tenzen   cards played:          ${perGame(aggIndicators.tenzenCardsPlayed)}  (per game)`);

console.log(`\nVP SOURCES (per game avg):`);
console.log(`  power     domination  ruination`);
for (const p of activePowers) {
  const dom = perGame(aggIndicators.vpFromDomination[p]);
  const ruin = perGame(aggIndicators.vpFromRuination[p]);
  console.log(`  ${p.padEnd(8)}  ${dom.padStart(8)}  ${ruin.padStart(9)}`);
}

function mean(xs: number[]): number { return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0; }
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a,b)=>a+(b-m)*(b-m),0)/xs.length);
}

console.log(`\nVP STATS (final VP per power):`);
for (const p of activePowers) {
  const xs = vpSamples[p];
  const m = mean(xs).toFixed(1);
  const sd = stddev(xs).toFixed(1);
  const lo = xs.length ? Math.min(...xs) : 0;
  const hi = xs.length ? Math.max(...xs) : 0;
  console.log(`  ${p.padEnd(8)} mean ${m.padStart(5)}  sd ${sd.padStart(4)}  min ${String(lo).padStart(3)}  max ${String(hi).padStart(3)}`);
}
console.log(`  spread (winner − last) avg ${mean(spreadSamples).toFixed(1)}`);

console.log(`\nROUNDS: avg ${avgRounds.toFixed(1)}, min ${Math.min(...roundCounts) || 0}, max ${Math.max(...roundCounts) || 0}`);
console.log(`\nWIN CONDITIONS:`);
for (const [c, n] of Object.entries(winConditions).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.padEnd(18)} ${n}`);
}

if (noWinners.length > 0) {
  console.log(`\nNO WINNER (${noWinners.length}): expected under no-winners-on-exhaustion rule`);
  for (const e of noWinners.slice(0, 3)) console.log(`  - ${e}`);
  if (noWinners.length > 3) console.log(`  ... +${noWinners.length - 3} more`);
}
if (errors.length > 0) {
  console.log(`\nERRORS (${errors.length}):`);
  for (const e of errors.slice(0, 5)) console.log(`  - ${e}`);
  if (errors.length > 5) console.log(`  ... +${errors.length - 5} more`);
}
console.log(`\nTotal time: ${totalElapsed}s\n`);

// Optional JSON output for comparing runs
if (outPath) {
  const metrics = {
    games: gameCount,
    completed,
    winRates: Object.fromEntries(
      Object.entries(wins).map(([p, w]) => [p, completed > 0 ? w / completed : 0])
    ),
    dacRatePerPower: Object.fromEntries(
      Object.entries(dacRoundsByPower).map(([p, r]) => [p, totalRounds > 0 ? r / totalRounds : 0])
    ),
    doubleTickRatePerPower: Object.fromEntries(
      Object.entries(doubleTickRoundsByPower).map(([p, r]) => [p, totalRounds > 0 ? r / totalRounds : 0])
    ),
    playIndicators: {
      lashaNobleMovesPerGame: completed > 0 ? aggIndicators.lashaNobleMoves / completed : 0,
      lashaRuinScoresPerGame: completed > 0 ? aggIndicators.lashaRuinScores / completed : 0,
      xarmWarCryPreventedPerGame: completed > 0 ? aggIndicators.xarmWarCryPrevented / completed : 0,
      gormenPopulousDominationsPerGame: completed > 0 ? aggIndicators.gormenPopulousDominations / completed : 0,
      tenzenAvgCultists: completed > 0 ? aggIndicators.tenzenAvgCultistsSum / completed : 0,
      tenzenCardsPlayedPerGame: completed > 0 ? aggIndicators.tenzenCardsPlayed / completed : 0,
      vpFromDominationPerGame: Object.fromEntries(activePowers.map(p => [p, completed > 0 ? aggIndicators.vpFromDomination[p] / completed : 0])),
      vpFromRuinationPerGame: Object.fromEntries(activePowers.map(p => [p, completed > 0 ? aggIndicators.vpFromRuination[p] / completed : 0])),
    },
    vpStats: Object.fromEntries(activePowers.map(p => [p, {
      mean: mean(vpSamples[p]),
      sd: stddev(vpSamples[p]),
      min: vpSamples[p].length ? Math.min(...vpSamples[p]) : 0,
      max: vpSamples[p].length ? Math.max(...vpSamples[p]) : 0,
    }])),
    avgVpSpread: mean(spreadSamples),
    avgRounds,
    winConditions,
    errors: errors.length,
    noWinners: noWinners.length,
    timeSeconds: parseFloat(totalElapsed),
  };
  fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2));
  console.log(`Metrics written to ${outPath}\n`);
}
