/**
 * Probe the value head's opinion on specific board scenarios.
 * Tests whether the model understands "don't feed Xarm."
 *
 * Usage: pnpm tsx packages/server/src/scripts/probe-value.ts
 */

import { createInitialState, applyAction, autoAdvance, GameLog, getLegalActions } from '@ruin/engine';
import { evaluateState } from '@ruin/ai';
import type { GameState, Power, RegionId } from '@ruin/engine';
import { loadLearnedModelIfPresent } from './load-model.js';

loadLearnedModelIfPresent();

const POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

// Build a mid-game state with specific setup
function makeTestState(): GameState {
  const initial = createInitialState({
    gameId: 'probe',
    activePowers: POWERS,
    playerTypes: { xarm: 'ai', gormen: 'ai', tenzen: 'ai', lasha: 'ai' },
    seed: 42,
  });
  const { state } = autoAdvance({ state: initial, log: new GameLog() });
  return state;
}

function evalAllPowers(state: GameState): Record<Power, number> {
  const result: Record<string, number> = {};
  for (const p of POWERS) {
    result[p] = evaluateState(state, p);
  }
  return result as Record<Power, number>;
}

function placeFigure(state: GameState, power: Power, cls: 'cultist' | 'warrior' | 'incarnation', regionId: RegionId): GameState {
  const ps = state.powers[power]!;
  const fig = ps.followers.find(f => f.regionId === null && f.class === cls);
  if (!fig) throw new Error(`No reserve ${cls} for ${power}`);
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: {
        ...ps,
        followers: ps.followers.map(f =>
          f.id === fig.id ? { ...f, regionId } : f
        ),
      },
    },
  };
}

function removeFigures(state: GameState, power: Power, regionId: RegionId): GameState {
  const ps = state.powers[power]!;
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: {
        ...ps,
        followers: ps.followers.map(f =>
          f.regionId === regionId && f.power === power ? { ...f, regionId: null } : f
        ),
      },
    },
  };
}

// ── Scenario 1: Should Gormen summon cultist into Xarm-controlled Mittelreich? ──

console.log('\n=== Scenario 1: Gormen cultist into Xarm warrior region ===\n');

let s1 = makeTestState();
// Clear Mittelreich
for (const p of POWERS) s1 = removeFigures(s1, p, 'mittelreich');
// Place Xarm warriors
s1 = placeFigure(s1, 'xarm', 'warrior', 'mittelreich');
s1 = placeFigure(s1, 'xarm', 'warrior', 'mittelreich');

const s1_noFeed = s1;
const s1_feed = placeFigure(s1, 'gormen', 'cultist', 'mittelreich');

console.log('Gormen value WITHOUT cultist in Mittelreich:', evalAllPowers(s1_noFeed).gormen.toFixed(4));
console.log('Gormen value WITH cultist in Mittelreich:   ', evalAllPowers(s1_feed).gormen.toFixed(4));
console.log('Delta (positive = feeding is "better"):     ', (evalAllPowers(s1_feed).gormen - evalAllPowers(s1_noFeed).gormen).toFixed(4));

console.log('\nXarm value WITHOUT free target:             ', evalAllPowers(s1_noFeed).xarm.toFixed(4));
console.log('Xarm value WITH free target:                ', evalAllPowers(s1_feed).xarm.toFixed(4));
console.log('Xarm delta:                                 ', (evalAllPowers(s1_feed).xarm - evalAllPowers(s1_noFeed).xarm).toFixed(4));

// ── Scenario 2: Should Tenzen move cultist OUT of Xarm warrior region? ──

console.log('\n=== Scenario 2: Tenzen cultist in Xarm warrior region — stay vs leave ===\n');

let s2 = makeTestState();
for (const p of POWERS) s2 = removeFigures(s2, p, 'mittelreich');
for (const p of POWERS) s2 = removeFigures(s2, p, 'norrsund');
s2 = placeFigure(s2, 'xarm', 'warrior', 'mittelreich');
s2 = placeFigure(s2, 'xarm', 'warrior', 'mittelreich');
s2 = placeFigure(s2, 'tenzen', 'cultist', 'mittelreich');

