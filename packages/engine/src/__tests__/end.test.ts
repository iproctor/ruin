/**
 * End phase and draw phase tests: chaos card removal, Hero tokens,
 * world card persistent effects, ruination scoring, dial advancement,
 * and draw-phase upgrades.
 */
import { resolveEndPhase } from '../phases/end.js';
import { beginDrawPhase, applyTenzenDiscard } from '../phases/draw.js';
import {
  makeState, placeFollower, placeCard, addCorruption, addToken,
  giveCards, giveInDeck, withUpgrade, setVP, setThreat, ruinRegion, setWorldCard,
} from './helpers.js';
import { BASE_POWER_POINTS } from '../constants.js';

// ─── Chaos card removal ───────────────────────────────────────────────────────

describe('chaos card removal', () => {
  test('chaos cards are moved to owning power discard at end of round', () => {
    let s = placeCard(
      makeState({ phase: 'end', pendingAction: null }),
      'xarm_scorched_earth', 'xarm', 'norrsund',
    );
    const { state } = resolveEndPhase(s);
    expect(state.regions.norrsund!.chaosCards[0]).toBeNull();
    expect(state.powers.xarm!.discardIds).toContain('xarm_scorched_earth');
  });

  test('Recursive Pattern is kept when persistNextRound is true', () => {
    let s = placeCard(
      makeState({ phase: 'end', pendingAction: null }),
      'tenzen_recursive_pattern', 'tenzen', 'norrsund', 0, { persistNextRound: true },
    );
    const { state } = resolveEndPhase(s);
    const card = state.regions.norrsund!.chaosCards[0];
    expect(card?.cardId).toBe('tenzen_recursive_pattern');
    expect(card?.persistNextRound).toBe(false); // flag reset
  });

  test('Recursive Pattern is discarded when persistNextRound is false', () => {
    let s = placeCard(
      makeState({ phase: 'end', pendingAction: null }),
      'tenzen_recursive_pattern', 'tenzen', 'norrsund', 0, { persistNextRound: false },
    );
    const { state } = resolveEndPhase(s);
    expect(state.regions.norrsund!.chaosCards[0]).toBeNull();
  });
});

// ─── Enthrallment release on discard ─────────────────────────────────────────

describe('Enthrallment release', () => {
  test('controlled enemy cultist is released when Enthrallment is discarded', () => {
    let s = makeState({ phase: 'end', pendingAction: null });
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund', { controlledBy: 'lasha' });
    s = placeCard(s, 'lasha_enthrallment', 'lasha', 'norrsund');
    const { state, log } = resolveEndPhase(s);
    // Controlled gormen cultist should be released
    expect(log.some(l => l.includes('Enthrallment discarded'))).toBe(true);
    const cultist = state.powers.gormen!.followers.find(f => f.class === 'cultist')!;
    expect(cultist.controlledBy).toBeNull();
  });
});

// ─── Hero tokens ─────────────────────────────────────────────────────────────

describe('Hero token resolution', () => {
  test('highest-threat power removes their weakest figure from hero region', () => {
    let s = makeState({ phase: 'end', pendingAction: null });
    s = setThreat(s, 'xarm', 100); // xarm is highest threat
    s = placeFollower(s, 'xarm', 'cultist', 'norrsund');
    s = addToken(s, 'norrsund', 'hero');
    const { state, log } = resolveEndPhase(s);
    expect(log.some(l => l.includes('Hero token') && l.includes('xarm'))).toBe(true);
    expect(state.regions.norrsund!.placements.filter(f => (f.controlledBy ?? f.power) === 'xarm')).toHaveLength(0);
  });

  test('two hero tokens force two separate removals', () => {
    let s = makeState({ phase: 'end', pendingAction: null });
    s = setThreat(s, 'xarm', 100);
    s = placeFollower(s, 'xarm', 'cultist', 'norrsund');
    s = placeFollower(s, 'xarm', 'cultist', 'norrsund');
    s = addToken(s, 'norrsund', 'hero');
    s = addToken(s, 'norrsund', 'hero');
    const { state } = resolveEndPhase(s);
    expect(state.regions.norrsund!.placements.filter(f => (f.controlledBy ?? f.power) === 'xarm')).toHaveLength(0);
  });

  test('hero token does nothing if no figures in region', () => {
    let s = makeState({ phase: 'end', pendingAction: null });
    s = addToken(s, 'norrsund', 'hero');
    expect(() => resolveEndPhase(s)).not.toThrow();
  });
});

