/**
 * Extended end-phase tests covering:
 *   - Victory detection at end of resolveEndPhase (dial score_vp triggers ≥50 VP)
 *   - World card persistent effects resolved during end phase
 *   - Dial instructions: place_nobles, place_chaos_stone, remove_corruption,
 *     remove_world_tokens, draw_chaos_cards
 *   - drawOneCard reshuffles from discard when deck is empty
 */
import { resolveEndPhase } from '../phases/end.js';
import {
  makeState, placeFollower, addToken, addCorruption, setVP, setWorldCard,
  giveInDeck, autoResolveEndPhase,
} from './helpers.js';
import { followersInRegion } from '../helpers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Override dialPosition and dialCounters for one power. */
function setDial(
  state: ReturnType<typeof makeState>,
  power: 'xarm' | 'gormen' | 'tenzen' | 'lasha',
  dialPosition: number,
  dialCounters: number,
): ReturnType<typeof makeState> {
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: { ...state.powers[power]!, dialPosition, dialCounters },
    },
  };
}

/** Convenience: make a minimal end-phase state. */
function endState(overrides: Partial<Parameters<typeof makeState>[0]> = {}) {
  return makeState({ phase: 'end', pendingAction: null, ...overrides });
}

// ─── Victory detection at end of resolveEndPhase ──────────────────────────────

describe('victory detection at end of resolveEndPhase', () => {
  test('phase transitions to completed when dial score_vp pushes power to 50 VP', () => {
    // Xarm dial pos 0 → pos 1 gives score_vp 4.  Start at 46 VP → 50 after advance.
    let s = endState();
    s = setVP(s, 'xarm', 46);
    s = setDial(s, 'xarm', 0, 1);
    const { state, log } = resolveEndPhase(s);
    expect(state.phase).toBe('completed');
    expect(state.winners).toContain('xarm');
    expect(state.winCondition).toBe('vp');
    expect(log.entries.some(l => l.includes('Game over'))).toBe(true);
  });
});

// ─── World card persistent effects ───────────────────────────────────────────

describe('northern_heir persistent effect (end phase)', () => {
  test('places an additional Noble on a region that already has a Noble', () => {
    let s = endState();
    s = setWorldCard(s, 'northern_heir');
    s = addToken(s, 'norrsund', 'noble');
    const { state } = resolveEndPhase(s);
    const nobles = state.regions.norrsund!.tokens.filter(t => t === 'noble');
    expect(nobles.length).toBeGreaterThanOrEqual(2);
  });

  test('does nothing when no Noble tokens are on the board', () => {
    let s = endState();
    s = setWorldCard(s, 'northern_heir');
    // No nobles anywhere — should not crash
    const { state } = resolveEndPhase(s);
    expect(state.phase).not.toBe('completed');
  });
});

describe('diplomatic_envoy persistent effect (end phase)', () => {
  test('removes a Noble token from the first region that has one', () => {
    let s = endState();
    s = setWorldCard(s, 'diplomatic_envoy');
    s = addToken(s, 'norrsund', 'noble');
    const { state } = resolveEndPhase(s);
    expect(state.regions.norrsund!.tokens.filter(t => t === 'noble').length).toBe(0);
  });
});

describe('chaos_countermeasures persistent effect (end phase)', () => {
  test('places a Hero on the first region containing a Chaos Stone', () => {
    let s = endState();
    s = setWorldCard(s, 'chaos_countermeasures');
    s = addToken(s, 'volensk', 'chaos_stone');
    const { state } = resolveEndPhase(s);
    expect(state.regions.volensk!.tokens).toContain('hero');
  });

  test('does nothing when no Chaos Stones are on the board', () => {
    let s = endState();
    s = setWorldCard(s, 'chaos_countermeasures');
    const { state } = resolveEndPhase(s);
    // No crash, no hero placed
    for (const r of Object.values(state.regions)) {
      expect(r.tokens).not.toContain('hero');
    }
  });
});