const s2_stay = s2;
// Move cultist to safe Norrsund
let s2_leave = { ...s2 };
const tzPs = s2_leave.powers['tenzen']!;
const cultist = tzPs.followers.find(f => f.regionId === 'mittelreich' && f.class === 'cultist');
if (cultist) {
  s2_leave = {
    ...s2_leave,
    powers: {
      ...s2_leave.powers,
      tenzen: {
        ...tzPs,
        followers: tzPs.followers.map(f =>
          f.id === cultist.id ? { ...f, regionId: 'norrsund' as RegionId } : f
        ),
      },
    },
  };
}

console.log('Tenzen value STAY in Mittelreich (w/ Xarm): ', evalAllPowers(s2_stay).tenzen.toFixed(4));
console.log('Tenzen value LEAVE to Norrsund:             ', evalAllPowers(s2_leave).tenzen.toFixed(4));
console.log('Delta (positive = leaving is "better"):     ', (evalAllPowers(s2_leave).tenzen - evalAllPowers(s2_stay).tenzen).toFixed(4));

// ── Scenario 3: Safe cultist pile vs Xarm-threatened pile ──

console.log('\n=== Scenario 3: Tenzen 4-cultist pile — safe region vs Xarm-threatened ===\n');

let s3safe = makeTestState();
for (const p of POWERS) s3safe = removeFigures(s3safe, p, 'norrsund');
for (const p of POWERS) s3safe = removeFigures(s3safe, p, 'mittelreich');
for (let i = 0; i < 4; i++) s3safe = placeFigure(s3safe, 'tenzen', 'cultist', 'norrsund');

let s3threat = { ...s3safe };
s3threat = placeFigure(s3threat, 'xarm', 'warrior', 'norrsund');
s3threat = placeFigure(s3threat, 'xarm', 'warrior', 'norrsund');

console.log('Tenzen value with 4 cultists SAFE:          ', evalAllPowers(s3safe).tenzen.toFixed(4));
console.log('Tenzen value with 4 cultists + 2 Xarm war:  ', evalAllPowers(s3threat).tenzen.toFixed(4));
console.log('Delta (negative = threat is understood):     ', (evalAllPowers(s3threat).tenzen - evalAllPowers(s3safe).tenzen).toFixed(4));

console.log('\n');

// ── Scenario 4: Xarm DAC value — with and without a kill target ──

console.log('=== Scenario 4: Xarm value of getting a DAC ===\n');

let s4 = makeTestState();
for (const p of POWERS) s4 = removeFigures(s4, p, 'mittelreich');
s4 = placeFigure(s4, 'xarm', 'warrior', 'mittelreich');

// No DAC counter
const s4_noDac = s4;

// Give Xarm 1 dial counter (simulating a kill happened)
const s4_withDac: GameState = {
  ...s4,
  powers: {
    ...s4.powers,
    xarm: {
      ...s4.powers['xarm']!,
      dialCounters: s4.powers['xarm']!.dialCounters + 1,
    },
  },
};

// Give Xarm 2 dial counters
const s4_twoDac: GameState = {
  ...s4,
  powers: {
    ...s4.powers,
    xarm: {
      ...s4.powers['xarm']!,
      dialCounters: s4.powers['xarm']!.dialCounters + 2,
    },
  },
};

console.log('Xarm value with 0 dial counters: ', evalAllPowers(s4_noDac).xarm.toFixed(4));
console.log('Xarm value with +1 dial counter: ', evalAllPowers(s4_withDac).xarm.toFixed(4));
console.log('Xarm value with +2 dial counters:', evalAllPowers(s4_twoDac).xarm.toFixed(4));
console.log('Delta per counter:               ', ((evalAllPowers(s4_twoDac).xarm - evalAllPowers(s4_noDac).xarm) / 2).toFixed(4));

