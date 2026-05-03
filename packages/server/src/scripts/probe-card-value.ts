/**
 * Probe the value head's opinion on states BEFORE and AFTER playing a
 * 0-cost tenzen card, rolling out to the end of the current round in each
 * case before calling the value head. This matches MCTS's actual leaf
 * evaluation — it's what determines whether MCTS judges a card play as
 * "good" or "bad."
 *
 * For each scenario:
 *   1. Build state S where tenzen can play the card
 *   2. Rollout S to round-change N times, average value head → v_before
 *   3. Apply the card play → S'
 *   4. Rollout S' to round-change N times, average value head → v_after
 *   5. Report delta = v_after - v_before
 *
 * Usage: pnpm tsx packages/server/src/scripts/probe-card-value.ts
 */

import {
  createInitialState, applyAction, autoAdvance, GameLog, getLegalActions,
  sampleLegalSummoningAction, enumerateBattleHitStrategies, makeRng,
} from '@ruin/engine';
import { evaluateState } from '@ruin/ai';
import type { Action } from '@ruin/engine';
import type { GameState, Power, RegionId } from '@ruin/engine';
import { loadLearnedModelIfPresent } from './load-model.js';

loadLearnedModelIfPresent();

const POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

function makeTestState(seed = 42): GameState {
  const initial = createInitialState({
    gameId: 'probe-card',
    activePowers: POWERS,
    playerTypes: { xarm: 'ai', gormen: 'ai', tenzen: 'ai', lasha: 'ai' },
    seed,
  });
  const { state } = autoAdvance({ state: initial, log: new GameLog() });
  return state;
}

function placeFigure(state: GameState, power: Power, cls: 'cultist' | 'warrior' | 'incarnation', regionId: RegionId): GameState {
  const ps = state.powers[power]!;
  const fig = ps.followers.find(f => f.regionId === null && f.class === cls);
  if (!fig) throw new Error(`No reserve ${cls} for ${power}`);
  return {
    ...state,
    powers: { ...state.powers, [power]: { ...ps, followers: ps.followers.map(f => f.id === fig.id ? { ...f, regionId } : f) } },
  };
}

function giveCard(state: GameState, power: Power, cardId: string): GameState {
  const ps = state.powers[power]!;
  return {
    ...state,
    powers: { ...state.powers, [power]: { ...ps, hand: [...ps.hand, cardId] } },
  };
}

function setPP(state: GameState, power: Power, pp: number): GameState {
  const ps = state.powers[power]!;
  return {
    ...state,
    powers: { ...state.powers, [power]: { ...ps, powerPoints: pp } },
  };
}

function forceTenzenSummoningTurn(state: GameState): GameState {
  return {
    ...state,
    phase: 'summoning',
    pendingAction: { actionKind: 'summoning_action', waitingFor: 'tenzen' },
  } as GameState;
}

function setRound(state: GameState, round: number): GameState {
  return { ...state, round };
}

// Rollout until round changes (or hard cap). Uses biased-random action
// selection — same pattern MCTS uses.
const ROLLOUT_AGGRESSION = 1.0;  // never voluntarily pass — match MCTS rollout
const HARD_CAP = 120;

interface RolloutTally {
  tenzenSummons: number;
  tenzenCardPlays: Record<string, number>;
  tenzenPasses: number;
}

// Greedy-by-own-value action: evaluate each legal summoning action from the
// ACTING power's own viewpoint, pick argmax. Extremely expensive but matches
// a "smart opponent" baseline for diagnostic purposes.
function greedySummoningAction(state: GameState, power: Power): Action | undefined {
  const legal = getLegalActions(state, power);
  if (legal.length === 0) return undefined;
  let bestScore = -Infinity;
  let best: Action | undefined;
  for (const a of legal) {
    let result;
    try { result = applyAction(state, a); } catch { continue; }
    const val = evaluateState(result.state, power);
    if (val > bestScore) { bestScore = val; best = a; }
  }
  return best;
}

type SmartMode = 'none' | 'opps' | 'tenzen' | 'all';

