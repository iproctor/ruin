/**
 * Summoning phase tests: figure placement, card plays, on-play effects,
 * cost modifiers, and cards whose effects apply at summon time.
 */
import { applyAction } from '../reducers.js';
import { applySummonFigure, applyPlayCard, applySummoningPass, getFollowerCost, applyCardOnPlayChoice } from '../phases/summoning.js';
import { resolveCorruptionPhase } from '../phases/corruption.js';
import {
  makeState, placeFollower, placeCard, addCorruption, addToken,
  giveCards, withUpgrade, setPP, followersIn,
} from './helpers.js';
import { BASE_POWER_POINTS } from '../constants.js';
import { followersInRegion } from '../helpers.js';
import { GameLog } from '../gameLog.js';

// ─── Figure summoning ─────────────────────────────────────────────────────────

describe('summoning figures', () => {
  test('summon cultist to region costs 1 PP', () => {
    const s = makeState();
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'xarm', followerId: 'xarm_cultist_1', toRegion: 'norrsund',
    });
    expect(state.powers.xarm!.powerPoints).toBe(BASE_POWER_POINTS.xarm - 1);
    expect(followersInRegion(state, 'norrsund')).toHaveLength(1);
  });

  test('summon warrior costs 2 PP', () => {
    const s = makeState();
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'xarm', followerId: 'xarm_warrior_1', toRegion: 'norrsund',
    });
    expect(state.powers.xarm!.powerPoints).toBe(BASE_POWER_POINTS.xarm - 2);
  });

  test('summon incarnation costs 3 PP', () => {
    const s = makeState();
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'xarm', followerId: 'xarm_incarnation_1', toRegion: 'norrsund',
    });
    expect(state.powers.xarm!.powerPoints).toBe(BASE_POWER_POINTS.xarm - 3);
  });

  test('figure is placed in region and follower regionId updated', () => {
    const s = makeState();
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_cultist_1', toRegion: 'mittelreich',
    });
    expect(followersInRegion(state, 'mittelreich').some(f => f.id === 'gormen_cultist_1')).toBe(true);
    expect(state.powers.gormen!.followers.find(f => f.id === 'gormen_cultist_1')!.regionId).toBe('mittelreich');
  });

  test('moving figure from board removes it from source region', () => {
    let s = placeFollower(makeState(), 'xarm', 'warrior', 'norrsund');
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'xarm', followerId: 'xarm_warrior_1', toRegion: 'talvimaa',
    });
    expect(followersInRegion(state, 'norrsund')).toHaveLength(0);
    expect(followersInRegion(state, 'talvimaa')).toHaveLength(1);
  });

  test('cannot summon with insufficient power points', () => {
    const s = setPP(makeState(), 'xarm', 0);
    expect(() =>
      applySummonFigure(s, {
        kind: 'summoning_summon_figure', power: 'xarm', followerId: 'xarm_warrior_1', toRegion: 'norrsund',
      }),
    ).toThrow(/Not enough power points/);
  });
});

// ─── Summoning pass ───────────────────────────────────────────────────────────

describe('summoning pass', () => {
  test('pass marks passedSummoning and zeroes PP', () => {
    const s = makeState();
    const { state } = applySummoningPass(s, { kind: 'summoning_pass', power: 'xarm' });
    expect(state.powers.xarm!.passedSummoning).toBe(true);
    expect(state.powers.xarm!.powerPoints).toBe(0);
  });

  test('all powers passing moves phase to battle', () => {
    let s = makeState();
    for (const power of ['xarm', 'gormen', 'tenzen', 'lasha'] as const) {
      ({ state: s } = applySummoningPass(s, { kind: 'summoning_pass', power }));
    }
    expect(s.phase).toBe('battle');
  });
});

// ─── Play card ────────────────────────────────────────────────────────────────

describe('play card', () => {
  test('playing a card removes it from hand and deducts cost', () => {
    let s = giveCards(makeState(), 'xarm', ['xarm_war_cry']);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'xarm', cardId: 'xarm_war_cry',
      toRegion: 'norrsund', slotIndex: 0,
    });
    expect(state.powers.xarm!.hand).not.toContain('xarm_war_cry');
    expect(state.powers.xarm!.powerPoints).toBe(BASE_POWER_POINTS.xarm - 1); // cost 1
    expect(state.regions.norrsund!.chaosCards[0]?.cardId).toBe('xarm_war_cry');
  });

  test('cannot play card not in hand', () => {
    const s = makeState();
    expect(() =>
      applyPlayCard(s, {
        kind: 'summoning_play_card', power: 'xarm', cardId: 'xarm_war_cry',
        toRegion: 'norrsund', slotIndex: 0,
      }),
    ).toThrow(/not in hand/);
  });
});

