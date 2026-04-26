/**
 * Replay a saved game from the DB up to a specified decision and run a
 * fresh MCTS probe at that state. Reports visit / prior / value distribution
 * across the legal actions so you can see why a particular choice was made.
 *
 * Usage:
 *   pnpm tsx packages/server/src/scripts/probe-game-decision.ts \
 *     --game <gameId> [--match incarnation|cultist|warrior|seq=N]
 *
 *   --match incarnation: stop right before the first tenzen incarnation summon
 *   --match cultist:     stop right before the first tenzen cultist summon
 *   --match seq=N:       stop right before the awaiting_action at seq N
 */

import { db } from '../db/client.js';
import { gameEvents, games, gamePlayers } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { applyEvent, createInitialState, type GameState, type GameEvent, type Power, type PlayerType, getLegalActions } from '@ruin/engine';
import { probeMctsSearch, canonicalActionIndex } from '@ruin/ai';
import { loadLearnedModelIfPresent } from './load-model.js';

function getArg(flag: string, def = ''): string {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] ? a[i + 1]! : def;
}

const gameId = getArg('--game');
const match = getArg('--match', 'incarnation');
const iters = parseInt(getArg('--iter', '3000'), 10);
const timeMs = parseInt(getArg('--time', '999999'), 10);
if (!gameId) { console.error('--game required'); process.exit(1); }

loadLearnedModelIfPresent();

async function main() {
  const rows = await db.select({ seq: gameEvents.seq, event: gameEvents.event })
    .from(gameEvents).where(eq(gameEvents.gameId, gameId)).orderBy(asc(gameEvents.seq));
  if (rows.length === 0) { console.error('no events for game'); process.exit(1); }

  // Find target seq: awaiting_action whose NEXT event matches what we want.
  let targetSeq = -1;
  if (match.startsWith('seq=')) {
    targetSeq = parseInt(match.slice(4), 10);
  } else {
    for (let i = 0; i < rows.length - 1; i++) {
      const ev = rows[i]!.event as GameEvent;
      const next = rows[i + 1]!.event as GameEvent;
      if (ev.type === 'awaiting_action' && (ev as any).power === 'tenzen' && (ev as any).actionKind === 'summoning_action'
          && next.type === 'summon_figure'
          && (next as any).power === 'tenzen'
          && (next as any).followerClass === match) {
        targetSeq = rows[i]!.seq;
        break;
      }
    }
  }
  if (targetSeq < 0) { console.error(`no matching decision for ${match}`); process.exit(1); }
  console.log(`replaying to seq=${targetSeq} (${match} decision)`);

  // Reconstruct initial state via createInitialState (events log changes only).
  const gameRow = (await db.select().from(games).where(eq(games.id, gameId)))[0];
  if (!gameRow) { console.error('game not found'); process.exit(1); }
  const playerRows = await db.select().from(gamePlayers).where(eq(gamePlayers.gameId, gameId));
  const finalState = gameRow.state as GameState;
  const activePowers = finalState.activePowers as Power[];
  const playerTypes = Object.fromEntries(
    activePowers.map(p => {
      const row = playerRows.find(r => r.power === p);
      return [p, (row?.playerType ?? 'ai') as PlayerType];
    }),
  ) as Record<Power, PlayerType>;
  const seed = finalState.rngSeed;
  let state: GameState = createInitialState({ gameId, activePowers, playerTypes, seed });

  // Replay events up to and INCLUDING targetSeq (so pendingAction is set).
  for (const r of rows) {
    const ev = r.event as GameEvent;
    state = applyEvent(state, ev);
    if (r.seq === targetSeq) break;
  }
  if (state.pendingAction === null) { console.error('no pendingAction at target — wrong seq?'); process.exit(1); }

  const power = state.pendingAction.waitingFor;
  console.log(`\nState: round ${state.round} phase ${state.phase}`);
  console.log(`Tenzen PP=${state.powers.tenzen.powerPoints}/${state.powers.tenzen.basePowerPoints}`);
  console.log(`Tenzen on board: ${state.powers.tenzen.followers.filter(f => f.regionId).map(f => `${f.class}@${f.regionId}`).join(', ') || '(none)'}`);
  console.log(`Tenzen reserve: ${state.powers.tenzen.followers.filter(f => !f.regionId).length} figures`);
  console.log(`Tenzen hand: ${state.powers.tenzen.hand.join(', ')}`);

  const legal = getLegalActions(state, power);
  console.log(`\n${legal.length} legal actions for ${power}\n`);

  // Run MCTS probe at this state with configurable budget. UI default: time-cap 300ms.
  console.log(`MCTS budget: iter=${iters} time=${timeMs}ms`);
  const stats = probeMctsSearch(state, power, { iterations: iters, timeMs });
  console.log(`actual: ${stats.iterations} iters in ${stats.timeMs}ms (timeCap=${stats.hitTimeCap} iterCap=${stats.hitIterCap})`);

  // Sort root actions by visits desc.
  const sorted = [...stats.rootActions].sort((a, b) => b.visits - a.visits);
  const totalVisits = sorted.reduce((acc, x) => acc + x.visits, 0);

  console.log(`Top 20 actions by visits (chosen: ${stats.topVisitKind}):`);
  console.log('rank  visits  pct   prior  actionKind   slotIdx');
  for (let i = 0; i < Math.min(20, sorted.length); i++) {
    const a = sorted[i]!;
    const pct = totalVisits > 0 ? (a.visits / totalVisits * 100).toFixed(1) : '0.0';
    console.log(`${String(i+1).padStart(3)}.  ${String(a.visits).padStart(5)}  ${pct.padStart(4)}%  ${a.prior.toFixed(3)}  ${a.actionKind.padEnd(20)}  ${a.slotIdx}`);
  }

  // Look up the legal actions to map kinds to specific decisions.
  console.log('\nLegal action breakdown (count by class+region):');
  const byKind = new Map<string, number>();
  for (const a of legal) {
    let k: string;
    if (a.kind === 'summoning_summon_figure') {
      const fid = (a as any).followerId as string;
      const f = state!.powers[power].followers.find(ff => ff.id === fid);
      k = `summon ${f?.class ?? '?'} → ${(a as any).toRegion}`;
    } else if (a.kind === 'summoning_play_card') {
      k = `play ${(a as any).cardId} → ${(a as any).toRegion}`;
    } else {
      k = a.kind;
    }
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${n}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
