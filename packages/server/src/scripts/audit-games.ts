/**
 * Play N games with h2h settings and dump a per-game JSONL record of every
 * summoning decision plus the region-level payoffs (domination, corruption,
 * DACs, kills) of each round. Feed to analyze_audit.py to measure wasted
 * actions.
 *
 * Usage:
 *   npx tsx packages/server/src/scripts/audit-games.ts --seed 1000 --games 10 --out /tmp/audit.jsonl
 *     [--iter 1000] [--lineup xarm=path,gormen=path,...]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createInitialState, applyAction, autoAdvance, GameLog,
  type GameState, type Action, type Power, type GameEvent,
} from '@ruin/engine';
import { CARD_BY_ID } from '@ruin/engine';
import { runMcts, greedyAction, loadModelForPower, type ModelJson } from '@ruin/ai';

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
}
const baseSeed = parseInt(getArg('--seed', '1'), 10);
const games = parseInt(getArg('--games', '1'), 10);
const iters = parseInt(getArg('--iter', '1000'), 10);
const outPath = getArg('--out', '/tmp/audit.jsonl');
const dataDir = path.resolve(getArg('--data-dir', 'packages/ai/data'));
const lineupArg = getArg('--lineup', '');
// Per-power PUCT exploration constant override, e.g. --c gormen=0.7,tenzen=0.7
// Per-power MCTS iteration override, e.g. --iters-power gormen=3000
const itersOverride: Partial<Record<string, number>> = Object.fromEntries(
  getArg('--iters-power', '').split(',').filter(Boolean).map(kv => { const [p, v] = kv.split('='); return [p!, parseInt(v!, 10)]; }),
);
// Per-power node-local Q normalization min span, e.g. --qnorm gormen=0.05
const qnormOverride: Partial<Record<string, number>> = Object.fromEntries(
  getArg('--qnorm', '').split(',').filter(Boolean).map(kv => { const [p, v] = kv.split('='); return [p!, parseFloat(v!)]; }),
);
// Per-power determinized search, e.g. --det gormen=4 (0 = true state)
const detOverride: Partial<Record<string, number>> = Object.fromEntries(
  getArg('--det', '').split(',').filter(Boolean).map(kv => { const [p, v] = kv.split('='); return [p!, parseInt(v!, 10)]; }),
);
const cOverride: Partial<Record<string, number>> = Object.fromEntries(
  getArg('--c', '').split(',').filter(Boolean).map(kv => { const [p, v] = kv.split('='); return [p!, parseFloat(v!)]; }),
);

const ALL: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
const lineup: Record<Power, string> = Object.fromEntries(ALL.map(p => [p, path.join(dataDir, `model_${p}.json`)])) as Record<Power, string>;
for (const kv of lineupArg.split(',').filter(Boolean)) {
  const [p, f] = kv.split('=') as [Power, string];
  lineup[p] = path.resolve(f);
}
for (const p of ALL) loadModelForPower(p, JSON.parse(fs.readFileSync(lineup[p], 'utf-8')) as ModelJson);

const SUB = new Set([
  'battle_hit_assignment', 'tenzen_discard', 'dial_place_token', 'dial_remove_corruption',
  'dial_remove_world_token', 'upgrade_choice', 'world_choice', 'hero_removal',
  'corruption_harvest_choice', 'card_on_play_choice',
]);

interface Act {
  round: number; power: Power; kind: 'summon' | 'card' | 'pass';
  cls?: string; from?: string | null; card?: string; region?: string; pp: number; hand: number;
}

const out = fs.openSync(outPath, 'a');
for (let g = 0; g < games; g++) {
  const seed = baseSeed + g;
  let { state, log } = autoAdvance({
    state: createInitialState({
      gameId: `audit-${seed}`, activePowers: ALL,
      playerTypes: Object.fromEntries(ALL.map(p => [p, 'ai'])) as Record<Power, 'ai'>, seed,
    }),
    log: new GameLog(),
  });
  const acts: Act[] = [];
  const events: Array<{ round: number } & Record<string, unknown>> = [];
  const roundEnd: Array<{ round: number; hand: Record<Power, number>; vp: Record<Power, number>; dial: Record<Power, number> }> = [];
  const keep = new Set(['domination_result', 'corruption_placement', 'dial_counter', 'battle_kill', 'ruination',
    'card_effect', 'war_cry_block', 'deaths_perfume', 'vile_consumption', 'hero_removal', 'ruination_scoring', 'dial_vp']);
  const pushEvents = (evs: GameEvent[], round: number) => {
    for (const e of evs) if (keep.has(e.type)) events.push({ round, ...(e as unknown as Record<string, unknown>) });
  };
  pushEvents(log.events, state.round);
  let n = 0;
  let lastRound = state.round;
  while (state.winners === null && state.phase !== 'completed' && n < 3000) {
    const pending = state.pendingAction;
    if (!pending) break;
    let action: Action;
    if (pending.actionKind === 'summoning_action' || SUB.has(pending.actionKind)) {
      const c = cOverride[pending.waitingFor];
      action = runMcts(state, pending.waitingFor, { iterations: itersOverride[pending.waitingFor] ?? iters, timeMs: 60000, rolloutDepth: -1, ...(c !== undefined ? { explorationC: c } : {}), ...(qnormOverride[pending.waitingFor] ? { normalizeQMinSpan: qnormOverride[pending.waitingFor] } : {}), ...(detOverride[pending.waitingFor] !== undefined ? { determinizations: detOverride[pending.waitingFor] } : {}) });
    } else {
      action = greedyAction(state, pending.waitingFor);
    }
    if (pending.actionKind === 'summoning_action') {
      const ps = state.powers[pending.waitingFor];
      const base = { round: state.round, power: pending.waitingFor, pp: ps.powerPoints, hand: ps.hand.length };
      if (action.kind === 'summoning_summon_figure') {
        const f = ALL.flatMap(q => state.powers[q].followers).find(x => x.id === action.followerId)!;
        acts.push({ ...base, kind: 'summon', cls: f.class, from: f.regionId, region: action.toRegion });
      } else if (action.kind === 'summoning_play_card') {
        acts.push({ ...base, kind: 'card', card: action.cardId, region: action.toRegion });
      } else {
        acts.push({ ...base, kind: 'pass' });
      }
    }
    const res = applyAction(state, action);
    pushEvents(res.log.events, state.round);
    state = res.state;
    if (state.round !== lastRound) {
      roundEnd.push({
        round: lastRound,
        hand: Object.fromEntries(ALL.map(p => [p, state.powers[p].hand.length])) as Record<Power, number>,
        vp: Object.fromEntries(ALL.map(p => [p, state.powers[p].victoryPoints])) as Record<Power, number>,
        dial: Object.fromEntries(ALL.map(p => [p, state.powers[p].dialPosition])) as Record<Power, number>,
      });
      lastRound = state.round;
    }
    n++;
  }
  const rec = {
    seed, winners: state.winners, cond: state.winCondition, rounds: state.round,
    vp: Object.fromEntries(ALL.map(p => [p, state.powers[p].victoryPoints])),
    dial: Object.fromEntries(ALL.map(p => [p, state.powers[p].dialPosition])),
    hand: Object.fromEntries(ALL.map(p => [p, state.powers[p].hand.length])),
    acts, events, roundEnd,
    cardNames: Object.fromEntries([...new Set(acts.filter(a => a.card).map(a => a.card!))].map(c => [c, CARD_BY_ID[c]?.name ?? c])),
  };
  fs.writeSync(out, JSON.stringify(rec) + '\n');
  console.log(`seed ${seed}: ${state.winners?.join(',')} (${state.winCondition}) r${state.round}`);
}
fs.closeSync(out);