// ─── Stasis Web (+2 cost for opponents) ──────────────────────────────────────

describe('Stasis Web', () => {
  test('+2 PP cost for non-Tenzen summon in region with Stasis Web', () => {
    let s = placeCard(makeState(), 'tenzen_stasis_web', 'tenzen', 'norrsund');
    s = setPP(s, 'xarm', 10);
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'xarm', followerId: 'xarm_warrior_1', toRegion: 'norrsund',
    });
    // warrior = 2 base + 2 stasis = 4
    expect(state.powers.xarm!.powerPoints).toBe(10 - 4);
  });

  test('Tenzen is not affected by Stasis Web cost', () => {
    let s = placeCard(makeState(), 'tenzen_stasis_web', 'tenzen', 'norrsund');
    s = setPP(s, 'tenzen', 10);
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'tenzen', followerId: 'tenzen_warrior_1', toRegion: 'norrsund',
    });
    // warrior = 2 (no stasis penalty for tenzen)
    expect(state.powers.tenzen!.powerPoints).toBe(10 - 2);
  });

  test('+2 PP cost for non-Tenzen card play in region with Stasis Web', () => {
    let s = placeCard(makeState(), 'tenzen_stasis_web', 'tenzen', 'norrsund');
    s = giveCards(s, 'xarm', ['xarm_war_cry']); // cost 1
    s = setPP(s, 'xarm', 10);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'xarm', cardId: 'xarm_war_cry',
      toRegion: 'norrsund', slotIndex: 1,
    });
    expect(state.powers.xarm!.powerPoints).toBe(10 - 3); // 1 + 2
  });
});

// ─── Killing Ground ───────────────────────────────────────────────────────────

describe('Killing Ground', () => {
  test('blocks non-Xarm figure from moving away from region', () => {
    let s = placeCard(makeState(), 'xarm_carnage_trap', 'xarm', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    expect(() =>
      applySummonFigure(s, {
        kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_cultist_1', toRegion: 'talvimaa',
      }),
    ).toThrow(/Killing Ground/);
  });

  test('Xarm figures can still move away from Killing Ground region', () => {
    let s = placeCard(makeState(), 'xarm_carnage_trap', 'xarm', 'norrsund');
    s = placeFollower(s, 'xarm', 'warrior', 'norrsund');
    expect(() =>
      applySummonFigure(s, {
        kind: 'summoning_summon_figure', power: 'xarm', followerId: 'xarm_warrior_1', toRegion: 'talvimaa',
      }),
    ).not.toThrow();
  });
});

// ─── On-play: Gormen Entropy ──────────────────────────────────────────────────

describe('Gormen Entropy (remove 1 corruption on play)', () => {
  test('removes one corruption token from the target region', () => {
    let s = addCorruption(makeState(), 'norrsund', 'xarm', 3);
    s = giveCards(s, 'gormen', ['gormen_decay']);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'gormen', cardId: 'gormen_decay',
      toRegion: 'norrsund', slotIndex: 0,
    });
    expect(state.regions.norrsund!.corruptionTokens.xarm).toBe(2);
  });
});

// ─── Corruption phase: Gormen Plague Bloom ────────────────────────────────────

