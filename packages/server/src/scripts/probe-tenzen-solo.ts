/**
 * Probe Tenzen's round-1 behavior when other powers immediately pass.
 *
 * Tenzen plays via MCTS for every decision. The other three powers
 * auto-pass during summoning and pick the first legal action otherwise.
 * Stops once round 1 ends (round becomes 2) or game completes.
 *
 * Usage: pnpm tsx packages/server/src/scripts/probe-tenzen-solo.ts [--seed N] [--iter N]
 */

import {
  createInitialState, applyAction, autoAdvance, getLegalActions,
  enumerateBattleHitStrategies, GameLog,
} from '@ruin/engine';
import type { Power, Action, GameState } from '@ruin/engine';
import { runMcts, probeMctsSearch, canonicalActionIndex } from '@ruin/ai';
import { loadLearnedModelIfPresent } from './load-model.js';

function getArg(flag: string, def: string): string {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] ? a[i + 1]! : def;
}

const seed = parseInt(getArg('--seed', String(Date.now() & 0xffffffff)), 10);
const iters = parseInt(getArg('--iter', '3000'), 10);

loadLearnedModelIfPresent();

const activePowers: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
const playerTypes = Object.fromEntries(activePowers.map(p => [p, 'ai'])) as Record<Power, 'ai'>;

let { state, log } = autoAdvance({
  state: createInitialState({ gameId: 'tenzen-solo', activePowers, playerTypes, seed }),
  log: new GameLog(),
});

console.log(`\n=== Tenzen-solo probe ===  seed=${seed}  iter=${iters}`);
for (const l of log.entries) console.log(l);

