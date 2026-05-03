/**
 * Fork a demo game at every summoning_action decision point and let the AI
 * play out each fork to completion. Each fork generates training samples in
 * the same format as collect-data.ts. Bad branches are the point — they
 * teach the value head "AI's alternative path leads to lower VP" and the
 * policy head "the human's action was preferred."
 *
 * Usage:
 *   pnpm tsx packages/server/src/scripts/fork-demo-data.ts \
 *     --game <gameId> --out /tmp/fork_<gameId>.jsonl [--max-forks 40]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { db } from '../db/client.js';
import { gameEvents, games, gamePlayers } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import {
  applyEvent, applyAction, autoAdvance, createInitialState, GameLog,
  type GameState, type GameEvent, type Power, type PlayerType, type Action,
} from '@ruin/engine';
import {
  runMcts, runMctsWithStats, greedyAction, extractFeatures, POWERS, powerIndex,
  canonicalActionIndex, ACTION_DIM,
} from '@ruin/ai';
import { loadLearnedModelIfPresent } from './load-model.js';

loadLearnedModelIfPresent();

function getArg(flag: string, def = ''): string {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] ? a[i + 1]! : def;
}

const gameId = getArg('--game');
const outPath = getArg('--out', `/tmp/fork_${gameId}.jsonl`);
const maxForks = parseInt(getArg('--max-forks', '40'), 10);
// Fork only at round boundaries (the first summoning_action of each round)
// when this >= 1. Default is 2 → fork at start of round 2, 3, 4, ... rather
// than every decision. Set 0 to fall back to per-decision forking.
const fromRound = parseInt(getArg('--from-round', '2'), 10);
const mctsIterations = parseInt(getArg('--iter', '3000'), 10);
const mctsTimeMs = parseInt(getArg('--time', '60000'), 10);
const rolloutPolicyArg = getArg('--rollout-policy', 'off') as 'off' | 'all' | 'tenzen' | 'except-tenzen';
// All-r0: skip rollouts everywhere; value head is the leaf eval.
const allRolloutZero = !process.argv.includes('--no-rollout-zero');
const rolloutDepth: number | undefined = allRolloutZero ? -1 : undefined;
const VP_TARGET = 50;
if (!gameId) { console.error('--game required'); process.exit(1); }

interface Sample {
  x: number[];
  p: number;
  visits?: Record<string, number>;
}

function computeRankTarget(state: GameState, winners: Power[] | null): number[] {
  const target = new Array(POWERS.length).fill(0);
  const winnerSet = new Set(winners ?? []);
  const ranking = [...POWERS].sort((a, b) => {
    const aw = winnerSet.has(a) ? 1 : 0;
    const bw = winnerSet.has(b) ? 1 : 0;
    if (aw !== bw) return bw - aw;
    return state.powers[b].victoryPoints - state.powers[a].victoryPoints;
  });
  const N = POWERS.length;
  for (let i = 0; i < ranking.length; i++) {
    const power = ranking[i]!;
    target[POWERS.indexOf(power)] = (N - 1 - i) / (N - 1);
  }
  const tenzenIdx = POWERS.indexOf('tenzen');
  if (tenzenIdx >= 0) {
    target[tenzenIdx] = Math.min(state.powers['tenzen'].victoryPoints / VP_TARGET, 1.0);
  }
  return target;
}

/**
 * Run AI play from the given state until the game ends. Mirrors collect-data.ts
 * inner loop but stripped of league/focus/HOF concerns. Returns the samples
 * collected and the final state.
 */
