/**
 * Pull the N most recent completed games where the target power won, replay
 * each from event log, and emit training samples at every summoning_action.
 * Output is jsonl in the same shape as collect-data.ts produces — usable as
 * demonstration data for warm-starting the value head past its self-play
 * plateau.
 *
 * Usage:
 *   pnpm tsx packages/server/src/scripts/extract-demo-data.ts \
 *     --power tenzen --games 5 --out /tmp/demos.jsonl
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { db } from '../db/client.js';
import { gameEvents, games, gamePlayers } from '../db/schema.js';
import { eq, asc, desc } from 'drizzle-orm';
import {
  applyEvent, createInitialState, GameLog,
  type GameState, type GameEvent, type Power, type PlayerType,
} from '@ruin/engine';
import { extractFeatures, POWERS, powerIndex } from '@ruin/ai';

function getArg(flag: string, def = ''): string {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] ? a[i + 1]! : def;
}

const targetPower = getArg('--power', 'tenzen') as Power;
const gameCount = parseInt(getArg('--games', '5'), 10);
const outPath = getArg('--out', `/tmp/demos_${targetPower}.jsonl`);
const VP_TARGET = 50;

function computeRankTarget(state: GameState, winners: Power[] | null): number[] {
  // Mirrors collect-data.ts:computeRankTarget — same shape so the demo data
  // joins seamlessly with self-play training. Tenzen slot is overridden with
  // VP/50 (continuous signal); other slots use linear rank-decay.
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
  // Override tenzen with VP/50.
  const tenzenIdx = POWERS.indexOf('tenzen');
  if (tenzenIdx >= 0) {
    target[tenzenIdx] = Math.min(state.powers['tenzen'].victoryPoints / VP_TARGET, 1.0);
  }
  return target;
}

interface Sample {
  x: number[];
  p: number;
}

async function main() {
  // Find candidate games: most-recent completed first.
  const candidateRows = await db.select({ id: games.id, state: games.state, updatedAt: games.updatedAt })
    .from(games)
    .where(eq(games.isComplete, true))
    .orderBy(desc(games.updatedAt))
    .limit(50);

  const matches: { id: string; state: GameState }[] = [];
  for (const r of candidateRows) {
    const s = r.state as GameState;
    if (s.winners && s.winners.includes(targetPower)) {
      matches.push({ id: r.id, state: s });
      if (matches.length >= gameCount) break;
    }
  }

  if (matches.length === 0) {
    console.error(`No completed games found where ${targetPower} won.`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = fs.openSync(outPath, 'w');
  let totalSamples = 0;

  for (const m of matches) {
    const playerRows = await db.select().from(gamePlayers).where(eq(gamePlayers.gameId, m.id));
    const activePowers = m.state.activePowers as Power[];
    const playerTypes = Object.fromEntries(
      activePowers.map(p => {
        const row = playerRows.find(r => r.power === p);
        return [p, (row?.playerType ?? 'ai') as PlayerType];
      }),
    ) as Record<Power, PlayerType>;

    const eventRows = await db.select({ seq: gameEvents.seq, event: gameEvents.event })
      .from(gameEvents).where(eq(gameEvents.gameId, m.id)).orderBy(asc(gameEvents.seq));
    if (eventRows.length === 0) {
      console.warn(`game ${m.id}: no events, skipping`);
      continue;
    }

    let state: GameState = createInitialState({
      gameId: m.id, activePowers, playerTypes, seed: m.state.rngSeed,
    });
    const samples: Sample[] = [];

    for (const r of eventRows) {
      const ev = r.event as GameEvent;
      // Sample at the moment a power is being asked for a summoning_action,
      // matching collect-data.ts exactly. We detect this by inspecting the
      // pending action AFTER applying the event (the event preceding the
      // decision sets up pendingAction).
      if (state.pendingAction?.actionKind === 'summoning_action') {
        const waiter = state.pendingAction.waitingFor;
        samples.push({
          x: Array.from(extractFeatures(state, waiter)),
          p: powerIndex(waiter),
        });
      }
      try {
        state = applyEvent(state, ev);
      } catch (err) {
        console.error(`game ${m.id} seq ${r.seq}: applyEvent threw — stopping`, err);
        break;
      }
    }

    const target = computeRankTarget(state, state.winners);
    for (const s of samples) {
      fs.writeSync(out, JSON.stringify({ x: s.x, t: target, p: s.p }) + '\n');
    }
    totalSamples += samples.length;
    const tVP = state.powers[targetPower].victoryPoints;
    console.log(`  ${m.id}: ${state.winners?.join('+') ?? '-'} | ${targetPower} ${tVP}VP | ${samples.length} samples`);
  }

  fs.closeSync(out);
  console.log(`\nWrote ${totalSamples} samples → ${outPath}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
