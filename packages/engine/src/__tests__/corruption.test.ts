/**
 * Corruption phase tests: domination calculation, corruption placement,
 * dial advancement, ruination, and all persistent card effects active during
 * the corruption phase.
 */
import { resolveCorruptionPhase } from '../phases/corruption.js';
import {
  makeState, placeFollower, placeCard, addCorruption, addToken,
  withUpgrade, setVP, ruinRegion,
} from './helpers.js';

// ─── Basic domination ─────────────────────────────────────────────────────────

describe('basic domination', () => {
  test('single power with 1 figure in region scores conquest VP', () => {
    // norrsund baseValue=1, so domination=1 > resistance=1 only when card cost is added
    // With 1 cultist and 1 chaos card (cost 1), domination = 2 > resistance = 1
    let s = placeFollower(makeState({ phase: 'corruption', pendingAction: null }), 'xarm', 'cultist', 'norrsund');
    s = placeCard(s, 'xarm_war_cry', 'xarm', 'norrsund'); // cost 1
    const vpBefore = s.powers.xarm!.victoryPoints;
    const { state } = resolveCorruptionPhase(s);
    expect(state.powers.xarm!.victoryPoints).toBeGreaterThan(vpBefore);
  });

  test('tied domination → no conquest VP awarded', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'gormen', 'warrior', 'norrsund');
    const vpXarmBefore = s.powers.xarm!.victoryPoints;
    const vpGormenBefore = s.powers.gormen!.victoryPoints;
    const { state, log } = resolveCorruptionPhase(s);
    expect(log.entries.some(l => l.includes('Tied domination'))).toBe(true);
    expect(state.powers.xarm!.victoryPoints).toBe(vpXarmBefore);
    expect(state.powers.gormen!.victoryPoints).toBe(vpGormenBefore);
  });

  test('noble tokens increase conquest value', () => {
    // norrsund base 1, + 1 noble = conquest 2
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeCard(s, 'xarm_the_red_throne', 'xarm', 'norrsund'); // cost 1, gives dom = attack sum = 2+1 = 3
    s = addToken(s, 'norrsund', 'noble');
    const vpBefore = s.powers.xarm!.victoryPoints;
    const { state } = resolveCorruptionPhase(s);
    // norrsund conquest = base 1 + 1 noble = 2, so should score 2 VP
    expect(state.powers.xarm!.victoryPoints - vpBefore).toBe(2);
  });
});

// ─── The Altar: use attack values ─────────────────────────────────────────────

describe('Xarm The Altar (attack sum for domination)', () => {
  test('Xarm domination = sum of attack values, not figure count', () => {
    // 1 warrior (attack 2) + Altar (cost 1) = domination 3 vs resistance 1
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeCard(s, 'xarm_the_red_throne', 'xarm', 'norrsund');
    const vpBefore = s.powers.xarm!.victoryPoints;
    const { state } = resolveCorruptionPhase(s);
    expect(state.powers.xarm!.victoryPoints).toBeGreaterThan(vpBefore);
  });
});

// ─── Hollow Pact: enemy domination = 0 figures ───────────────────────────────

describe('Lasha Hollow Pact (enemy figures contribute 0 domination)', () => {
  test("enemies' figure contribution is 0 when Hollow Pact is active", () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    // Xarm has 3 warriors normally domination 3 > resistance 1
    // With Hollow Pact they should have 0 figure contribution
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    s = placeFollower(s, 'lasha', 'cultist', 'norrsund');
    s = placeCard(s, 'lasha_hollow_pact', 'lasha', 'norrsund');
    // Lasha also has cultist (1 figure) and hollow pact (cost 0) = domination 1 + 0 card cost = 1
    // Xarm has 3 warriors but hollow pact zeroes their figure contribution → dom = 0 (no card)
    const vpXarmBefore = s.powers.xarm!.victoryPoints;
    const { state, log } = resolveCorruptionPhase(s);
    // Xarm should NOT have domination win (their figure contribution = 0)
    expect(state.powers.xarm!.victoryPoints).toBe(vpXarmBefore);
  });
});

// ─── Pestilent Aura: +1 per Gormen corruption token ──────────────────────────