function rolloutToRoundEnd(
  state: GameState,
  seed: number,
  tally?: RolloutTally,
  smart: SmartMode = 'none',
): GameState {
  const rng = makeRng(seed);
  let current = state;
  let depth = 0;
  const startRound = state.round;

  while (depth < HARD_CAP) {
    if (current.winners !== null || current.phase === 'completed') break;
    if (current.round !== startRound) break;
    if (current.pendingAction === null) {
      const r = autoAdvance({ state: current, log: new GameLog() });
      current = r.state;
      continue;
    }

    const waitingFor = current.pendingAction.waitingFor;
    let action;
    if (current.pendingAction.actionKind === 'summoning_action') {
      const isTenzen = waitingFor === 'tenzen';
      const useSmart =
        (smart === 'all') ||
        (smart === 'opps' && !isTenzen) ||
        (smart === 'tenzen' && isTenzen);
      if (useSmart) {
        action = greedySummoningAction(current, waitingFor);
        if (!action) action = sampleLegalSummoningAction(current, waitingFor, rng, ROLLOUT_AGGRESSION);
      } else {
        action = sampleLegalSummoningAction(current, waitingFor, rng, ROLLOUT_AGGRESSION);
      }
    } else {
      const actions = current.pendingAction.actionKind === 'battle_hit_assignment'
        ? enumerateBattleHitStrategies(current, waitingFor)
        : getLegalActions(current, waitingFor);
      if (actions.length === 0) break;
      action = actions[Math.floor(rng() * actions.length)];
    }
    if (!action) break;

    // Tally tenzen's summoning-phase actions if requested
    if (tally && waitingFor === 'tenzen' && current.pendingAction.actionKind === 'summoning_action') {
      if (action.kind === 'summoning_summon_figure') tally.tenzenSummons++;
      else if (action.kind === 'summoning_play_card') {
        const cid = (action as { cardId: string }).cardId;
        tally.tenzenCardPlays[cid] = (tally.tenzenCardPlays[cid] ?? 0) + 1;
      } else if (action.kind === 'summoning_pass') tally.tenzenPasses++;
    }

    try {
      const r = applyAction(current, action);
      current = r.state;
    } catch { break; }
    depth += 1;
  }
  return current;
}

function avgRolloutValue(state: GameState, power: Power, reps: number, baseSeed: number): number {
  let sum = 0;
  for (let i = 0; i < reps; i++) {
    const end = rolloutToRoundEnd(state, baseSeed + i * 7919);
    sum += evaluateState(end, power);
  }
  return sum / reps;
}

function avgEndOfRoundStats(
  state: GameState, power: Power, reps: number, baseSeed: number,
  smart: SmartMode = 'none',
): { value: number; figures: number; pp: number; vp: number } {
  let vSum = 0, fSum = 0, ppSum = 0, vpSum = 0;
  for (let i = 0; i < reps; i++) {
    // Vary the engine RNG seed per rep so battle dice / card shuffles differ
    // across reps even when action selection is deterministic (greedy).
    const perRepState: GameState = { ...state, rngSeed: state.rngSeed + i * 12347 };
    const end = rolloutToRoundEnd(perRepState, baseSeed + i * 7919, undefined, smart);
    vSum += evaluateState(end, power);
    const ps = end.powers[power]!;
    fSum += ps.followers.filter(f => f.regionId !== null && !f.tipped).length;
    ppSum += ps.powerPoints;
    vpSum += ps.victoryPoints;
  }
  return {
    value: vSum / reps, figures: fSum / reps, pp: ppSum / reps, vp: vpSum / reps,
  };
}

async function runScenario(
  label: string,
  buildState: () => GameState,
  cardId: string,
  region: RegionId,
  reps = 40,
): Promise<void> {
  console.log(`\n=== ${label} ===`);
  const before = buildState();
  console.log(`  setup: tenzen PP=${before.powers['tenzen']!.powerPoints}, round ${before.round}`);

  const vBefore = avgRolloutValue(before, 'tenzen', reps, 1);
  console.log(`  BEFORE card play — avg tenzen-viewpoint value after rollout to round-end: ${vBefore.toFixed(4)}`);

  // Find and apply the card play
  const legal = getLegalActions(before, 'tenzen');
  const cardAction = legal.find(a => a.kind === 'summoning_play_card' && a.cardId === cardId && a.toRegion === region);
  if (!cardAction) {
    console.log(`  ! no legal ${cardId} in ${region}`);
    return;
  }
  let after: GameState;
  try {
    const r = applyAction(before, cardAction);
    after = r.state;
  } catch (e) {
    console.log(`  ! applyAction threw: ${(e as Error).message}`);
    return;
  }

  // Handle any pending on_play choice (e.g., Fate Shield picks a figure)
  while (after.pendingAction && after.pendingAction.actionKind !== 'summoning_action') {
    const pl = getLegalActions(after, after.pendingAction.waitingFor);
    if (pl.length === 0) break;
    try { after = applyAction(after, pl[0]!).state; } catch { break; }
  }

  const vAfter = avgRolloutValue(after, 'tenzen', reps, 1);
  console.log(`  AFTER  card play — avg tenzen-viewpoint value after rollout to round-end: ${vAfter.toFixed(4)}`);
  const delta = vAfter - vBefore;
  const sign = delta > 0 ? '+' : '';
  const verdict = delta > 0.005 ? 'GOOD' : delta < -0.005 ? 'BAD' : 'NEUTRAL';
  console.log(`  delta: ${sign}${delta.toFixed(4)}   (value head says card is ${verdict} for tenzen)`);
}