describe('Gormen Plague Bloom (end of corruption phase effect)', () => {
  test('no effect when played — figures and tokens unchanged', () => {
    let s = placeFollower(makeState(), 'gormen', 'cultist', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = giveCards(s, 'gormen', ['gormen_vile_consumption']);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'gormen', cardId: 'gormen_vile_consumption',
      toRegion: 'norrsund', slotIndex: 0,
    });
    // On-play: figures remain, no extra corruption tokens
    expect(followersInRegion(state, 'norrsund').filter(f => f.power === 'gormen')).toHaveLength(2);
    expect(state.regions.norrsund!.corruptionTokens.gormen).toBe(0);
  });

  test('fires at end of corruption phase: removes figures and places tokens', () => {
    let s = placeFollower(makeState({ phase: 'corruption', pendingAction: null }), 'gormen', 'cultist', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    // Place the card on the board
    s = { ...s, regions: { ...s.regions, norrsund: { ...s.regions.norrsund!, chaosCards: [{ cardId: 'gormen_vile_consumption', playedBy: 'gormen', slotIndex: 0, persistNextRound: false, placedAt: 0 }, null] } } };
    const { state } = resolveCorruptionPhase(s);
    // 3 figures removed → floor(3/2) = 1 token
    expect(followersInRegion(state, 'norrsund').filter(f => f.power === 'gormen')).toHaveLength(0);
    expect(state.regions.norrsund!.corruptionTokens.gormen).toBeGreaterThanOrEqual(1);
  });
});

// ─── On-play: Tenzen Arcane Siphon ───────────────────────────────────────────

describe('Tenzen Arcane Siphon (PP transfer)', () => {
  test('drains 1 PP from each opponent with a cultist and gains PP', () => {
    let s = placeFollower(makeState(), 'gormen', 'cultist', 'norrsund');
    s = giveCards(s, 'tenzen', ['tenzen_siphon_power']);
    s = setPP(s, 'gormen', 3);
    const beforeTenzen = s.powers.tenzen!.powerPoints;
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'tenzen', cardId: 'tenzen_siphon_power',
      toRegion: 'norrsund', slotIndex: 0,
    });
    expect(state.powers.gormen!.powerPoints).toBe(2); // 3 - 1
    expect(state.powers.tenzen!.powerPoints).toBe(beforeTenzen - 0 + 1); // free card (cost 0) + gain 1
  });
});

// ─── On-play: Lasha Silent Taint ─────────────────────────────────────────────

describe('Lasha Silent Taint (place corruption, no dial)', () => {
  test('places 1 Lasha corruption token without triggering dial counter', () => {
    let s = giveCards(makeState(), 'lasha', ['lasha_depraved_infiltration']);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'lasha', cardId: 'lasha_depraved_infiltration',
      toRegion: 'norrsund', slotIndex: 0,
    });
    expect(state.regions.norrsund!.corruptionTokens.lasha).toBe(1);
    // dial counter should NOT have been incremented
    expect(state.powers.lasha!.dialCounters).toBe(0);
  });
});

// ─── On-play: Lasha Debauched Court ──────────────────────────────────────────

describe('Lasha Debauched Court (cost reduction)', () => {
  test('costs 3 normally (base cost)', () => {
    let s = giveCards(makeState(), 'lasha', ['lasha_debauched_royalty']);
    s = setPP(s, 'lasha', 10);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'lasha', cardId: 'lasha_debauched_royalty',
      toRegion: 'norrsund', slotIndex: 0,
    });
    expect(state.powers.lasha!.powerPoints).toBe(10 - 3);
  });

  test('costs 0 when region has 3+ corruption tokens', () => {
    let s = addCorruption(makeState(), 'norrsund', 'gormen', 3);
    s = giveCards(s, 'lasha', ['lasha_debauched_royalty']);
    s = setPP(s, 'lasha', 5);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'lasha', cardId: 'lasha_debauched_royalty',
      toRegion: 'norrsund', slotIndex: 0,
    });
    expect(state.powers.lasha!.powerPoints).toBe(5); // cost 0
  });
});

// ─── On-play choice: War March ────────────────────────────────────────────────

describe('Xarm War March (move figures in on play)', () => {
  test('playing sets pendingAction for card_on_play_choice', () => {
    let s = placeFollower(makeState(), 'xarm', 'warrior', 'talvimaa');
    s = giveCards(s, 'xarm', ['xarm_call_to_war']);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'xarm', cardId: 'xarm_call_to_war',
      toRegion: 'norrsund', slotIndex: 0,
    });
    expect(state.pendingAction?.actionKind).toBe('card_on_play_choice');
    expect(state.pendingAction?.waitingFor).toBe('xarm');
  });

  test('submitting choice moves figure into played region', () => {
    let s = placeFollower(makeState(), 'xarm', 'warrior', 'talvimaa');
    s = giveCards(s, 'xarm', ['xarm_call_to_war']);
    const { state: afterPlay } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'xarm', cardId: 'xarm_call_to_war',
      toRegion: 'norrsund', slotIndex: 0,
    });
    const followerId = afterPlay.powers.xarm!.followers.find(
      f => f.regionId === 'talvimaa',
    )!.id;
    const { state } = applyCardOnPlayChoice(afterPlay, {
      kind: 'card_on_play_choice', power: 'xarm', cardId: 'xarm_call_to_war',
      regionId: 'norrsund', choices: { followerIds: [followerId] },
    });
    expect(followersIn(state, 'xarm', 'norrsund')).toHaveLength(1);
    expect(followersIn(state, 'xarm', 'talvimaa')).toHaveLength(0);
  });
});