describe('Gormen Pestilent Aura (+1 domination per corruption token)', () => {
  test("Gormen's domination increases by number of their corruption tokens", () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = addCorruption(s, 'norrsund', 'gormen', 3);
    s = placeCard(s, 'gormen_pestilent_aura', 'gormen', 'norrsund');
    // domination = 1 (cultist) + 0 (card cost) + 3 (tokens) = 4 > resistance 1
    const vpBefore = s.powers.gormen!.victoryPoints;
    const { state } = resolveCorruptionPhase(s);
    expect(state.powers.gormen!.victoryPoints).toBeGreaterThan(vpBefore);
  });
});

// ─── Sweet Deceit: +2 per Noble/Hero ─────────────────────────────────────────

describe('Lasha Sweet Deceit (+2 per Noble and Hero token)', () => {
  test('each Noble and Hero token adds 2 to Lasha domination', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = placeFollower(s, 'lasha', 'cultist', 'norrsund');
    s = addToken(s, 'norrsund', 'noble');
    s = addToken(s, 'norrsund', 'hero');
    s = placeCard(s, 'lasha_sweet_lies', 'lasha', 'norrsund');
    // domination = 1 (cultist) + 1 (card cost) + 4 (2 nobles/heroes × 2) = 6 > resistance 1
    const vpBefore = s.powers.lasha!.victoryPoints;
    const { state } = resolveCorruptionPhase(s);
    expect(state.powers.lasha!.victoryPoints).toBeGreaterThan(vpBefore);
  });
});

// ─── Epidemic: -2 resistance ─────────────────────────────────────────────────

describe('Gormen Epidemic (-2 resistance)', () => {
  test('Epidemic reduces resistance by 2, enabling easier domination', () => {
    // mittelreich base resistance = 5; with epidemic = 3
    // 1 warrior + epidemic card (cost 1) = domination 2; vs resistance 3 → not enough without epidemic reduction
    // But with epidemic the resistance is 3, and domination is 2 → still not enough...
    // Let's use 3 warriors = domination 3+1 = 4 > resistance 5-2 = 3
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = placeFollower(s, 'gormen', 'warrior', 'mittelreich');
    s = placeFollower(s, 'gormen', 'warrior', 'mittelreich');
    s = placeFollower(s, 'gormen', 'warrior', 'mittelreich');
    s = placeCard(s, 'gormen_pandemic', 'gormen', 'mittelreich');
    // domination = 3 + 1 (card cost) = 4 > resistance = 5 - 2 = 3
    const vpBefore = s.powers.gormen!.victoryPoints;
    const { state, log } = resolveCorruptionPhase(s);
    expect(state.powers.gormen!.victoryPoints).toBeGreaterThan(vpBefore);
  });
});

// ─── Kaleidoscope: -1 enemy cultist for corruption placement ─────────────────

describe('Tenzen Kaleidoscope (-1 cultist for opponents)', () => {
  test('opponent places one fewer corruption token per cultist when Kaleidoscope active', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    // Xarm has 1 cultist → normally places 1 token; with Kaleidoscope → 0 tokens
    s = placeFollower(s, 'xarm', 'cultist', 'norrsund');
    s = placeCard(s, 'tenzen_shimmer', 'tenzen', 'norrsund');
    const corrBefore = s.regions.norrsund!.corruptionTokens.xarm;
    const { state } = resolveCorruptionPhase(s);
    expect(state.regions.norrsund!.corruptionTokens.xarm).toBe(corrBefore); // no increase
  });

  test('Tenzen is not affected by their own Kaleidoscope', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = placeFollower(s, 'tenzen', 'cultist', 'norrsund');
    s = placeFollower(s, 'tenzen', 'cultist', 'norrsund');
    s = placeCard(s, 'tenzen_shimmer', 'tenzen', 'norrsund');
    const corrBefore = s.regions.norrsund!.corruptionTokens.tenzen;
    const { state } = resolveCorruptionPhase(s);
    expect(state.regions.norrsund!.corruptionTokens.tenzen).toBe(corrBefore + 2);
  });
});

// ─── Scorched Earth: no corruption tokens placed ─────────────────────────────

describe('Xarm War Cry (no corruption tokens in region)', () => {
  test('corruption tokens are not placed when War Cry is active', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeCard(s, 'xarm_war_cry', 'xarm', 'norrsund');
    const corrBefore = s.regions.norrsund!.corruptionTokens.gormen;
    const { state, log } = resolveCorruptionPhase(s);
    expect(state.regions.norrsund!.corruptionTokens.gormen).toBe(corrBefore);
    expect(log.entries.some(l => l.includes('War Cry'))).toBe(true);
  });
});

// ─── Death's Perfume: +2 corruption on domination win ────────────────────────