async function main() {
  const REPS = 300;

  // Scenarios at round 3 so learned eval is used (we also set
  // TENZEN_EVAL_CUTOFF=0 above).
  await runScenario(
    'Siphon Power — opponents have cultists to drain',
    () => {
      let s = makeTestState(100);
      s = setRound(s, 3);
      s = forceTenzenSummoningTurn(s);
      s = setPP(s, 'tenzen', 3);
      s = giveCard(s, 'tenzen', 'tenzen_siphon_power');
      s = placeFigure(s, 'tenzen', 'cultist', 'mittelreich');
      s = placeFigure(s, 'xarm', 'cultist', 'mittelreich');
      s = placeFigure(s, 'gormen', 'cultist', 'mittelreich');
      s = placeFigure(s, 'lasha', 'cultist', 'mittelreich');
      return s;
    },
    'tenzen_siphon_power',
    'mittelreich',
    REPS,
  );

  await runScenario(
    'Siphon Power — no opponents to drain',
    () => {
      let s = makeTestState(200);
      s = setRound(s, 3);
      s = forceTenzenSummoningTurn(s);
      s = setPP(s, 'tenzen', 3);
      s = giveCard(s, 'tenzen', 'tenzen_siphon_power');
      s = placeFigure(s, 'tenzen', 'cultist', 'almerida');
      return s;
    },
    'tenzen_siphon_power',
    'almerida',
    REPS,
  );

  // Proper comparison: two concrete alternative ACTIONS from the same state —
  // what MCTS actually faces. Play Siphon vs summon a cultist.
  console.log('\n=== Action comparison at round 3, tenzen PP=3, Siphon in hand ===');
  const buildNoOppsSiphon = () => {
    let s = makeTestState(200);
    s = setRound(s, 3);
    s = forceTenzenSummoningTurn(s);
    s = setPP(s, 'tenzen', 3);
    s = giveCard(s, 'tenzen', 'tenzen_siphon_power');
    s = placeFigure(s, 'tenzen', 'cultist', 'almerida');
    return s;
  };
  const before = buildNoOppsSiphon();
  const legal = getLegalActions(before, 'tenzen');
  const siphonAction = legal.find(a => a.kind === 'summoning_play_card' && a.cardId === 'tenzen_siphon_power');
  const cultistSummon = legal.find(
    a => a.kind === 'summoning_summon_figure' && a.followerId.includes('cultist'),
  );

  function resolveToNextTenzenTurn(s: GameState): GameState {
    while (s.pendingAction && s.pendingAction.actionKind !== 'summoning_action') {
      const pl = getLegalActions(s, s.pendingAction.waitingFor);
      if (pl.length === 0) break;
      try { s = applyAction(s, pl[0]!).state; } catch { break; }
    }
    return s;
  }

  const stateIfSiphon = siphonAction ? resolveToNextTenzenTurn(applyAction(before, siphonAction).state) : before;
  const stateIfSummon = cultistSummon ? resolveToNextTenzenTurn(applyAction(before, cultistSummon).state) : before;

  // Null-effect variant: played a card but its effect was neutralized — simulates
  // a pure "burned turn slot, got nothing" action. Isolates the stalling value.
  // We apply Siphon (which puts it in discard and bumps tenzen's PP +1), then
  // subtract the +1 PP to undo the effect.
  const stateIfNullCard = siphonAction ? (() => {
    let s = applyAction(before, siphonAction).state;
    s = setPP(s, 'tenzen', before.powers['tenzen']!.powerPoints);  // undo +1 PP
    return resolveToNextTenzenTurn(s);
  })() : before;
  const stateIfPass = (() => {
    const passAction = legal.find(a => a.kind === 'summoning_pass');
    return passAction ? resolveToNextTenzenTurn(applyAction(before, passAction).state) : before;
  })();

  const statsSiphon = avgEndOfRoundStats(stateIfSiphon, 'tenzen', REPS, 1);
  const statsSummon = avgEndOfRoundStats(stateIfSummon, 'tenzen', REPS, 1);
  const statsPass = avgEndOfRoundStats(stateIfPass, 'tenzen', REPS, 1);

  // Count tenzen's in-rollout action types per scenario. Gives a window
  // into what the rollout actually does after the initial forced action.
  const tallySiphon: RolloutTally = { tenzenSummons: 0, tenzenCardPlays: {}, tenzenPasses: 0 };
  const tallySummon: RolloutTally = { tenzenSummons: 0, tenzenCardPlays: {}, tenzenPasses: 0 };
  for (let i = 0; i < REPS; i++) {
    rolloutToRoundEnd(stateIfSiphon, 1 + i * 7919, tallySiphon);
    rolloutToRoundEnd(stateIfSummon, 1 + i * 7919, tallySummon);
  }
  const avgTally = (t: RolloutTally, extraLabel: string, extraCount: number) => {
    const cardTotal = Object.values(t.tenzenCardPlays).reduce((a, b) => a + b, 0);
    console.log(`  tenzen rollout actions after ${extraLabel} (+${extraCount} from the forced action):`);
    console.log(`    summons/game:  ${(t.tenzenSummons / REPS).toFixed(2)}`);
    console.log(`    card plays/game: ${(cardTotal / REPS).toFixed(2)}`);
    for (const [cid, n] of Object.entries(t.tenzenCardPlays)) {
      console.log(`       ${cid}: ${(n / REPS).toFixed(2)}`);
    }
    console.log(`    passes/game:   ${(t.tenzenPasses / REPS).toFixed(2)}`);
  };
  avgTally(tallySiphon, 'Siphon', 1);
  avgTally(tallySummon, 'summon cultist', 1);

  // Matrix of smart configurations (greedy = pick argmax by own value head).
  const SMART_REPS = Math.min(40, REPS);
  const smartRow = (label: string, s: { figures: number; pp: number; vp: number; value: number }) => {
    console.log(`  ${label.padEnd(28)} figures=${s.figures.toFixed(2)}  PP=${s.pp.toFixed(2)}  VP=${s.vp.toFixed(2)}  value=${s.value.toFixed(4)}`);
  };
  for (const mode of ['none', 'opps', 'tenzen', 'all'] as SmartMode[]) {
    const label = ({none: 'random', opps: 'smart opps, random tenzen', tenzen: 'smart tenzen, random opps', all: 'smart everyone'} as Record<SmartMode, string>)[mode];
    console.log(`\n--- ${label} (${SMART_REPS} reps) ---`);
    const si = avgEndOfRoundStats(stateIfSiphon, 'tenzen', SMART_REPS, 1, mode);
    const sn = avgEndOfRoundStats(stateIfNullCard, 'tenzen', SMART_REPS, 1, mode);
    const su = avgEndOfRoundStats(stateIfSummon, 'tenzen', SMART_REPS, 1, mode);
    smartRow(`  Siphon  →`, si);
    smartRow(`  NULL card →`, sn);
    smartRow(`  summon  →`, su);
    console.log(`  Siphon    - Summon delta: ${((si.value - su.value) > 0 ? '+' : '')}${(si.value - su.value).toFixed(4)}`);
    console.log(`  NULL card - Summon delta: ${((sn.value - su.value) > 0 ? '+' : '')}${(sn.value - su.value).toFixed(4)}   ← pure stalling value`);
  }

  const row = (label: string, s: { figures: number; pp: number; vp: number; value: number }) => {
    console.log(`  ${label.padEnd(24)} figures=${s.figures.toFixed(2)}  PP=${s.pp.toFixed(2)}  VP=${s.vp.toFixed(2)}  value=${s.value.toFixed(4)}`);
  };
  row('play Siphon  →', statsSiphon);
  row('summon cultist →', statsSummon);
  row('pass         →', statsPass);
  console.log(`  Siphon - Summon value delta: ${(statsSiphon.value - statsSummon.value > 0 ? '+' : '')}${(statsSiphon.value - statsSummon.value).toFixed(4)}`);

  await runScenario(
    'Fate Shield — tenzen cultist threatened by xarm warriors',
    () => {
      let s = makeTestState(300);
      s = setRound(s, 3);
      s = forceTenzenSummoningTurn(s);
      s = setPP(s, 'tenzen', 3);
      s = giveCard(s, 'tenzen', 'tenzen_fate_shield');
      s = placeFigure(s, 'tenzen', 'cultist', 'mittelreich');
      s = placeFigure(s, 'xarm', 'warrior', 'mittelreich');
      s = placeFigure(s, 'xarm', 'warrior', 'mittelreich');
      return s;
    },
    'tenzen_fate_shield',
    'mittelreich',
  );

  await runScenario(
    'Changer of Fate — neutral region',
    () => {
      let s = makeTestState(400);
      s = setRound(s, 3);
      s = forceTenzenSummoningTurn(s);
      s = setPP(s, 'tenzen', 3);
      s = giveCard(s, 'tenzen', 'tenzen_changer_of_fate');
      return s;
    },
    'tenzen_changer_of_fate',
    'almerida',
  );

  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