// Compare: what's the value of 1 VP for xarm?
const s4_plusVP: GameState = {
  ...s4,
  powers: {
    ...s4.powers,
    xarm: {
      ...s4.powers['xarm']!,
      victoryPoints: s4.powers['xarm']!.victoryPoints + 5,
    },
  },
};
console.log('\nXarm value with +5 VP:           ', evalAllPowers(s4_plusVP).xarm.toFixed(4));
console.log('Delta for +5 VP:                 ', (evalAllPowers(s4_plusVP).xarm - evalAllPowers(s4_noDac).xarm).toFixed(4));

// ── Scenario 5: Value of a kill target existing ──

console.log('\n=== Scenario 5: Xarm value — target to kill vs no target ===\n');

const s5_noTarget = s4; // just xarm warrior, no enemies
const s5_withTarget = placeFigure(s4, 'gormen', 'cultist', 'mittelreich');

console.log('Xarm value with NO kill target:  ', evalAllPowers(s5_noTarget).xarm.toFixed(4));
console.log('Xarm value WITH kill target:     ', evalAllPowers(s5_withTarget).xarm.toFixed(4));
console.log('Delta (positive = target is valued):', (evalAllPowers(s5_withTarget).xarm - evalAllPowers(s5_noTarget).xarm).toFixed(4));

// From gormen's perspective
console.log('\nGormen value with NO figure there:', evalAllPowers(s5_noTarget).gormen.toFixed(4));
console.log('Gormen value WITH figure at risk: ', evalAllPowers(s5_withTarget).gormen.toFixed(4));
console.log('Gormen delta:                     ', (evalAllPowers(s5_withTarget).gormen - evalAllPowers(s5_noTarget).gormen).toFixed(4));

console.log('\n');

// ── Scenario 6: Xarm dial position ──

console.log('=== Scenario 6: Xarm value at different dial positions ===\n');

let s6 = makeTestState();
for (const p of POWERS) s6 = removeFigures(s6, p, 'mittelreich');

for (let pos = 0; pos <= 7; pos++) {
  const s: GameState = {
    ...s6,
    powers: {
      ...s6.powers,
      xarm: {
        ...s6.powers['xarm']!,
        dialPosition: pos,
        dialCounters: 0,
      },
    },
  };
  const v = evalAllPowers(s).xarm;
  console.log(`  dial pos ${pos}: ${v.toFixed(4)}`);
}

// Same for Tenzen
console.log('\n=== Scenario 6b: Tenzen value at different dial positions ===\n');

for (let pos = 0; pos <= 7; pos++) {
  const s: GameState = {
    ...s6,
    powers: {
      ...s6.powers,
      tenzen: {
        ...s6.powers['tenzen']!,
        dialPosition: pos,
        dialCounters: 0,
      },
    },
  };
  const v = evalAllPowers(s).tenzen;
  console.log(`  dial pos ${pos}: ${v.toFixed(4)}`);
}

// ── Scenario 7: VP sensitivity per power ──

console.log('\n=== Scenario 7: VP sensitivity per power (0 vs 20 vs 40) ===\n');

for (const power of POWERS) {
  const vals: string[] = [];
  for (const vp of [0, 20, 40]) {
    const s: GameState = {
      ...s6,
      powers: {
        ...s6.powers,
        [power]: {
          ...s6.powers[power]!,
          victoryPoints: vp,
        },
      },
    };
    vals.push(`${vp}vp=${evalAllPowers(s)[power].toFixed(4)}`);
  }
  console.log(`  ${power}: ${vals.join('  ')}`);
}

console.log('\n');

// ── Scenario 8: MCTS evaluation of key positions ──
// Run MCTS from specific positions and see what it picks + the root value

import { runMctsWithStats } from '@ruin/ai';

console.log('=== Scenario 8: MCTS picks from constructed positions ===\n');