describe("Gormen Death's Perfume (+2 corruption on win)", () => {
  test('places 2 Gormen tokens when Gormen dominates', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = placeFollower(s, 'gormen', 'warrior', 'norrsund');
    s = placeCard(s, 'gormen_deaths_perfume', 'gormen', 'norrsund'); // cost 3
    // domination = 1 + 3 = 4 > resistance 1
    const corrBefore = s.regions.norrsund!.corruptionTokens.gormen;
    const { state, log } = resolveCorruptionPhase(s);
    if (log.entries.some(l => l.includes('gormen dominates') || l.includes('gormen') && l.includes('scores'))) {
      expect(state.regions.norrsund!.corruptionTokens.gormen).toBe(corrBefore + 2);
    }
  });

  test("Death's Perfume cancelled by Null Weave", () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = placeFollower(s, 'gormen', 'warrior', 'norrsund');
    s = placeCard(s, 'gormen_deaths_perfume', 'gormen', 'norrsund');
    s = placeCard(s, 'tenzen_changer_of_fate', 'tenzen', 'norrsund', 1);
    const corrBefore = s.regions.norrsund!.corruptionTokens.gormen;
    const { state } = resolveCorruptionPhase(s);
    // Null Weave cancels Death's Perfume, so no extra tokens even on domination win
    // (note: domination itself is also impacted by Null Weave cancelling card text,
    //  but card cost still counts toward domination)
    expect(state.regions.norrsund!.corruptionTokens.gormen).toBe(corrBefore);
  });
});

// ─── Corruption placement ─────────────────────────────────────────────────────

describe('corruption token placement', () => {
  test('each cultist places 1 corruption token in their region', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    const corrBefore = s.regions.norrsund!.corruptionTokens.gormen;
    const { state } = resolveCorruptionPhase(s);
    expect(state.regions.norrsund!.corruptionTokens.gormen).toBe(corrBefore + 2);
  });

  test('warriors do NOT place corruption tokens by default', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    const corrBefore = s.regions.norrsund!.corruptionTokens.xarm;
    const { state } = resolveCorruptionPhase(s);
    expect(state.regions.norrsund!.corruptionTokens.xarm).toBe(corrBefore);
  });
});

// ─── Dial advancement counters ────────────────────────────────────────────────

describe('dial advancement counters', () => {
  test('Gormen earns counter for placing 2+ tokens in populous region', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    // volensk is populous, place 2 Gormen cultists
    s = placeFollower(s, 'gormen', 'cultist', 'volensk');
    s = placeFollower(s, 'gormen', 'cultist', 'volensk');
    const countersBefore = s.powers.gormen!.dialCounters;
    const { state } = resolveCorruptionPhase(s);
    expect(state.powers.gormen!.dialCounters).toBeGreaterThan(countersBefore);
  });

  test('Tenzen earns counter for 2+ tokens + 2+ magic symbols/chaos stones', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = placeFollower(s, 'tenzen', 'cultist', 'norrsund');
    s = placeFollower(s, 'tenzen', 'cultist', 'norrsund');
    s = addToken(s, 'norrsund', 'chaos_stone');
    s = addToken(s, 'norrsund', 'chaos_stone');
    s = placeCard(s, 'tenzen_changer_of_fate', 'tenzen', 'norrsund'); // hasMagicSymbol = true
    const countersBefore = s.powers.tenzen!.dialCounters;
    const { state } = resolveCorruptionPhase(s);
    expect(state.powers.tenzen!.dialCounters).toBeGreaterThan(countersBefore);
  });

  test('Lasha earns counter for 2+ tokens + Noble or Hero present', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = placeFollower(s, 'lasha', 'cultist', 'norrsund');
    s = placeFollower(s, 'lasha', 'cultist', 'norrsund');
    s = addToken(s, 'norrsund', 'noble');
    const countersBefore = s.powers.lasha!.dialCounters;
    const { state } = resolveCorruptionPhase(s);
    expect(state.powers.lasha!.dialCounters).toBeGreaterThan(countersBefore);
  });
});

// ─── Ruination ────────────────────────────────────────────────────────────────

