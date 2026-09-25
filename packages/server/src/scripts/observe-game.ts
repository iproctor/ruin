/**
 * Watch one AI-vs-AI game with h2h settings and print every summoning decision
 * with the MCTS root table, plus a board snapshot before each battle phase and
 * after corruption. For eyeballing play quality.
 *
 * Usage:
 *   npx tsx packages/server/src/scripts/observe-game.ts --seed 7 [--iter 1000] [--top 4] [--ref]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createInitialState, applyAction, autoAdvance, GameLog,
  getPowerDomination, getRegionDomination, getRegionResistance, followersInRegion,
  type GameState, type Action, type Power, type RegionId,
} from '@ruin/engine';
import { CARD_BY_ID, REGION_ORDER } from '@ruin/engine';
import {
  runMcts, runMctsWithStats, greedyAction, loadModelForPower, type ModelJson,
} from '@ruin/ai';

const args = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
}
const seed = parseInt(getArg('--seed', '1'), 10);
const iters = parseInt(getArg('--iter', '1000'), 10);
const top = parseInt(getArg('--top', '4'), 10);
const useRef = args.includes('--ref');
const dataDir = path.resolve(getArg('--data-dir', 'packages/ai/data'));

const ALL: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
for (const p of ALL) {
  const f = useRef ? path.join(dataDir, 'ref', `model_${p}_ref.json`) : path.join(dataDir, `model_${p}.json`);
  loadModelForPower(p, JSON.parse(fs.readFileSync(f, 'utf-8')) as ModelJson);
}

const SUB = new Set([
  'battle_hit_assignment', 'tenzen_discard', 'dial_place_token', 'dial_remove_corruption',
  'dial_remove_world_token', 'upgrade_choice', 'world_choice', 'hero_removal',
  'corruption_harvest_choice', 'card_on_play_choice',
]);

function describe(s: GameState, a: Action): string {
  switch (a.kind) {
    case 'summoning_summon_figure': {
      const f = ALL.flatMap(q => s.powers[q].followers).find(x => x.id === a.followerId)!;
      return `summon ${f.power !== a.power ? f.power + ' ' : ''}${f.class}${f.regionId ? ` (from ${f.regionId})` : ''} → ${a.toRegion}`;
    }
    case 'summoning_play_card':
      return `play ${CARD_BY_ID[a.cardId]?.name ?? a.cardId} → ${a.toRegion}${a.onPlayChoice ? ' ' + JSON.stringify(a.onPlayChoice) : ''}`;
    case 'summoning_pass':
      return 'pass';
    default:
      return JSON.stringify(a);
  }
}

function board(s: GameState): string {
  const lines: string[] = [];
  for (const r of REGION_ORDER as RegionId[]) {
    const reg = s.regions[r];
    if (reg.ruinationCardIndex !== null) { lines.push(`  ${r.padEnd(12)} RUINED`); continue; }
    const parts: string[] = [];
    for (const p of ALL) {
      const figs = followersInRegion(s, r, p);
      const cards = reg.chaosCards.filter(c => c && c.playedBy === p).map(c => CARD_BY_ID[c!.cardId]?.shortName ?? c!.cardId);
      const cor = reg.corruptionTokens[p];
      if (!figs.length && !cards.length && !cor) continue;
      const fstr = figs.map(f => f.class[0]).join('');
      let dom = 0;
      try { dom = getPowerDomination(s, r, p); } catch { /* */ }
      parts.push(`${p.slice(0, 1).toUpperCase()}[${fstr}${cards.length ? ' ' + cards.join(',') : ''}${cor ? ' c' + cor : ''} d${dom}]`);
    }
    let res = reg.resistance;
    try { res = getRegionResistance(s, r); } catch { /* */ }
    const toks = reg.tokens.length ? ` {${reg.tokens.join(',')}}` : '';
    const totalCor = ALL.reduce((a, p) => a + reg.corruptionTokens[p], 0) + reg.tokens.filter(t => t === 'chaos_stone').length;
    const lead = getRegionDomination(s, r);
    lines.push(`  ${r.padEnd(12)} res${res} cv${reg.conquestValue} cor${totalCor}${toks}  ${parts.join(' ')}${lead.leader && lead.value > res ? `  => ${lead.leader} dominates` : ''}`);
  }
  lines.push('  ' + ALL.map(p => `${p}: vp${s.powers[p].victoryPoints} threat${s.powers[p].threatValue} dial${s.powers[p].dialPosition} hand${s.powers[p].hand.length}`).join(' | '));
  return lines.join('\n');
}

let { state, log } = autoAdvance({
  state: createInitialState({
    gameId: `observe-${seed}`,
    activePowers: ALL,
    playerTypes: Object.fromEntries(ALL.map(p => [p, 'ai'])) as Record<Power, 'ai'>,
    seed,
  }),
  log: new GameLog(),
});
for (const l of log.entries) console.log(l);

let lastPhase = state.phase;
let n = 0;
while (state.winners === null && state.phase !== 'completed' && n < 3000) {
  const pending = state.pendingAction;
  if (!pending) break;
  let action: Action;
  if (pending.actionKind === 'summoning_action') {
    const st = runMctsWithStats(state, pending.waitingFor, { iterations: iters, timeMs: 60000, rolloutDepth: -1 });
    action = st.action;
    const tot = st.searchDebugRows.reduce((a, r) => a + r.visits, 0) || 1;
    const rows = [...st.searchDebugRows].sort((a, b) => b.visits - a.visits).slice(0, top);
    const pp = state.powers[pending.waitingFor].powerPoints;
    console.log(`  >> R${state.round} ${pending.waitingFor} pp${pp}: ${describe(state, action)}`);
    for (const r of rows) {
      console.log(`       ${(r.visits / tot * 100).toFixed(0).padStart(3)}% prior ${(r.prior * 100).toFixed(0).padStart(3)}% q ${r.q.toFixed(3)}  ${describe(state, r.action)}`);
    }
  } else if (SUB.has(pending.actionKind)) {
    action = runMcts(state, pending.waitingFor, { iterations: iters, timeMs: 60000, rolloutDepth: -1 });
    if (pending.actionKind !== 'battle_hit_assignment') console.log(`  >> ${pending.waitingFor} ${pending.actionKind}: ${JSON.stringify(action)}`);
  } else {
    action = greedyAction(state, pending.waitingFor);
  }
  const before = state;
  const res = applyAction(state, action);
  state = res.state;
  if (before.phase === 'summoning' && state.phase !== 'summoning') {
    console.log(`\n  ── board after summoning, round ${before.round} ──\n${board(before.phase === 'summoning' ? state : before)}\n`);
  }
  for (const l of res.log.entries) console.log(l);
  if (state.phase !== lastPhase && state.phase === 'end') {
    console.log(`\n  ── board at end phase, round ${state.round} ──\n${board(state)}\n`);
  }
  lastPhase = state.phase;
  n++;
}
console.log(`\nRESULT winners=${state.winners?.join(',')} cond=${state.winCondition} round=${state.round}`);
console.log(board(state));