// 8a: Gormen summoning — should it go to Mittelreich where Xarm has warriors?
{
  let s = makeTestState();
  for (const p of POWERS) s = removeFigures(s, p, 'mittelreich');
  for (const p of POWERS) s = removeFigures(s, p, 'norrsund');
  s = placeFigure(s, 'xarm', 'warrior', 'mittelreich');
  s = placeFigure(s, 'xarm', 'warrior', 'mittelreich');
  // Gormen's turn to summon
  s = {
    ...s,
    phase: 'summoning' as const,
    pendingAction: { waitingFor: 'gormen' as Power, actionKind: 'summoning_action' as const, context: {} },
  };

  const stats = runMctsWithStats(s, 'gormen');
  const top5 = stats.visitCounts.sort((a, b) => b.visits - a.visits).slice(0, 5);
  console.log('8a: Gormen summoning (Xarm warriors in Mittelreich):');
  for (const { action: a, visits } of top5) {
    const desc = a.kind === 'summoning_summon_figure'
      ? `summon ${a.followerId.replace(/.*_/, '')} → ${a.toRegion}`
      : a.kind === 'summoning_play_card'
      ? `play ${a.cardId} → ${a.toRegion}`
      : a.kind;
    console.log(`  ${visits} visits: ${desc}`);
  }
  const mittelreichVisits = stats.visitCounts
    .filter(v => v.action.kind === 'summoning_summon_figure' && (v.action as any).toRegion === 'mittelreich')
    .reduce((sum, v) => sum + v.visits, 0);
  const totalVisits = stats.visitCounts.reduce((sum, v) => sum + v.visits, 0);
  console.log(`  Mittelreich visits: ${mittelreichVisits}/${totalVisits} (${(mittelreichVisits/totalVisits*100).toFixed(1)}%)`);
}

// 8b: Tenzen summoning — safe region vs Xarm-threatened region
{
  let s = makeTestState();
  for (const p of POWERS) s = removeFigures(s, p, 'mittelreich');
  for (const p of POWERS) s = removeFigures(s, p, 'norrsund');
  s = placeFigure(s, 'xarm', 'warrior', 'mittelreich');
  s = placeFigure(s, 'xarm', 'warrior', 'mittelreich');
  s = {
    ...s,
    phase: 'summoning' as const,
    pendingAction: { waitingFor: 'tenzen' as Power, actionKind: 'summoning_action' as const, context: {} },
  };

  const stats = runMctsWithStats(s, 'tenzen');
  const top5 = stats.visitCounts.sort((a, b) => b.visits - a.visits).slice(0, 5);
  console.log('\n8b: Tenzen summoning (Xarm warriors in Mittelreich):');
  for (const { action: a, visits } of top5) {
    const desc = a.kind === 'summoning_summon_figure'
      ? `summon ${a.followerId.replace(/.*_/, '')} → ${a.toRegion}`
      : a.kind === 'summoning_play_card'
      ? `play ${a.cardId} → ${a.toRegion}`
      : a.kind;
    console.log(`  ${visits} visits: ${desc}`);
  }
  const mittelreichVisits = stats.visitCounts
    .filter(v => v.action.kind === 'summoning_summon_figure' && (v.action as any).toRegion === 'mittelreich')
    .reduce((sum, v) => sum + v.visits, 0);
  const safeVisits = stats.visitCounts
    .filter(v => v.action.kind === 'summoning_summon_figure' && (v.action as any).toRegion === 'norrsund')
    .reduce((sum, v) => sum + v.visits, 0);
  const totalVisits = stats.visitCounts.reduce((sum, v) => sum + v.visits, 0);
  console.log(`  Mittelreich (danger): ${mittelreichVisits}/${totalVisits} (${(mittelreichVisits/totalVisits*100).toFixed(1)}%)`);
  console.log(`  Norrsund (safe):      ${safeVisits}/${totalVisits} (${(safeVisits/totalVisits*100).toFixed(1)}%)`);
}

console.log('\n');