function playToEnd(initialState: GameState): { samples: Sample[]; finalState: GameState } {
  const samples: Sample[] = [];
  let state = initialState;
  let safety = 0;

  while (state.winners === null && state.phase !== 'completed') {
    if (++safety > 2000) { console.error(`safety break at action ${safety}`); break; }
    const pending = state.pendingAction;
    if (!pending) break;

    const waiter = pending.waitingFor;
    let action: Action;
    let visitsForSample: Record<string, number> | undefined;

    try {
      if (pending.actionKind === 'summoning_action') {
        const stats = runMctsWithStats(state, waiter, {
          iterations: mctsIterations,
          timeMs: mctsTimeMs,
          rolloutPolicy: rolloutPolicyArg,
          ...(rolloutDepth !== undefined ? { rolloutDepth } : {}),
        });
        action = stats.action;
        const slotVisits: Record<string, number> = {};
        for (const { action: a, visits } of stats.visitCounts) {
          const idx = canonicalActionIndex(a, state);
          if (idx >= 0 && idx < ACTION_DIM) {
            slotVisits[String(idx)] = (slotVisits[String(idx)] ?? 0) + visits;
          }
        }
        visitsForSample = slotVisits;

        samples.push({
          x: Array.from(extractFeatures(state, waiter)),
          p: powerIndex(waiter),
          visits: slotVisits,
        });
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
          ? runMcts(state, waiter, {
              iterations: mctsIterations,
              timeMs: mctsTimeMs,
              rolloutPolicy: rolloutPolicyArg,
              ...(rolloutDepth !== undefined ? { rolloutDepth } : {}),
            })
          : greedyAction(state, waiter);
      }
    } catch (err) {
      console.error(`MCTS threw at ${pending.actionKind}/${waiter}:`, err);
      break;
    }

    try {
      const r = applyAction(state, action);
      state = r.state;
    } catch (err) {
      console.error(`applyAction threw:`, err);
      break;
    }
  }

  return { samples, finalState: state };
}

async function main() {
  // Pull game + events
  const gameRow = (await db.select().from(games).where(eq(games.id, gameId)))[0];
  if (!gameRow) { console.error(`game ${gameId} not found`); process.exit(1); }
  const finalStoredState = gameRow.state as GameState;

  const playerRows = await db.select().from(gamePlayers).where(eq(gamePlayers.gameId, gameId));
  const activePowers = finalStoredState.activePowers as Power[];
  // Force every power to 'ai' so AI-driven play during the fork is legal.
  const aiPlayerTypes = Object.fromEntries(
    activePowers.map(p => [p, 'ai' as PlayerType]),
  ) as Record<Power, PlayerType>;

  const eventRows = await db.select({ seq: gameEvents.seq, event: gameEvents.event })
    .from(gameEvents).where(eq(gameEvents.gameId, gameId)).orderBy(asc(gameEvents.seq));
  if (eventRows.length === 0) { console.error('no events'); process.exit(1); }

  // First pass: replay all events while flagging fork points (states whose
  // pendingAction is summoning_action right before applying the next event).
  // Save those states for fork-and-play.
  const forkStates: GameState[] = [];
  const seenRounds = new Set<number>();
  let state: GameState = createInitialState({
    gameId, activePowers, playerTypes: aiPlayerTypes, seed: finalStoredState.rngSeed,
  });
  for (const r of eventRows) {
    const ev = r.event as GameEvent;
    if (state.pendingAction?.actionKind === 'summoning_action') {
      const isRoundBoundary = fromRound >= 1 && state.round >= fromRound && !seenRounds.has(state.round);
      const forkHere = fromRound < 1 || isRoundBoundary;
      if (forkHere) {
        forkStates.push(state);
        if (fromRound >= 1) seenRounds.add(state.round);
        if (forkStates.length >= maxForks) break;
      }
    }
    try {
      state = applyEvent(state, ev);
    } catch (err) {
      console.error(`applyEvent at seq ${r.seq} threw — stopping replay`, err);
      break;
    }
  }

  console.log(`Game ${gameId}: found ${forkStates.length} summoning_action fork points (cap ${maxForks})`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = fs.openSync(outPath, 'w');
  let totalSamples = 0;
  const t0 = Date.now();

  for (let i = 0; i < forkStates.length; i++) {
    const fs_t0 = Date.now();
    const fork = forkStates[i]!;
    const { samples, finalState } = playToEnd(fork);
    const target = computeRankTarget(finalState, finalState.winners);
    for (const s of samples) {
      const row: { x: number[]; t: number[]; p: number; visits?: Record<string, number> } = {
        x: s.x, t: target, p: s.p,
      };
      if (s.visits) row.visits = s.visits;
      fs.writeSync(out, JSON.stringify(row) + '\n');
    }
    totalSamples += samples.length;
    const dt = ((Date.now() - fs_t0) / 1000).toFixed(1);
    const tVP = finalState.powers['tenzen'].victoryPoints;
    const winStr = finalState.winners?.join('+') ?? '-';
    console.log(`  fork ${i+1}/${forkStates.length} (round ${fork.round}, ${fork.pendingAction?.waitingFor}): ${winStr} | tenzen ${tVP}VP | ${samples.length} samples (${dt}s)`);
  }

  fs.closeSync(out);
  const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nWrote ${totalSamples} samples → ${outPath}  (total ${totalTime}s)`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