// ─── Ruined region scoring ────────────────────────────────────────────────────

describe('ruined region scoring', () => {
  test('power with most corruption tokens in ruined region scores first VP', () => {
    let s = makeState({ phase: 'end', pendingAction: null });
    s = ruinRegion(s, 'norrsund', 1);
    s = addCorruption(s, 'norrsund', 'xarm', 3);
    s = addCorruption(s, 'norrsund', 'gormen', 1);
    const vpBefore = s.powers.xarm!.victoryPoints;
    const { state } = resolveEndPhase(s);
    // xarm has most tokens → scores first VP (6 for norrsund, card index 1)
    expect(state.powers.xarm!.victoryPoints).toBe(vpBefore + 6);
  });

  test('second place power scores second VP', () => {
    let s = makeState({ phase: 'end', pendingAction: null });
    s = ruinRegion(s, 'norrsund', 1);
    s = addCorruption(s, 'norrsund', 'xarm', 3);
    s = addCorruption(s, 'norrsund', 'gormen', 1);
    const vpBefore = s.powers.gormen!.victoryPoints;
    const { state } = resolveEndPhase(s);
    // gormen has 1 token = second place → scores 3
    expect(state.powers.gormen!.victoryPoints).toBe(vpBefore + 3);
  });

  test('tied-first players split (first+second)/count VP', () => {
    let s = makeState({ phase: 'end', pendingAction: null });
    s = ruinRegion(s, 'norrsund', 1);
    s = addCorruption(s, 'norrsund', 'xarm', 3);
    s = addCorruption(s, 'norrsund', 'gormen', 3);
    const vpXBefore = s.powers.xarm!.victoryPoints;
    const vpGBefore = s.powers.gormen!.victoryPoints;
    const { state } = resolveEndPhase(s);
    // Tied first with no second-place player: floor((6+0)/2) = 3 each
    expect(state.powers.xarm!.victoryPoints).toBe(vpXBefore + 3);
    expect(state.powers.gormen!.victoryPoints).toBe(vpGBefore + 3);
  });
});

// ─── Dial advancement ────────────────────────────────────────────────────────

describe('threat dial advancement', () => {
  test('power with dial counters advances their dial', () => {
    let s = makeState({ phase: 'end', pendingAction: null });
    s = {
      ...s,
      powers: { ...s.powers, xarm: { ...s.powers.xarm!, dialCounters: 1 } },
    };
    const dialBefore = s.powers.xarm!.dialPosition;
    const { state } = resolveEndPhase(s);
    expect(state.powers.xarm!.dialPosition).toBeGreaterThan(dialBefore);
  });

  test('power with most counters (unique) advances twice', () => {
    let s = makeState({ phase: 'end', pendingAction: null });
    s = {
      ...s,
      powers: {
        ...s.powers,
        xarm: { ...s.powers.xarm!, dialCounters: 5 },
        gormen: { ...s.powers.gormen!, dialCounters: 1 },
      },
    };
    const dialBefore = s.powers.xarm!.dialPosition;
    const { state } = resolveEndPhase(s);
    // xarm should advance twice (once for having counters, once for having most)
    expect(state.powers.xarm!.dialPosition).toBeGreaterThanOrEqual(dialBefore + 2);
  });

  test('dial counters are reset to 0 after advancement', () => {
    let s = makeState({ phase: 'end', pendingAction: null });
    s = {
      ...s,
      powers: { ...s.powers, gormen: { ...s.powers.gormen!, dialCounters: 3 } },
    };
    const { state } = resolveEndPhase(s);
    expect(state.powers.gormen!.dialCounters).toBe(0);
  });

  test('dial advancement with score_vp instruction awards VP', () => {
    let s = makeState({ phase: 'end', pendingAction: null });
    // Set xarm to position 0 (threat 3); next position 1 has score_vp: 4
    s = {
      ...s,
      powers: {
        ...s.powers,
        xarm: { ...s.powers.xarm!, dialCounters: 2, dialPosition: 0 },
      },
    };
    const vpBefore = s.powers.xarm!.victoryPoints;
    const { state } = resolveEndPhase(s);
    // xarm position 1 → score_vp 4
    expect(state.powers.xarm!.victoryPoints).toBeGreaterThan(vpBefore);
  });

  test('round increments after end phase', () => {
    const s = makeState({ phase: 'end', pendingAction: null, round: 1 });
    const { state } = resolveEndPhase(s);
    if (state.phase !== 'completed') {
      expect(state.round).toBe(2);
    }
  });
});