describe('great_exorcism persistent effect (end phase)', () => {
  test('removes figures from event regions and moves events to most-corrupt region', () => {
    let s = endState();
    s = setWorldCard(s, 'great_exorcism');
    // norrsund has an event token and an xarm cultist
    s = addToken(s, 'norrsund', 'event');
    s = placeFollower(s, 'xarm', 'cultist', 'norrsund');
    // volensk has the most corruption
    s = addCorruption(s, 'volensk', 'gormen', 5);
    const { state, log } = resolveEndPhase(s);
    // Figure removed from norrsund
    expect(followersInRegion(state, 'norrsund').filter(f => f.power === 'xarm').length).toBe(0);
    expect(log.entries.some(l => l.includes('Great Exorcism') && l.includes('Norrsund'))).toBe(true);
    // Event token moved away from norrsund
    expect(state.regions.norrsund!.tokens).not.toContain('event');
    // Event now in most-corrupt region
    expect(state.regions.volensk!.tokens).toContain('event');
  });
});

describe('central_overpopulation persistent effect (end phase)', () => {
  test('removes a Peasant from each region containing an Event token', () => {
    let s = endState();
    s = setWorldCard(s, 'central_overpopulation');
    s = addToken(s, 'norrsund', 'event');
    s = addToken(s, 'norrsund', 'peasant');
    const { state, log } = resolveEndPhase(s);
    expect(state.regions.norrsund!.tokens).not.toContain('peasant');
    expect(log.entries.some(l => l.includes('Central Overpopulation'))).toBe(true);
  });

  test('does not remove Peasant from regions without an Event token', () => {
    let s = endState();
    s = setWorldCard(s, 'central_overpopulation');
    s = addToken(s, 'norrsund', 'peasant'); // no event token
    const { state } = resolveEndPhase(s);
    expect(state.regions.norrsund!.tokens).toContain('peasant');
  });
});

describe('the_exchange persistent effect (end phase)', () => {
  test('power with figure in Chaos Stone region draws a card', () => {
    let s = endState();
    s = setWorldCard(s, 'the_exchange');
    s = addToken(s, 'norrsund', 'chaos_stone');
    s = placeFollower(s, 'xarm', 'cultist', 'norrsund');
    s = giveInDeck(s, 'xarm', ['xarm_war_frenzy']);
    const before = s.powers.xarm!.hand.length;
    const { state } = resolveEndPhase(s);
    expect(state.powers.xarm!.hand.length).toBe(before + 1);
  });

  test('draws from reshuffled discard when deck is empty', () => {
    let s = endState();
    s = setWorldCard(s, 'the_exchange');
    s = addToken(s, 'norrsund', 'chaos_stone');
    s = placeFollower(s, 'xarm', 'cultist', 'norrsund');
    // Empty deck, card in discard
    s = {
      ...s,
      powers: {
        ...s.powers,
        xarm: { ...s.powers.xarm!, deckIds: [], discardIds: ['xarm_war_frenzy'] },
      },
    };
    const { state } = resolveEndPhase(s);
    // Card drawn from reshuffled discard
    expect(state.powers.xarm!.hand.length).toBe(1);
    expect(state.powers.xarm!.discardIds.length).toBe(0);
  });

  test('no draw for power without figure in any Chaos Stone region', () => {
    let s = endState();
    s = setWorldCard(s, 'the_exchange');
    s = addToken(s, 'norrsund', 'chaos_stone');
    // lasha has no figure in norrsund
    s = giveInDeck(s, 'lasha', ['lasha_narcotic_musk']);
    const before = s.powers.lasha!.hand.length;
    const { state } = resolveEndPhase(s);
    expect(state.powers.lasha!.hand.length).toBe(before);
  });
});

// ─── Dial instructions ────────────────────────────────────────────────────────

