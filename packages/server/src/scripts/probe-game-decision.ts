/**
 * Replay a saved game from the DB and probe every decision the target power
 * made. At each pendingAction for that power, run MCTS and report what it
 * picks now vs what was actually played in the game.
 *
 * Usage:
 *   pnpm tsx packages/server/src/scripts/probe-game-decision.ts \
 *     --game <gameId> [--power tenzen] [--kind summoning_action]
 *     [--match incarnation|cultist|warrior|seq=N|all] [--iter 3000]
 *
 *   --match incarnation: only probe the first tenzen incarnation summon
 *   --match cultist:     only probe the first tenzen cultist summon
 *   --match seq=N:       only probe the awaiting_action at seq N
 *   --match all:         probe every decision (default)
 */

import { db } from '../db/client.js';
import { gameEvents, games, gamePlayers } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { applyEvent, createInitialState, type GameState, type GameEvent, type Power, type PlayerType, type Action, getLegalActions } from '@ruin/engine';
import { probeMctsSearch, canonicalActionIndex } from '@ruin/ai';
import { loadLearnedModelIfPresent } from './load-model.js';

function getArg(flag: string, def = ''): string {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] ? a[i + 1]! : def;
}

const gameId = getArg('--game');
const targetPower = (getArg('--power', 'tenzen')) as Power;
const targetKind = getArg('--kind', 'summoning_action');
const match = getArg('--match', 'all');
const iters = parseInt(getArg('--iter', '3000'), 10);
const timeMs = parseInt(getArg('--time', '999999'), 10);
const topN = parseInt(getArg('--top', '15'), 10);
if (!gameId) { console.error('--game required'); process.exit(1); }

loadLearnedModelIfPresent();

function describeAction(state: GameState, a: Action): string {
  if (a.kind === 'summoning_summon_figure') {
    const fid = (a as any).followerId as string;
    const f = state.powers[a.power].followers.find(ff => ff.id === fid);
    return `summon ${f?.class ?? '?'} → ${(a as any).toRegion}`;
  }
  if (a.kind === 'summoning_play_card') {
    return `play ${(a as any).cardId} → ${(a as any).toRegion}`;
  }
  return a.kind;
}

function describeEventAsAction(ev: GameEvent): string {
  if (ev.type === 'summon_figure') return `summon ${ev.followerClass} → ${ev.toRegion}`;
  if (ev.type === 'play_card') return `play ${ev.cardId} → ${ev.toRegion}`;
  if (ev.type === 'summoning_pass') return `pass`;
  if (ev.type === 'tenzen_discard') return `discard ${ev.cardId ?? '(none)'}`;
  return ev.type;
}

function shouldProbe(decisionIdx: number, totalDecisions: number, awaitSeq: number, nextEv: GameEvent | null): boolean {
  if (match === 'all') return true;
  if (match.startsWith('seq=')) return awaitSeq === parseInt(match.slice(4), 10);
  if (!nextEv || nextEv.type !== 'summon_figure') return false;
  return (nextEv as any).followerClass === match;
}