// ─── World card persistent effects ───────────────────────────────────────────

describe('world card persistent effects during end phase', () => {
  test('Strategic Vanguard: players with figures on Normagne discard a card', () => {
    let s = makeState({ phase: 'end', pendingAction: null });
    s = setWorldCard(s, 'strategic_vanguard');
    s = placeFollower(s, 'xarm', 'cultist', 'normagne');
    s = giveCards(s, 'xarm', ['xarm_scorched_earth']);
    const { state, log } = resolveEndPhase(s);
    expect(log.some(l => l.includes('Strategic Vanguard'))).toBe(true);
    expect(state.powers.xarm!.hand).not.toContain('xarm_scorched_earth');
  });

  test('Cleansing Wave: removes all corruption from event regions', () => {
    let s = makeState({ phase: 'end', pendingAction: null });
    s = setWorldCard(s, 'cleansing_wave');
    s = addToken(s, 'norrsund', 'event');
    s = addCorruption(s, 'norrsund', 'gormen', 5);
    const { state } = resolveEndPhase(s);
    expect(state.regions.norrsund!.corruptionTokens.gormen).toBe(0);
  });

  test('Noble Scrutiny: richest player removes 1 corruption from Noble regions', () => {
    let s = makeState({ phase: 'end', pendingAction: null });
    s = setWorldCard(s, 'noble_scrutiny');
    s = addToken(s, 'norrsund', 'noble');
    s = addCorruption(s, 'norrsund', 'xarm', 3);
    s = addCorruption(s, 'norrsund', 'gormen', 1);
    s = setVP(s, 'xarm', 20); // xarm has most VP
    const corrBefore = s.regions.norrsund!.corruptionTokens.xarm;
    const { state } = resolveEndPhase(s);
    expect(state.regions.norrsund!.corruptionTokens.xarm).toBe(corrBefore - 1);
  });
});

// ─── Draw phase ───────────────────────────────────────────────────────────────

describe('draw phase', () => {
  test('each non-Tenzen power draws 2 cards in draw phase', () => {
    let s = makeState({ phase: 'draw', pendingAction: null });
    // Give each power a deck to draw from
    for (const p of ['xarm', 'gormen', 'lasha'] as const) {
      s = giveInDeck(s, p, ['a', 'b', 'c', 'd']);
    }
    // Give Tenzen a short deck (below draw target so no discard required)
    s = giveInDeck(s, 'tenzen', ['t1', 't2', 't3', 't4', 't5']);
    const { state } = beginDrawPhase(s);
    for (const p of ['xarm', 'gormen', 'lasha'] as const) {
      expect(state.powers[p]!.hand.length).toBe(2); // drew 2
    }
  });

  test('Tenzen draws to 5 cards', () => {
    let s = makeState({ phase: 'draw', pendingAction: null });
    s = giveInDeck(s, 'tenzen', ['t1', 't2', 't3', 't4', 't5']);
    const { state } = beginDrawPhase(s);
    expect(state.powers.tenzen!.hand.length).toBe(5);
  });

  test('Tenzen with hand ≥ 5 must discard before drawing', () => {
    let s = makeState({ phase: 'draw', pendingAction: null });
    s = giveCards(s, 'tenzen', ['t1', 't2', 't3', 't4', 't5']);
    const { state } = beginDrawPhase(s);
    // Should set pendingAction for tenzen_discard
    expect(state.pendingAction?.actionKind).toBe('tenzen_discard');
    expect(state.pendingAction?.waitingFor).toBe('tenzen');
  });

  test('power points reset to base on draw phase', () => {
    let s = makeState({ phase: 'draw', pendingAction: null });
    s = { ...s, powers: { ...s.powers, xarm: { ...s.powers.xarm!, powerPoints: 0 } } };
    const { state } = beginDrawPhase(s);
    expect(state.powers.xarm!.powerPoints).toBe(BASE_POWER_POINTS.xarm);
  });

  test('passedSummoning is reset on draw phase', () => {
    let s = makeState({ phase: 'draw', pendingAction: null });
    s = { ...s, powers: { ...s.powers, xarm: { ...s.powers.xarm!, passedSummoning: true } } };
    const { state } = beginDrawPhase(s);
    expect(state.powers.xarm!.passedSummoning).toBe(false);
  });
});