describe('dial instruction: place_nobles (Lasha pos 3, threat 16)', () => {
  test('places Noble tokens on board', () => {
    // Lasha dial: pos 2 → pos 3 = place_nobles 2
    let s = endState();
    s = setDial(s, 'lasha', 2, 1);
    const { state, log } = autoResolveEndPhase(resolveEndPhase(s));
    const noblePlacements = Object.values(state.regions)
      .flatMap(r => r.tokens)
      .filter(t => t === 'noble').length;
    expect(noblePlacements).toBeGreaterThanOrEqual(2);
    expect(log.entries.some(l => l.includes('Lasha') && l.includes('Noble'))).toBe(true);
  });
});

describe('dial instruction: place_chaos_stone (Tenzen pos 1, threat 7)', () => {
  test('places a Chaos Stone token on board', () => {
    // Tenzen dial: pos 0 → pos 1 = place_chaos_stone 1
    let s = endState();
    s = setDial(s, 'tenzen', 0, 1);
    const { state, log } = autoResolveEndPhase(resolveEndPhase(s));
    const stones = Object.values(state.regions)
      .flatMap(r => r.tokens)
      .filter(t => t === 'chaos_stone').length;
    expect(stones).toBeGreaterThanOrEqual(1);
    expect(log.entries.some(l => l.includes('Tenzen') && l.includes('Chaos Stone'))).toBe(true);
  });
});

describe('dial instruction: remove_corruption (Gormen pos 2, threat 10)', () => {
  test('removes 1 own corruption token from the board', () => {
    // Gormen dial: pos 1 → pos 2 = remove_corruption 1
    let s = endState();
    s = setDial(s, 'gormen', 1, 1);
    s = addCorruption(s, 'norrsund', 'gormen', 3);
    const { state, log } = autoResolveEndPhase(resolveEndPhase(s));
    const remaining = state.regions.norrsund!.corruptionTokens.gormen;
    expect(remaining).toBeLessThan(3);
    expect(log.entries.some(l => l.includes('Gormen') && l.includes('corruption'))).toBe(true);
  });
});