async function main() {
  const rows = await db.select({ seq: gameEvents.seq, event: gameEvents.event })
    .from(gameEvents).where(eq(gameEvents.gameId, gameId)).orderBy(asc(gameEvents.seq));
  if (rows.length === 0) { console.error('no events for game'); process.exit(1); }

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

  console.log(`\n=== Probe game ${gameId} ===`);
  console.log(`power=${targetPower} kind=${targetKind} match=${match} iter=${iters}\n`);

  // Pre-count how many target-power decisions there are for progress reporting.
  let totalDecisions = 0;
  for (let i = 0; i < rows.length; i++) {
    const ev = rows[i]!.event as GameEvent;
    if (ev.type === 'awaiting_action' && (ev as any).power === targetPower && (ev as any).actionKind === targetKind) {
      totalDecisions++;
    }
  }

  let decisionIdx = 0;
  let probedCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const ev = r.event as GameEvent;
    state = applyEvent(state, ev);

    if (ev.type !== 'awaiting_action') continue;
    if ((ev as any).power !== targetPower || (ev as any).actionKind !== targetKind) continue;
    decisionIdx++;

    const nextEv = i + 1 < rows.length ? rows[i + 1]!.event as GameEvent : null;
    if (!shouldProbe(decisionIdx, totalDecisions, r.seq, nextEv)) continue;

    // Print state context
    const ps = state.powers[targetPower]!;
    console.log(`\n--- Decision ${decisionIdx}/${totalDecisions} (seq=${r.seq}, round=${state.round}) ---`);
    console.log(`  PP=${ps.powerPoints}/${ps.basePowerPoints}  hand=[${ps.hand.join(',')}]`);
    const board = ps.followers.filter(f => f.regionId).map(f => `${f.class}@${f.regionId}`).join(', ') || '(none)';
    console.log(`  board: ${board}`);
    const reserveByClass = { cultist: 0, warrior: 0, incarnation: 0 };
    for (const f of ps.followers) if (f.regionId === null) reserveByClass[f.class]++;
    console.log(`  reserve: cultists=${reserveByClass.cultist} warriors=${reserveByClass.warrior} incarnations=${reserveByClass.incarnation}`);

    // Brief region summary (only regions with figures or non-empty tokens)
    const interesting: string[] = [];
    for (const [rid, region] of Object.entries(state.regions)) {
      const figs: string[] = [];
      for (const p of state.activePowers) {
        for (const f of state.powers[p].followers) {
          if (f.regionId === rid) figs.push(`${p[0]}.${f.class[0]}`);
        }
      }
      const cards = region.chaosCards.filter(c => c).map(c => `${c!.playedBy[0]}.${c!.cardId.split('_').slice(-1)[0]}`);
      if (figs.length || cards.length || region.tokens.length) {
        const parts = [];
        if (region.tokens.length) parts.push(`t=[${region.tokens.join(',')}]`);
        if (figs.length) parts.push(`f=[${figs.join(',')}]`);
        if (cards.length) parts.push(`c=[${cards.join(',')}]`);
        interesting.push(`    ${rid.padEnd(13)} ${parts.join(' ')}`);
      }
    }
    if (interesting.length) console.log(`  regions:\n${interesting.join('\n')}`);

    // What was actually played
    const actualDesc = nextEv ? describeEventAsAction(nextEv) : '(unknown)';
    console.log(`  actual play: ${actualDesc}`);

    // Run MCTS
    const legal = getLegalActions(state, targetPower);
    const stats = probeMctsSearch(state, targetPower, { iterations: iters, timeMs });
    const totalVisits = stats.rootActions.reduce((acc, x) => acc + x.visits, 0);

    // Map slot → first matching legal action (for description)
    const slotToAction = new Map<number, Action>();
    for (const la of legal) {
      const sIdx = canonicalActionIndex(la, state);
      if (!slotToAction.has(sIdx)) slotToAction.set(sIdx, la);
    }

    const rows2 = stats.rootActions.map(r => {
      const a = slotToAction.get(r.slotIdx);
      const desc = a ? describeAction(state, a) : `slot=${r.slotIdx}`;
      return { desc, visits: r.visits, prior: r.prior, q: r.q };
    }).sort((a, b) => b.visits - a.visits);

    const top = rows2[0];
    const mcts_pick = top ? top.desc : '(none)';
    const matched = mcts_pick === actualDesc;
    console.log(`  MCTS pick: ${mcts_pick}${matched ? ' ✓ matches actual' : '  ✗ DIFFERENT from actual'}`);
    console.log(`  (${stats.iterations} iters, ${stats.timeMs}ms)`);

    if (rows2.length > 0) {
      console.log(`  rank  visits  pct%   prior%    Q       action`);
      for (let j = 0; j < Math.min(topN, rows2.length); j++) {
        const x = rows2[j]!;
        const pct = totalVisits > 0 ? (x.visits / totalVisits * 100).toFixed(1) : '0.0';
        const pp = (x.prior * 100).toFixed(1);
        const q = isNaN(x.q) ? '  -  ' : x.q.toFixed(3);
        const arrow = x.desc === actualDesc ? '  ← actual' : '';
        console.log(`  ${String(j+1).padStart(3)}.  ${String(x.visits).padStart(5)}  ${pct.padStart(5)}  ${pp.padStart(5)}   ${q}   ${x.desc}${arrow}`);
      }
    }

    probedCount++;
  }

  console.log(`\n=== Probed ${probedCount}/${totalDecisions} decisions ===`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