// ─── Draw phase upgrades ──────────────────────────────────────────────────────

describe('draw phase upgrades', () => {
  test('Xarm Deluge of Ferocity: +1 extra card drawn', () => {
    let s = withUpgrade(makeState({ phase: 'draw', pendingAction: null }), 'xarm', 'xarm_deluge_of_ferocity');
    s = giveInDeck(s, 'xarm', ['a', 'b', 'c', 'd']);
    const { state } = beginDrawPhase(s);
    expect(state.powers.xarm!.hand.length).toBe(3); // 2 + 1 bonus
  });

  test('Xarm Power of Blood: +1 extra power point', () => {
    let s = withUpgrade(makeState({ phase: 'draw', pendingAction: null }), 'xarm', 'xarm_power_of_blood');
    const { state } = beginDrawPhase(s);
    expect(state.powers.xarm!.powerPoints).toBe(BASE_POWER_POINTS.xarm + 1);
  });

  test('Gormen Power of Pestilence: +2 extra power points', () => {
    let s = withUpgrade(makeState({ phase: 'draw', pendingAction: null }), 'gormen', 'gormen_power_of_pestilence');
    const { state } = beginDrawPhase(s);
    expect(state.powers.gormen!.powerPoints).toBe(BASE_POWER_POINTS.gormen + 2);
  });

  test('Tenzen Deluge of Magic: draws to 6 instead of 5', () => {
    let s = withUpgrade(makeState({ phase: 'draw', pendingAction: null }), 'tenzen', 'tenzen_deluge_of_magic');
    s = giveInDeck(s, 'tenzen', ['t1', 't2', 't3', 't4', 't5', 't6']);
    const { state } = beginDrawPhase(s);
    expect(state.powers.tenzen!.hand.length).toBe(6);
  });

  test('Tenzen Power of Magic: +1 extra power point', () => {
    let s = withUpgrade(makeState({ phase: 'draw', pendingAction: null }), 'tenzen', 'tenzen_power_of_magic');
    const { state } = beginDrawPhase(s);
    expect(state.powers.tenzen!.powerPoints).toBe(BASE_POWER_POINTS.tenzen + 1);
  });

  test('Lasha Power of Pain alone: +1 PP', () => {
    let s = withUpgrade(makeState({ phase: 'draw', pendingAction: null }), 'lasha', 'lasha_power_of_pain');
    const { state } = beginDrawPhase(s);
    expect(state.powers.lasha!.powerPoints).toBe(BASE_POWER_POINTS.lasha + 1);
  });

  test('Lasha Power of Pain + Power of Pleasure combined: +3 PP total', () => {
    let s = withUpgrade(makeState({ phase: 'draw', pendingAction: null }), 'lasha', 'lasha_power_of_pain');
    s = withUpgrade(s, 'lasha', 'lasha_power_of_pleasure');
    const { state } = beginDrawPhase(s);
    // Combined bonus: +3 instead of +1+1=+2
    expect(state.powers.lasha!.powerPoints).toBe(BASE_POWER_POINTS.lasha + 3);
  });

  test('Tenzen discard then draw — discarded card goes to discard pile', () => {
    let s = makeState({ phase: 'draw', pendingAction: null });
    s = giveCards(s, 'tenzen', ['tenzen_null_weave', 'tenzen_stasis_web', 'tenzen_phase_shift',
      'tenzen_recursive_pattern', 'tenzen_kaleidoscope']);
    s = giveInDeck(s, 'tenzen', ['tenzen_fates_aegis']);
    const { state: withPending } = beginDrawPhase(s);
    // Must discard
    const { state } = applyTenzenDiscard(withPending, {
      kind: 'tenzen_discard', power: 'tenzen', cardId: 'tenzen_null_weave',
    });
    expect(state.powers.tenzen!.discardIds).toContain('tenzen_null_weave');
    expect(state.powers.tenzen!.hand).not.toContain('tenzen_null_weave');
  });
});