// ─── On-play choice: Tenzen Phase Shift ──────────────────────────────────────

describe('Tenzen Phase Shift (move figure to any region)', () => {
  test('moves chosen cultist from played region to destination', () => {
    let s = placeFollower(makeState(), 'gormen', 'cultist', 'norrsund');
    s = giveCards(s, 'tenzen', ['tenzen_teleport']);
    const { state: afterPlay } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'tenzen', cardId: 'tenzen_teleport',
      toRegion: 'norrsund', slotIndex: 0,
    });
    const followerId = followersInRegion(afterPlay, 'norrsund')[0]!.id;
    const { state } = applyCardOnPlayChoice(afterPlay, {
      kind: 'card_on_play_choice', power: 'tenzen', cardId: 'tenzen_teleport',
      regionId: 'norrsund', choices: { followerId, toRegion: 'mittelreich' },
    });
    expect(followersInRegion(state, 'norrsund')).toHaveLength(0);
    expect(followersInRegion(state, 'mittelreich')).toHaveLength(1);
  });
});

// ─── On-play choice: Tenzen Meddling of Rats ──────────────────────────────────

describe('Tenzen Meddling of Rats (opponent discards 2 cards)', () => {
  test('target opponent has 2 forced discards queued after Meddling of Rats resolves', () => {
    let s = giveCards(makeState(), 'xarm', ['xarm_war_cry', 'xarm_war_frenzy', 'xarm_carnage_trap']);
    s = giveCards(s, 'tenzen', ['tenzen_the_meddling_of_rats']);
    // Target must have figures in the region — place a Xarm cultist there.
    s = placeFollower(s, 'xarm', 'cultist', 'norrsund');
    const { state: afterPlay } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'tenzen', cardId: 'tenzen_the_meddling_of_rats',
      toRegion: 'norrsund', slotIndex: 0,
    });
    const { state } = applyCardOnPlayChoice(afterPlay, {
      kind: 'card_on_play_choice', power: 'tenzen', cardId: 'tenzen_the_meddling_of_rats',
      regionId: 'norrsund', choices: { targetPower: 'xarm' },
    });
    // Meddling of Rats now prompts immediate discard
    expect(state.pendingAction?.waitingFor).toBe('xarm');
    expect(state.pendingAction?.actionKind).toBe('forced_discard');
  });
});

// ─── On-play choice: Tenzen Fate's Aegis ─────────────────────────────────────

describe("Tenzen Fate's Aegis (protect figure)", () => {
  test('chosen figure gets protected = true', () => {
    let s = placeFollower(makeState(), 'tenzen', 'warrior', 'norrsund');
    s = giveCards(s, 'tenzen', ['tenzen_fate_shield']);
    const { state: afterPlay } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'tenzen', cardId: 'tenzen_fate_shield',
      toRegion: 'norrsund', slotIndex: 0,
    });
    const followerId = followersInRegion(afterPlay, 'norrsund')[0]!.id;
    const { state } = applyCardOnPlayChoice(afterPlay, {
      kind: 'card_on_play_choice', power: 'tenzen', cardId: 'tenzen_fate_shield',
      regionId: 'norrsund', choices: { followerId },
    });
    expect(followersInRegion(state, 'norrsund').find(f => f.id === followerId)!.protected).toBe(true);
  });
});

// ─── On-play choice: Lasha Invisible Hand ────────────────────────────────────