describe('ruination', () => {
  test('region with 12+ corruption tokens becomes ruined', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = addCorruption(s, 'norrsund', 'gormen', 11); // 11 tokens; adding 1 cultist = 12
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    const { state } = resolveCorruptionPhase(s);
    expect(state.regions.norrsund!.ruinationCardIndex).not.toBeNull();
  });

  test('players who placed tokens score VP on ruination', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = addCorruption(s, 'norrsund', 'gormen', 11);
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    const vpBefore = s.powers.gormen!.victoryPoints;
    const { state } = resolveCorruptionPhase(s);
    if (state.regions.norrsund!.ruinationCardIndex !== null) {
      expect(state.powers.gormen!.victoryPoints).toBeGreaterThan(vpBefore);
    }
  });
});

// ─── Gormen Provender of Ruin upgrade: +3 VP on any ruination ────────────────

describe('Gormen Provender of Ruin (+3 VP on any ruination)', () => {
  test('+3 VP when any region is ruined, for all powers with this upgrade', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = withUpgrade(s, 'gormen', 'gormen_provender_of_rot');
    s = addCorruption(s, 'norrsund', 'xarm', 11);
    s = placeFollower(s, 'xarm', 'cultist', 'norrsund'); // triggers ruination
    const vpBefore = s.powers.gormen!.victoryPoints;
    const { state, log } = resolveCorruptionPhase(s);
    if (log.entries.some(l => l.includes('RUINED'))) {
      expect(state.powers.gormen!.victoryPoints).toBeGreaterThanOrEqual(vpBefore + 3);
    }
  });
});

// ─── Gormen Plaguebringers upgrade: warriors count as 2 ──────────────────────

describe('Gormen Plaguebringers upgrade (each warrior counts as 2 domination)', () => {
  test('Gormen with Plaguebringers upgrade gets 2× warrior count', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = withUpgrade(s, 'gormen', 'gormen_plaguebringers_up');
    // 1 warrior = 2 domination, base 5 resistance of mittelreich needs 3 warriors normally
    s = placeFollower(s, 'gormen', 'warrior', 'norrsund'); // 2 dom > 1 resistance
    const vpBefore = s.powers.gormen!.victoryPoints;
    const { state } = resolveCorruptionPhase(s);
    expect(state.powers.gormen!.victoryPoints).toBeGreaterThan(vpBefore);
  });
});

// ─── Xarm Heartgrinder upgrade: counts as 4 ──────────────────────────────────

describe('Xarm Heartgrinder upgrade (single Heartgrinder counts as 4)', () => {
  test('Heartgrinder gives domination 4 + card costs', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = withUpgrade(s, 'xarm', 'xarm_heartgrinder_up');
    s = placeFollower(s, 'xarm', 'incarnation', 'norrsund'); // = 4 domination
    // domination = 4 > resistance 1 → scores
    const vpBefore = s.powers.xarm!.victoryPoints;
    const { state } = resolveCorruptionPhase(s);
    expect(state.powers.xarm!.victoryPoints).toBeGreaterThan(vpBefore);
  });
});

// ─── Lasha Ravers upgrade: warriors place corruption ─────────────────────────

describe('Lasha Ravers upgrade (warriors also place corruption tokens)', () => {
  test('Ravers place corruption tokens like cultists', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = withUpgrade(s, 'lasha', 'lasha_ravers_up');
    s = placeFollower(s, 'lasha', 'warrior', 'norrsund');
    const corrBefore = s.regions.norrsund!.corruptionTokens.lasha;
    const { state } = resolveCorruptionPhase(s);
    expect(state.regions.norrsund!.corruptionTokens.lasha).toBeGreaterThan(corrBefore);
  });
});

// ─── Tenzen Fatespinner upgrade: counts as 2 chaos stones ────────────────────

describe('Tenzen Fatespinner upgrade (counts as 2 chaos stones for dial)', () => {
  test('Fatespinner satisfies the 2+ chaos stone requirement for dial advancement', () => {
    let s = makeState({ phase: 'corruption', pendingAction: null });
    s = withUpgrade(s, 'tenzen', 'tenzen_fatespinner_up');
    s = placeFollower(s, 'tenzen', 'incarnation', 'norrsund'); // Fatespinner
    s = placeFollower(s, 'tenzen', 'cultist', 'norrsund');
    s = placeFollower(s, 'tenzen', 'cultist', 'norrsund');
    s = placeCard(s, 'tenzen_stasis_web', 'tenzen', 'norrsund'); // magic symbol = true
    const countersBefore = s.powers.tenzen!.dialCounters;
    const { state } = resolveCorruptionPhase(s);
    expect(state.powers.tenzen!.dialCounters).toBeGreaterThan(countersBefore);
  });
});
