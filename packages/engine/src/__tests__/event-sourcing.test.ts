/**
 * Event sourcing integrity test.
 *
 * Plays 50 full games with random actions. At each step, verifies that the
 * engine state matches the state derived by replaying all game events from
 * scratch via applyEvent.
 *
 * Run: npx tsx packages/engine/src/__tests__/event-sourcing.test.ts
 */
import { createInitialState, applyAction, autoAdvance, getLegalActions, enumerateBattleHitStrategies, applyEvent, GameLog } from '../index.js';
import type { GameState, Power, GameEvent } from '../types.js';

const NUM_GAMES = 50;
const MAX_ACTIONS = 500;

// Simple deterministic PRNG (mulberry32)
function makePrng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickRandom<T>(arr: T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)]!;
}

function replayEvents(initialState: GameState, events: GameEvent[]): GameState {
  let s = initialState;
  for (const ev of events) {
    s = applyEvent(s, ev);
  }
  return s;
}

function statesEqual(a: GameState, b: GameState): string | null {
  for (const power of a.activePowers) {
    const pa = a.powers[power]!;
    const pb = b.powers[power]!;

    if (pa.victoryPoints !== pb.victoryPoints)
      return `${power}.victoryPoints: ${pa.victoryPoints} vs ${pb.victoryPoints}`;
    if (pa.powerPoints !== pb.powerPoints)
      return `${power}.powerPoints: ${pa.powerPoints} vs ${pb.powerPoints}`;
    if (pa.basePowerPoints !== pb.basePowerPoints)
      return `${power}.basePowerPoints: ${pa.basePowerPoints} vs ${pb.basePowerPoints}`;
    if (pa.dialPosition !== pb.dialPosition)
      return `${power}.dialPosition: ${pa.dialPosition} vs ${pb.dialPosition}`;
    if (pa.passedSummoning !== pb.passedSummoning)
      return `${power}.passedSummoning: ${pa.passedSummoning} vs ${pb.passedSummoning}`;

    const sortF = (f: typeof pa.followers) => [...f].sort((a, b) => a.id.localeCompare(b.id));
    const fa = sortF(pa.followers);
    const fb = sortF(pb.followers);
    if (fa.length !== fb.length)
      return `${power}.followers.length: ${fa.length} vs ${fb.length}`;
    for (let i = 0; i < fa.length; i++) {
      if (fa[i]!.regionId !== fb[i]!.regionId)
        return `${power}.follower[${fa[i]!.id}].regionId: ${fa[i]!.regionId} vs ${fb[i]!.regionId}`;
      if (fa[i]!.controlledBy !== fb[i]!.controlledBy)
        return `${power}.follower[${fa[i]!.id}].controlledBy: ${fa[i]!.controlledBy} vs ${fb[i]!.controlledBy}`;
      if (fa[i]!.tipped !== fb[i]!.tipped)
        return `${power}.follower[${fa[i]!.id}].tipped: ${fa[i]!.tipped} vs ${fb[i]!.tipped}`;
      if (fa[i]!.protected !== fb[i]!.protected)
        return `${power}.follower[${fa[i]!.id}].protected: ${fa[i]!.protected} vs ${fb[i]!.protected}`;
    }

    // Compare hand contents (sorted — order may differ)
    const ha = [...pa.hand].sort().join(',');
    const hb = [...pb.hand].sort().join(',');
    if (ha !== hb)
      return `${power}.hand: [${ha}] vs [${hb}]`;
    // Compare discard piles (sorted)
    const da = [...pa.discardIds].sort().join(',');
    const db = [...pb.discardIds].sort().join(',');
    if (da !== db)
      return `${power}.discardIds: [${da}] vs [${db}]`;
  }

  for (const rid of Object.keys(a.regions)) {
    const ra = a.regions[rid as import('../types.js').RegionId]!;
    const rb = b.regions[rid as import('../types.js').RegionId]!;

    if (JSON.stringify(ra.corruptionTokens) !== JSON.stringify(rb.corruptionTokens))
      return `region[${rid}].corruptionTokens: ${JSON.stringify(ra.corruptionTokens)} vs ${JSON.stringify(rb.corruptionTokens)}`;
    if (ra.ruinationCardIndex !== rb.ruinationCardIndex)
      return `region[${rid}].ruinationCardIndex: ${ra.ruinationCardIndex} vs ${rb.ruinationCardIndex}`;
    if ([...ra.tokens].sort().join(',') !== [...rb.tokens].sort().join(','))
      return `region[${rid}].tokens: ${[...ra.tokens].sort()} vs ${[...rb.tokens].sort()}`;
    for (let slot = 0; slot < 2; slot++) {
      if ((ra.chaosCards[slot]?.cardId ?? null) !== (rb.chaosCards[slot]?.cardId ?? null))
        return `region[${rid}].chaosCards[${slot}]: ${ra.chaosCards[slot]?.cardId} vs ${rb.chaosCards[slot]?.cardId}`;
    }
  }

  if (a.round !== b.round) return `round: ${a.round} vs ${b.round}`;
  if (a.phase !== b.phase) return `phase: ${a.phase} vs ${b.phase}`;
  if (a.ruinationCardsUsed !== b.ruinationCardsUsed)
    return `ruinationCardsUsed: ${a.ruinationCardsUsed} vs ${b.ruinationCardsUsed}`;
  if (JSON.stringify(a.winners) !== JSON.stringify(b.winners))
    return `winners: ${JSON.stringify(a.winners)} vs ${JSON.stringify(b.winners)}`;

  return null;
}

function runEventSourcingGame(game: number): string | null {
  const seed = game * 1000 + 42;
  const powers: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
  const playerTypes = Object.fromEntries(powers.map(p => [p, 'ai' as const])) as Record<Power, 'ai'>;

  const initialState = createInitialState({ gameId: `test-${game}`, activePowers: powers, playerTypes, seed });
  const { state: startState, log: startLog } = autoAdvance({ state: initialState, log: new GameLog() });
  const rand = makePrng(seed);

  let state = startState;
  const allEvents: GameEvent[] = [...startLog.events];
  let actionCount = 0;

  while (state.winners === null && state.pendingAction !== null && actionCount < MAX_ACTIONS) {
    const { waitingFor } = state.pendingAction;
    const legal = state.pendingAction.actionKind === 'battle_hit_assignment'
      ? enumerateBattleHitStrategies(state, waitingFor)
      : getLegalActions(state, waitingFor);
    if (legal.length === 0) break;

    const action = pickRandom(legal, rand);
    let result;
    try {
      result = autoAdvance(applyAction(state, action));
    } catch (err) {
      continue;
    }
    allEvents.push(...result.log.events);
    state = result.state;
    actionCount++;

    const replayed = replayEvents(initialState, allEvents);
    const diff = statesEqual(state, replayed);
    if (diff) {
      return `game ${game + 1}, action ${actionCount} (${action.kind}): ${diff}`;
    }
  }

  return null;
}

describe('event sourcing integrity', () => {
  for (let game = 0; game < NUM_GAMES; game++) {
    test(`game ${game + 1}: engine state matches event replay`, () => {
      const err = runEventSourcingGame(game);
      expect(err).toBeNull();
    });
  }
});