describe('Lasha Invisible Hand (move token)', () => {
  test('moves a Noble token from played region to destination', () => {
    let s = addToken(makeState(), 'norrsund', 'noble');
    s = giveCards(s, 'lasha', ['lasha_hidden_influence']);
    const { state: afterPlay } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'lasha', cardId: 'lasha_hidden_influence',
      toRegion: 'norrsund', slotIndex: 0,
    });
    const { state } = applyCardOnPlayChoice(afterPlay, {
      kind: 'card_on_play_choice', power: 'lasha', cardId: 'lasha_hidden_influence',
      regionId: 'norrsund', choices: { token: 'noble', fromRegion: 'norrsund', toRegion: 'mittelreich' },
    });
    expect(state.regions.norrsund!.tokens.includes('noble')).toBe(false);
    expect(state.regions.mittelreich!.tokens.includes('noble')).toBe(true);
  });
});

// ─── On-play choice: Lasha Enthrallment ──────────────────────────────────────

describe('Lasha Enthrallment (control enemy cultist)', () => {
  test('chosen enemy cultist gets controlledBy = lasha', () => {
    let s = placeFollower(makeState(), 'gormen', 'cultist', 'norrsund');
    s = giveCards(s, 'lasha', ['lasha_narcotic_musk']);
    s = setPP(s, 'lasha', 10);
    const { state: afterPlay } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'lasha', cardId: 'lasha_narcotic_musk',
      toRegion: 'norrsund', slotIndex: 0,
    });
    const followerId = followersInRegion(afterPlay, 'norrsund')[0]!.id;
    const { state } = applyCardOnPlayChoice(afterPlay, {
      kind: 'card_on_play_choice', power: 'lasha', cardId: 'lasha_narcotic_musk',
      regionId: 'norrsund', choices: { followerId },
    });
    const f = followersInRegion(state, 'norrsund').find(f => f.id === followerId)!;
    expect(f.controlledBy).toBe('lasha');
  });
});

// ─── Gormen Plaguefather upgrade: 2 corruption on summon ─────────────────────

describe('Gormen Plaguefather upgrade', () => {
  test('placing Plaguefather adds 2 corruption tokens to target region', () => {
    let s = withUpgrade(makeState(), 'gormen', 'gormen_plaguefather_up');
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_incarnation_1',
      toRegion: 'norrsund',
    });
    expect(state.regions.norrsund!.corruptionTokens.gormen).toBe(2);
  });

  test('summoning Plaguefather to a populous region grants Gormen a DAC', () => {
    // mittelreich is populous (value 5).
    let s = withUpgrade(makeState(), 'gormen', 'gormen_plaguefather_up');
    const before = s.powers.gormen!.dialCounters;
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_incarnation_1',
      toRegion: 'mittelreich',
    });
    expect(state.regions.mittelreich!.corruptionTokens.gormen).toBe(2);
    expect(state.powers.gormen!.dialCounters - before).toBe(1);
  });

  test('summoning Plaguefather to a non-populous region does NOT grant a DAC', () => {
    // norrsund is non-populous (value 1).
    let s = withUpgrade(makeState(), 'gormen', 'gormen_plaguefather_up');
    const before = s.powers.gormen!.dialCounters;
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_incarnation_1',
      toRegion: 'norrsund',
    });
    expect(state.regions.norrsund!.corruptionTokens.gormen).toBe(2);
    expect(state.powers.gormen!.dialCounters - before).toBe(0);
  });

  test('without the upgrade, summoning Plaguefather places no corruption and no DAC', () => {
    let s = makeState();
    const before = s.powers.gormen!.dialCounters;
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_incarnation_1',
      toRegion: 'mittelreich',
    });
    expect(state.regions.mittelreich!.corruptionTokens.gormen).toBe(0);
    expect(state.powers.gormen!.dialCounters - before).toBe(0);
  });

  test('summoning Plaguefather to the same populous region twice in one phase grants only 1 DAC', () => {
    let s = withUpgrade(makeState(), 'gormen', 'gormen_plaguefather_up');
    s = setPP(s, 'gormen', 99); // enough for three Plaguefather summons
    const before = s.powers.gormen!.dialCounters;

    // First summon: into Mittelreich → +1 DAC.
    let r = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_incarnation_1',
      toRegion: 'mittelreich',
    });
    s = r.state;
    expect(s.powers.gormen!.dialCounters - before).toBe(1);

    // Move Plaguefather to a different (non-populous) region so we can move it
    // back. Norrsund is non-populous → no extra DAC.
    r = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_incarnation_1',
      toRegion: 'volensk',
    });
    s = r.state;

    // Move back to Mittelreich. 2 more corruption are placed, but Gormen
    // already earned a DAC for Mittelreich this phase → no second DAC.
    r = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_incarnation_1',
      toRegion: 'mittelreich',
    });
    s = r.state;
    // Volensk IS populous (value 3) so the second summon earns its own DAC.
    // Only the third summon (back to Mittelreich) is the duplicate that must
    // be suppressed: 1 (mittelreich) + 1 (volensk) = 2 total, NOT 3.
    expect(s.powers.gormen!.dialCounters - before).toBe(2);
    expect(s.regions.mittelreich!.corruptionTokens.gormen).toBe(4); // 2+2 still placed
  });

  test('summoning Plaguefather to two different populous regions in one phase grants 2 DACs', () => {
    let s = withUpgrade(makeState(), 'gormen', 'gormen_plaguefather_up');
    s = setPP(s, 'gormen', 99);
    const before = s.powers.gormen!.dialCounters;
    let r = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_incarnation_1',
      toRegion: 'mittelreich',
    });
    s = r.state;
    r = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_incarnation_1',
      toRegion: 'normagne',
    });
    s = r.state;
    expect(s.powers.gormen!.dialCounters - before).toBe(2);
  });

  test('per-phase DAC tracker resets between phases (so Mittelreich can earn again next phase)', () => {
    let s = withUpgrade(makeState(), 'gormen', 'gormen_plaguefather_up');
    let r = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_incarnation_1',
      toRegion: 'mittelreich',
    });
    s = r.state;
    expect(s.powers.gormen!.dacRegionsThisPhase).toContain('mittelreich');

    // Simulate a phase change via a phase_start event (the same path the
    // engine uses when transitioning into the next phase).
    const log = new GameLog();
    s = log.apply(s, { type: 'phase_start', phase: 'battle', round: 1 });
    expect(s.powers.gormen!.dacRegionsThisPhase).toEqual([]);
  });
});