// Scripted summoning moves. Pop the next one when that power's turn arrives.
// After the queue is exhausted, the power passes.
const scripted: Record<Power, Action[]> = {
  xarm: [
    { kind: 'summoning_summon_figure', power: 'xarm', followerId: 'xarm_incarnation_1', toRegion: 'mittelreich' },
  ],
  gormen: [
    { kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_warrior_1', toRegion: 'normagne' },
  ],
  tenzen: [],
  lasha: [],
};

function pickNonTenzenAction(s: GameState, waitingFor: Power, kind: string, legal: Action[]): Action {
  if (kind === 'summoning_action') {
    const queued = scripted[waitingFor].shift();
    if (queued) {
      const match = legal.find(a => {
        if (a.kind !== queued.kind) return false;
        if (a.kind === 'summoning_summon_figure' && queued.kind === 'summoning_summon_figure') {
          return a.followerId === queued.followerId && a.toRegion === queued.toRegion;
        }
        if (a.kind === 'summoning_play_card' && queued.kind === 'summoning_play_card') {
          return a.cardId === queued.cardId && a.toRegion === queued.toRegion;
        }
        return true;
      });
      if (match) return match;
      console.error(`scripted action not legal for ${waitingFor}:`, queued);
      console.error(`  sample legal:`, legal.slice(0, 5).map(a => a.kind + (a.kind === 'summoning_summon_figure' ? `(${a.followerId}@${a.toRegion})` : '')).join(', '));
      const pass = legal.find(a => a.kind === 'summoning_pass');
      if (pass) return pass;
    }
    const pass = legal.find(a => a.kind === 'summoning_pass');
    if (pass) return pass;
  }
  return legal[0]!;
}

function describeTenzen(s: GameState): string {
  const t = s.powers.tenzen;
  const board = t.followers.filter(f => f.regionId).map(f => `${f.class}@${f.regionId}`).join(', ') || '(none)';
  return `PP=${t.powerPoints}/${t.basePowerPoints} hand=[${t.hand.join(',')}] board=${board}`;
}

const startRound = state.round;
let safety = 0;
while (state.winners === null && state.phase !== 'completed' && state.round === startRound) {
  if (++safety > 500) { console.error('safety break'); break; }
  const pending = state.pendingAction;
  if (!pending) break;

  const { waitingFor, actionKind } = pending;
  let legal: Action[];
  try {
    legal = actionKind === 'battle_hit_assignment'
      ? enumerateBattleHitStrategies(state, waitingFor)
      : getLegalActions(state, waitingFor);
  } catch (err) {
    console.error(`legal lookup threw for ${waitingFor}/${actionKind}:`, err);
    break;
  }
  if (legal.length === 0) {
    console.error(`no legal actions for ${waitingFor}/${actionKind}`);
    break;
  }

  let action: Action;
  if (waitingFor === 'tenzen') {
    const tenzenOnBoard = state.powers.tenzen.followers.filter(f => f.regionId !== null).length;
    const tenzenAtFullPP = state.powers.tenzen.powerPoints === state.powers.tenzen.basePowerPoints;
    const probeChanger = actionKind === 'summoning_action' && tenzenAtFullPP && tenzenOnBoard === 0;
    if (actionKind === 'summoning_action') {
      console.log(`\n--- Tenzen summoning decision ---`);
      console.log(`  ${describeTenzen(state)}`);
      console.log(`  ${legal.length} legal actions`);
    }
    if (probeChanger) {
      console.log(`\n=== PROBE: first Tenzen summoning decision ===`);
      console.log(`Region tokens (and figures):`);
      for (const [rid, region] of Object.entries(state.regions)) {
        const toks = region.tokens.length > 0 ? region.tokens.join(',') : '(empty)';
        const figs: string[] = [];
        for (const p of state.activePowers) {
          for (const f of state.powers[p].followers) {
            if (f.regionId === rid) figs.push(`${p}.${f.class}`);
          }
        }
        const figStr = figs.length > 0 ? `  figures=[${figs.join(',')}]` : '';
        console.log(`  ${rid.padEnd(13)} tokens=[${toks}]${figStr}`);
      }
      console.log();
      const stats = probeMctsSearch(state, 'tenzen', { iterations: iters });
      const sorted = [...stats.rootActions].sort((a, b) => b.visits - a.visits);
      const totalVisits = sorted.reduce((acc, x) => acc + x.visits, 0);
      console.log(`MCTS: ${stats.iterations} iters, ${stats.timeMs}ms, root=${stats.rootLegalActions} actions`);
      console.log(`Top 15 by visits (chosen: ${stats.topVisitKind}, top prior: ${stats.topPriorKind}):`);
      console.log('rank  visits  pct%   prior%   actionKind            slotIdx');
      for (let i = 0; i < Math.min(15, sorted.length); i++) {
        const a = sorted[i]!;
        const pct = totalVisits > 0 ? (a.visits / totalVisits * 100).toFixed(1) : '0.0';
        const pp = (a.prior * 100).toFixed(1);
        console.log(`${String(i+1).padStart(3)}.  ${String(a.visits).padStart(5)}  ${pct.padStart(5)}  ${pp.padStart(5)}   ${a.actionKind.padEnd(20)}  ${a.slotIdx}`);
      }
      // Map every legal action to its canonical slot, then merge with MCTS stats
      console.log(`\nLegal actions by canonical slot, with MCTS visits/prior:`);
      const slotToAction = new Map<number, Action[]>();
      for (const la of legal) {
        const sIdx = canonicalActionIndex(la, state);
        if (!slotToAction.has(sIdx)) slotToAction.set(sIdx, []);
        slotToAction.get(sIdx)!.push(la);
      }
      const rows: { desc: string; visits: number; prior: number; q: number }[] = [];
      for (const r of stats.rootActions) {
        const acts = slotToAction.get(r.slotIdx) ?? [];
        for (const a of acts) {
          let desc: string;
          if (a.kind === 'summoning_play_card') {
            desc = `play ${(a as any).cardId} → ${(a as any).toRegion}`;
          } else if (a.kind === 'summoning_summon_figure') {
            const fid = (a as any).followerId;
            const cls = state.powers.tenzen.followers.find(f => f.id === fid)?.class ?? '?';
            desc = `summon ${cls} → ${(a as any).toRegion}`;
          } else {
            desc = a.kind;
          }
          rows.push({ desc, visits: r.visits, prior: r.prior, q: r.q });
        }
      }
      rows.sort((a, b) => b.visits - a.visits);
      console.log('rank  visits  pct%   prior%    Q       action');
      for (let i = 0; i < Math.min(20, rows.length); i++) {
        const r = rows[i]!;
        const pct = totalVisits > 0 ? (r.visits / totalVisits * 100).toFixed(1) : '0.0';
        const pp = (r.prior * 100).toFixed(1);
        const q = isNaN(r.q) ? '  -  ' : r.q.toFixed(3);
        console.log(`${String(i+1).padStart(3)}.  ${String(r.visits).padStart(5)}  ${pct.padStart(5)}  ${pp.padStart(5)}   ${q}   ${r.desc}`);
      }
      // Per-region summary for cultist summons
      const regionStats = new Map<string, { visits: number; q: number; prior: number }>();
      for (const r of rows.filter(x => x.desc.startsWith('summon cultist → '))) {
        const region = r.desc.replace('summon cultist → ', '');
        const cur = regionStats.get(region);
        if (!cur) {
          regionStats.set(region, { visits: r.visits, q: r.q, prior: r.prior });
        } else {
          // multiple followers map to one slot — same root data, dedupe
          if (cur.visits !== r.visits) {
            // genuinely different children — sum visits, weighted Q
            const totV = cur.visits + r.visits;
            cur.q = isNaN(cur.q) || isNaN(r.q) ? r.q : (cur.q * cur.visits + r.q * r.visits) / totV;
            cur.visits = totV;
            cur.prior = cur.prior + r.prior;
          }
        }
      }
      console.log(`\nCultist summons by region (sorted by Q):`);
      const sortedRegions = [...regionStats.entries()].sort((a, b) => (b[1].q || 0) - (a[1].q || 0));
      for (const [region, s] of sortedRegions) {
        const stoneMark = state.regions[region as keyof typeof state.regions]?.tokens.includes('chaos_stone') ? ' [CS]' : '';
        const pct = totalVisits > 0 ? (s.visits / totalVisits * 100).toFixed(1) : '0.0';
        const pp = (s.prior * 100).toFixed(1);
        const q = isNaN(s.q) ? '  -  ' : s.q.toFixed(3);
        console.log(`  ${region.padEnd(13)}${stoneMark.padEnd(6)} visits=${String(s.visits).padStart(4)} (${pct}%)  prior=${pp}%  Q=${q}`);
      }
      console.log(`=== END PROBE ===\n`);
      action = stats.action;
    } else {
      action = runMcts(state, 'tenzen', { iterations: iters });
    }
    if (actionKind === 'summoning_action') {
      const desc = action.kind === 'summoning_summon_figure'
        ? `summon ${state.powers.tenzen.followers.find(f => f.id === (action as any).followerId)?.class} → ${(action as any).toRegion}`
        : action.kind === 'summoning_play_card'
          ? `play ${(action as any).cardId} → ${(action as any).toRegion}`
          : action.kind;
      console.log(`  >>> ${desc}`);
    } else {
      console.log(`[tenzen ${actionKind}] -> ${action.kind}`);
    }
  } else {
    action = pickNonTenzenAction(state, waitingFor, actionKind, legal);
    if (actionKind === 'summoning_action') {
      // Quiet — other powers always pass
    } else {
      console.log(`[${waitingFor} ${actionKind}] -> ${action.kind} (auto)`);
    }
  }

  const result = applyAction(state, action);
  for (const l of result.log.entries) console.log(l);
  state = result.state;
}

console.log(`\n=== End of round ${startRound} ===`);
const t = state.powers.tenzen;
console.log(`Tenzen: VP=${t.victoryPoints} threat=${t.threatValue} dial=${t.dialPosition} dac=${t.dialCounters} board=${t.followers.filter(f => f.regionId).map(f => `${f.class}@${f.regionId}`).join(', ') || '(none)'}`);
console.log(`Cards in play (Tenzen): ${Object.entries(state.regions).map(([rid, r]) => r.chaosCards.filter(c => c?.playedBy === 'tenzen').map(c => `${c!.cardId}@${rid}`).join(',')).filter(Boolean).join(' | ') || '(none)'}`);