describe('dial instruction: remove_world_tokens (Lasha pos 6, threat 27)', () => {
  test('removes world tokens (non-chaos-stone) from regions', () => {
    // Lasha dial: pos 5 → pos 6 = remove_world_tokens 2
    // Give xarm equal counters to prevent lasha getting a bonus advance to victory (pos 7)
    let s = endState();
    s = setDial(s, 'lasha', 5, 1);
    s = setDial(s, 'xarm', 0, 1); // tie → no bonus advance for either
    // Add some removable tokens
    s = addToken(s, 'toscavar', 'noble');
    s = addToken(s, 'almerida', 'peasant');
    const { state, log } = autoResolveEndPhase(resolveEndPhase(s));
    // At least one token should be removed
    const totalTokens = Object.values(state.regions)
      .flatMap(r => r.tokens)
      .filter(t => t !== 'chaos_stone').length;
    // Before: 2 tokens added; after: should have fewer
    expect(totalTokens).toBeLessThanOrEqual(1);
    expect(log.entries.some(l => l.includes('Lasha') && l.includes('removes'))).toBe(true);
  });

  test('chaos_stone tokens are not removed', () => {
    // Lasha dial: pos 5 → pos 6 = remove_world_tokens 2
    let s = endState();
    s = setDial(s, 'lasha', 5, 1);
    s = addToken(s, 'norrsund', 'chaos_stone');
    const { state } = autoResolveEndPhase(resolveEndPhase(s));
    // chaos_stone is exempt from removal
    expect(state.regions.norrsund!.tokens).toContain('chaos_stone');
  });

  test('awaiting_action carries count upfront and remaining reduces per pick', () => {
    // remove_world_tokens: 2 emits awaiting_action each drain. First carries
    // remaining=2, count=2; after one pick remaining=1, count=2 (partial state
    // is durable — if a client only submitted 1 of 2, they see the reduced
    // awaiting_action next).
    let s = endState();
    s = setDial(s, 'lasha', 5, 1);
    s = setDial(s, 'xarm', 0, 1);
    s = addToken(s, 'normagne', 'peasant');
    s = addToken(s, 'toscavar', 'peasant');
    const { log } = autoResolveEndPhase(resolveEndPhase(s));
    const awaitings = log.events.filter(
      e => e.type === 'awaiting_action' &&
        (e as { actionKind?: string }).actionKind === 'dial_remove_world_token',
    ) as unknown as Array<{ context: { count: number; remaining: number } }>;
    expect(awaitings).toHaveLength(2);
    expect(awaitings[0]!.context).toMatchObject({ count: 2, remaining: 2 });
    expect(awaitings[1]!.context).toMatchObject({ count: 2, remaining: 1 });
  });

  test('double-advance (5→6→7 victory) still only queues 2 removals, not 3', () => {
    // If Lasha is unique max-counter holder, advanceThreatDials advances twice:
    // 5→6 (remove_world_tokens: 2) then 6→7 (victory).
    // Victory emits dial_victory but shouldn't add extra removal rewards.
    let s = endState();
    s = setDial(s, 'lasha', 5, 2); // lasha unique max
    s = setDial(s, 'xarm', 0, 1);
    s = addToken(s, 'normagne', 'peasant');
    s = addToken(s, 'toscavar', 'peasant');
    s = addToken(s, 'pelascos', 'peasant');
    s = addToken(s, 'almerida', 'peasant');
    const before = Object.values(s.regions)
      .flatMap(r => r.tokens)
      .filter(t => t === 'peasant').length;
    const { state, log } = autoResolveEndPhase(resolveEndPhase(s));
    const after = Object.values(state.regions)
      .flatMap(r => r.tokens)
      .filter(t => t === 'peasant').length;
    // If Lasha won via dial_victory, phase would be completed and no removals happen
    // Otherwise, exactly 2 removals.
    const removeCount = log.events.filter(
      e => e.type === 'dial_remove_world_token' && e.power === 'lasha',
    ).length;
    expect(removeCount).toBeLessThanOrEqual(2);
    expect(before - after).toBe(removeCount);
  });

  test('removes exactly 2 tokens when ample tokens available (regression: not 3)', () => {
    // Lasha dial: pos 5 → pos 6 = remove_world_tokens 2
    let s = endState();
    s = setDial(s, 'lasha', 5, 1);
    s = setDial(s, 'xarm', 0, 1); // tie → no bonus advance
    // Seed 5 peasants in different regions so there's no ambiguity
    s = addToken(s, 'normagne', 'peasant');
    s = addToken(s, 'toscavar', 'peasant');
    s = addToken(s, 'pelascos', 'peasant');
    s = addToken(s, 'almerida', 'peasant');
    s = addToken(s, 'mittelreich', 'peasant');
    const before = Object.values(s.regions)
      .flatMap(r => r.tokens)
      .filter(t => t === 'peasant').length;
    const { state, log } = autoResolveEndPhase(resolveEndPhase(s));
    const after = Object.values(state.regions)
      .flatMap(r => r.tokens)
      .filter(t => t === 'peasant').length;
    expect(before - after).toBe(2);
    const removeCount = log.events.filter(
      e => e.type === 'dial_remove_world_token' && e.power === 'lasha',
    ).length;
    expect(removeCount).toBe(2);
  });
});

describe('dial instruction: draw_chaos_cards (Xarm pos 3, threat 14)', () => {
  test('power draws 2 chaos cards', () => {
    // Xarm dial: pos 2 → pos 3 = draw_chaos_cards 2
    let s = endState();
    s = setDial(s, 'xarm', 2, 1);
    s = giveInDeck(s, 'xarm', ['xarm_war_frenzy', 'xarm_call_to_war']);
    const { state } = resolveEndPhase(s);
    expect(state.powers.xarm!.hand.length).toBe(2);
  });

  test('draws 0 cards when deck and discard are both empty', () => {
    // Xarm dial: pos 2 → pos 3 = draw_chaos_cards 2
    let s = endState();
    s = setDial(s, 'xarm', 2, 1);
    // deck and discard are empty by default
    const before = s.powers.xarm!.hand.length;
    const { state } = resolveEndPhase(s);
    expect(state.powers.xarm!.hand.length).toBe(before);
  });
});