// ─── Gormen Plaguecarriers upgrade: free in empty region ─────────────────────

describe('Gormen Plaguecarriers upgrade', () => {
  test('first cultist in empty region costs 0', () => {
    let s = withUpgrade(makeState(), 'gormen', 'gormen_plaguecarriers_up');
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_cultist_1',
      toRegion: 'norrsund',
    });
    expect(state.powers.gormen!.powerPoints).toBe(BASE_POWER_POINTS.gormen); // 0 cost
  });

  test('second cultist in same region costs normally', () => {
    let s = withUpgrade(makeState(), 'gormen', 'gormen_plaguecarriers_up');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_cultist_2',
      toRegion: 'norrsund',
    });
    expect(state.powers.gormen!.powerPoints).toBe(BASE_POWER_POINTS.gormen - 1);
  });

  test('free move is recorded in freeRedeployIds', () => {
    const s = withUpgrade(makeState(), 'gormen', 'gormen_plaguecarriers_up');
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_cultist_1',
      toRegion: 'norrsund',
    });
    expect(state.powers.gormen!.freeRedeployIds).toContain('gormen_cultist_1');
  });

  test('same cultist cannot get free move twice per round', () => {
    let s = withUpgrade(makeState(), 'gormen', 'gormen_plaguecarriers_up');
    // First free summon to norrsund
    ({ state: s } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_cultist_1',
      toRegion: 'norrsund',
    }));
    const ppAfterFree = s.powers.gormen!.powerPoints;
    // Move same cultist to a different empty region — should cost 1 now
    ({ state: s } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_cultist_1',
      toRegion: 'talvimaa',
    }));
    expect(s.powers.gormen!.powerPoints).toBe(ppAfterFree - 1);
  });

  test('getFollowerCost returns 0 for unused cultist, 1 for already-used', () => {
    let s = withUpgrade(makeState(), 'gormen', 'gormen_plaguecarriers_up');
    // Before any move: cost is 0 for empty region
    expect(getFollowerCost(s, 'gormen', 'cultist', 'gormen_cultist_1', 'norrsund')).toBe(0);
    // Summon for free
    ({ state: s } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_cultist_1',
      toRegion: 'norrsund',
    }));
    // Same cultist to another empty region: cost is 1
    expect(getFollowerCost(s, 'gormen', 'cultist', 'gormen_cultist_1', 'talvimaa')).toBe(1);
    // Different cultist to an empty region: still 0
    expect(getFollowerCost(s, 'gormen', 'cultist', 'gormen_cultist_2', 'talvimaa')).toBe(0);
  });
});

