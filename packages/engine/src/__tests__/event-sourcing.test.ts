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

/** Stable JSON-stringify with deterministic key ordering. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function powerEqual(power: Power, pa: import('../types.js').PowerState, pb: import('../types.js').PowerState): string | null {
  const scalars: (keyof import('../types.js').PowerState)[] = [
    'playerType', 'victoryPoints', 'powerPoints', 'basePowerPoints',
    'threatValue', 'dialPosition', 'dialCounters', 'claimedPeasants',
    'passedSummoning', 'summoningTurnsTaken',
  ];
  for (const k of scalars) {
    if (pa[k] !== pb[k]) return `${power}.${String(k)}: ${pa[k]} vs ${pb[k]}`;
  }
  // Order-sensitive arrays (deck order matters for draws; hand order observable).
  // Sorted comparison for unordered sets.
  const arrays: { key: keyof import('../types.js').PowerState; sorted: boolean }[] = [
    { key: 'hand', sorted: false },
    { key: 'deckIds', sorted: false },
    { key: 'discardIds', sorted: false },
    { key: 'upgradesInPlay', sorted: true },
    { key: 'availableUpgradeIds', sorted: true },
    { key: 'freeRedeployIds', sorted: true },
    { key: 'dacRegionsThisPhase', sorted: true },
  ];
  for (const { key, sorted } of arrays) {
    const aArr = (pa[key] as string[]).slice();
    const bArr = (pb[key] as string[]).slice();
    if (sorted) { aArr.sort(); bArr.sort(); }
    if (aArr.length !== bArr.length || aArr.some((x, i) => x !== bArr[i]))
      return `${power}.${String(key)}: [${aArr.join(',')}] vs [${bArr.join(',')}]`;
  }
  // Followers — match by id, check every field.
  const idsA = pa.followers.map(f => f.id).slice().sort();
  const idsB = pb.followers.map(f => f.id).slice().sort();
  if (idsA.length !== idsB.length || idsA.some((x, i) => x !== idsB[i]))
    return `${power}.followers ids differ: [${idsA.join(',')}] vs [${idsB.join(',')}]`;
  const byIdA = new Map(pa.followers.map(f => [f.id, f]));
  const byIdB = new Map(pb.followers.map(f => [f.id, f]));
  const fFields: (keyof import('../types.js').FollowerInstance)[] = [
    'power', 'class', 'regionId', 'controlledBy', 'tipped', 'protected', 'warFrenzyHits', 'placedAt',
  ];
  for (const id of idsA) {
    const fa = byIdA.get(id)!;
    const fb = byIdB.get(id)!;
    for (const k of fFields) {
      if (fa[k] !== fb[k]) return `${power}.follower[${id}].${String(k)}: ${fa[k]} vs ${fb[k]}`;
    }
  }
  return null;
}

function regionEqual(rid: string, ra: import('../types.js').RegionState, rb: import('../types.js').RegionState): string | null {
  const scalars: (keyof import('../types.js').RegionState)[] = [
    'regionId', 'baseValue', 'resistance', 'conquestValue', 'populous', 'ruinationCardIndex',
  ];
  for (const k of scalars) {
    if (ra[k] !== rb[k]) return `region[${rid}].${String(k)}: ${ra[k]} vs ${rb[k]}`;
  }
  if (stableStringify(ra.corruptionTokens) !== stableStringify(rb.corruptionTokens))
    return `region[${rid}].corruptionTokens: ${stableStringify(ra.corruptionTokens)} vs ${stableStringify(rb.corruptionTokens)}`;
  // Tokens: positional order matters (some game logic does FIFO removal).
  if (ra.tokens.length !== rb.tokens.length || ra.tokens.some((t, i) => t !== rb.tokens[i]))
    return `region[${rid}].tokens: [${ra.tokens.join(',')}] vs [${rb.tokens.join(',')}]`;
  // Card slots: positional. Compare every PlayedCard field.
  for (let slot = 0; slot < 2; slot++) {
    const ca = ra.chaosCards[slot];
    const cb = rb.chaosCards[slot];
    if (!ca && !cb) continue;
    if (!ca || !cb)
      return `region[${rid}].chaosCards[${slot}] presence: ${ca?.cardId ?? 'null'} vs ${cb?.cardId ?? 'null'}`;
    const cFields: (keyof import('../types.js').PlayedCard)[] = ['cardId', 'playedBy', 'slotIndex', 'persistNextRound', 'placedAt'];
    for (const k of cFields) {
      const av = ca[k], bv = cb[k];
      if (av !== bv) return `region[${rid}].chaosCards[${slot}].${String(k)}: ${av} vs ${bv}`;
    }
  }
  return null;
}

function statesEqual(a: GameState, b: GameState): string | null {
  for (const power of a.activePowers) {
    const diff = powerEqual(power, a.powers[power]!, b.powers[power]!);
    if (diff) return diff;
  }
  for (const rid of Object.keys(a.regions)) {
    const diff = regionEqual(
      rid,
      a.regions[rid as import('../types.js').RegionId]!,
      b.regions[rid as import('../types.js').RegionId]!,
    );
    if (diff) return diff;
  }
  if (a.round !== b.round) return `round: ${a.round} vs ${b.round}`;
  if (a.phase !== b.phase) return `phase: ${a.phase} vs ${b.phase}`;
  if (a.ruinationCardsUsed !== b.ruinationCardsUsed)
    return `ruinationCardsUsed: ${a.ruinationCardsUsed} vs ${b.ruinationCardsUsed}`;
  if (stableStringify(a.winners) !== stableStringify(b.winners))
    return `winners: ${stableStringify(a.winners)} vs ${stableStringify(b.winners)}`;
  if (a.winCondition !== b.winCondition) return `winCondition: ${a.winCondition} vs ${b.winCondition}`;
  // Order-sensitive deck.
  if (a.worldDeck.length !== b.worldDeck.length || a.worldDeck.some((c, i) => c !== b.worldDeck[i]))
    return `worldDeck: [${a.worldDeck.join(',')}] vs [${b.worldDeck.join(',')}]`;
  if (stableStringify(a.worldTrack) !== stableStringify(b.worldTrack))
    return `worldTrack: ${stableStringify(a.worldTrack)} vs ${stableStringify(b.worldTrack)}`;
  if (stableStringify(a.tokenSupply) !== stableStringify(b.tokenSupply))
    return `tokenSupply: ${stableStringify(a.tokenSupply)} vs ${stableStringify(b.tokenSupply)}`;
  if (stableStringify(a.pendingAction) !== stableStringify(b.pendingAction))
    return `pendingAction: ${stableStringify(a.pendingAction)} vs ${stableStringify(b.pendingAction)}`;
  if (stableStringify(a.summoningOrder) !== stableStringify(b.summoningOrder))
    return `summoningOrder: ${stableStringify(a.summoningOrder)} vs ${stableStringify(b.summoningOrder)}`;
  if (a.summoningIndex !== b.summoningIndex)
    return `summoningIndex: ${a.summoningIndex} vs ${b.summoningIndex}`;
  if (stableStringify(a.battleState) !== stableStringify(b.battleState))
    return `battleState: ${stableStringify(a.battleState)} vs ${stableStringify(b.battleState)}`;
  if (stableStringify(a.pendingDialRewards) !== stableStringify(b.pendingDialRewards))
    return `pendingDialRewards: ${stableStringify(a.pendingDialRewards)} vs ${stableStringify(b.pendingDialRewards)}`;
  if (a.rngSeed !== b.rngSeed) return `rngSeed: ${a.rngSeed} vs ${b.rngSeed}`;
  if (a.actionCount !== b.actionCount) return `actionCount: ${a.actionCount} vs ${b.actionCount}`;
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

// Run as a script: `npx tsx packages/engine/src/__tests__/event-sourcing.test.ts`
// or via `pnpm test`. Exits 1 on first divergence.
let firstFail: string | null = null;
let passed = 0;
for (let game = 0; game < NUM_GAMES; game++) {
  const err = runEventSourcingGame(game);
  if (err) {
    if (!firstFail) firstFail = err;
    console.error(`FAIL: ${err}`);
  } else {
    passed++;
  }
}
console.log(`\n${passed}/${NUM_GAMES} games passed`);
if (firstFail) (globalThis as unknown as { process: { exit: (n: number) => void } }).process.exit(1);