// ─── Tenzen Apprentice upgrade: carry Chaos Stone ────────────────────────────

describe('Tenzen Apprentices upgrade (carry Chaos Stone)', () => {
  test('moving apprentice from region with Chaos Stone carries the stone', () => {
    let s = withUpgrade(makeState(), 'tenzen', 'tenzen_apprentices_up');
    s = placeFollower(s, 'tenzen', 'cultist', 'norrsund');
    s = addToken(s, 'norrsund', 'chaos_stone');
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'tenzen', followerId: 'tenzen_cultist_1',
      toRegion: 'talvimaa', carry: true,
    });
    expect(state.regions.norrsund!.tokens.includes('chaos_stone')).toBe(false);
    expect(state.regions.talvimaa!.tokens.includes('chaos_stone')).toBe(true);
  });

  test('teleporting apprentice from region with Chaos Stone carries the stone', () => {
    let s = withUpgrade(makeState(), 'tenzen', 'tenzen_apprentices_up');
    s = placeFollower(s, 'tenzen', 'cultist', 'norrsund');
    s = addToken(s, 'norrsund', 'chaos_stone');
    s = placeCard(s, 'tenzen_teleport', 'tenzen', 'norrsund');
    s = {
      ...s,
      pendingAction: {
        waitingFor: 'tenzen',
        actionKind: 'card_on_play_choice',
        context: { cardId: 'tenzen_teleport', regionId: 'norrsund' },
      },
    };
    const { state } = applyCardOnPlayChoice(s, {
      kind: 'card_on_play_choice', power: 'tenzen', cardId: 'tenzen_teleport',
      regionId: 'norrsund', choices: { followerId: 'tenzen_cultist_1', toRegion: 'talvimaa', carry: true },
    });
    expect(state.regions.norrsund!.tokens.includes('chaos_stone')).toBe(false);
    expect(state.regions.talvimaa!.tokens.includes('chaos_stone')).toBe(true);
  });

  test('teleporting apprentice without carry leaves the stone', () => {
    let s = withUpgrade(makeState(), 'tenzen', 'tenzen_apprentices_up');
    s = placeFollower(s, 'tenzen', 'cultist', 'norrsund');
    s = addToken(s, 'norrsund', 'chaos_stone');
    s = placeCard(s, 'tenzen_teleport', 'tenzen', 'norrsund');
    s = {
      ...s,
      pendingAction: {
        waitingFor: 'tenzen',
        actionKind: 'card_on_play_choice',
        context: { cardId: 'tenzen_teleport', regionId: 'norrsund' },
      },
    };
    const { state } = applyCardOnPlayChoice(s, {
      kind: 'card_on_play_choice', power: 'tenzen', cardId: 'tenzen_teleport',
      regionId: 'norrsund', choices: { followerId: 'tenzen_cultist_1', toRegion: 'talvimaa', carry: false },
    });
    expect(state.regions.norrsund!.tokens.includes('chaos_stone')).toBe(true);
    expect(state.regions.talvimaa!.tokens.includes('chaos_stone')).toBe(false);
  });
});

// ─── Tenzen Fractals upgrade: free Fractal on magic symbol card ───────────────

describe('Tenzen Fractals upgrade (free Fractal on magic symbol card)', () => {
  test('playing a magic symbol card summons a Fractal to that region for free', () => {
    let s = withUpgrade(makeState(), 'tenzen', 'tenzen_fractals_up');
    s = giveCards(s, 'tenzen', ['tenzen_changer_of_fate']); // hasMagicSymbol: true
    const fractalsInRegionBefore = followersInRegion(s, 'norrsund').filter(
      f => f.class === 'warrior' && f.power === 'tenzen',
    ).length;
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'tenzen', cardId: 'tenzen_changer_of_fate',
      toRegion: 'norrsund', slotIndex: 0,
    });
    const fractalsAfter = followersInRegion(state, 'norrsund').filter(
      f => f.class === 'warrior' && f.power === 'tenzen',
    ).length;
    expect(fractalsAfter).toBe(fractalsInRegionBefore + 1);
    // PP should only decrease by card cost (0), not warrior cost
    expect(state.powers.tenzen!.powerPoints).toBe(BASE_POWER_POINTS.tenzen);
  });
});
