/**
 * Summoning phase tests: figure placement, card plays, on-play effects,
 * cost modifiers, and cards whose effects apply at summon time.
 */
import { applyAction } from '../reducers.js';
import { applySummonFigure, applyPlayCard, applySummoningPass } from '../phases/summoning.js';
import { applyCardOnPlayChoice } from '../phases/cardChoices.js';
import {
  makeState, placeFollower, placeCard, addCorruption, addToken,
  giveCards, withUpgrade, setPP, followersIn,
} from './helpers.js';
import { BASE_POWER_POINTS } from '../constants.js';

// ─── Figure summoning ─────────────────────────────────────────────────────────

describe('summoning figures', () => {
  test('summon cultist to region costs 1 PP', () => {
    const s = makeState();
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'xarm', followerId: 'xarm_cultist_1', toRegion: 'norrsund',
    });
    expect(state.powers.xarm!.powerPoints).toBe(BASE_POWER_POINTS.xarm - 1);
    expect(state.regions.norrsund!.placements).toHaveLength(1);
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

  test('figure is placed in region placements and follower regionId updated', () => {
    const s = makeState();
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_cultist_1', toRegion: 'mittelreich',
    });
    expect(state.regions.mittelreich!.placements.some(f => f.id === 'gormen_cultist_1')).toBe(true);
    expect(state.powers.gormen!.followers.find(f => f.id === 'gormen_cultist_1')!.regionId).toBe('mittelreich');
  });

  test('moving figure from board removes it from source region', () => {
    let s = placeFollower(makeState(), 'xarm', 'warrior', 'norrsund');
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'xarm', followerId: 'xarm_warrior_1', toRegion: 'talvimaa',
    });
    expect(state.regions.norrsund!.placements).toHaveLength(0);
    expect(state.regions.talvimaa!.placements).toHaveLength(1);
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
    let s = giveCards(makeState(), 'xarm', ['xarm_scorched_earth']);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'xarm', cardId: 'xarm_scorched_earth',
      toRegion: 'norrsund', slotIndex: 0,
    });
    expect(state.powers.xarm!.hand).not.toContain('xarm_scorched_earth');
    expect(state.powers.xarm!.powerPoints).toBe(BASE_POWER_POINTS.xarm - 1); // cost 1
    expect(state.regions.norrsund!.chaosCards[0]?.cardId).toBe('xarm_scorched_earth');
  });

  test('cannot play card not in hand', () => {
    const s = makeState();
    expect(() =>
      applyPlayCard(s, {
        kind: 'summoning_play_card', power: 'xarm', cardId: 'xarm_scorched_earth',
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
    s = giveCards(s, 'xarm', ['xarm_scorched_earth']); // cost 1
    s = setPP(s, 'xarm', 10);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'xarm', cardId: 'xarm_scorched_earth',
      toRegion: 'norrsund', slotIndex: 1,
    });
    expect(state.powers.xarm!.powerPoints).toBe(10 - 3); // 1 + 2
  });
});

// ─── Killing Ground ───────────────────────────────────────────────────────────

describe('Killing Ground', () => {
  test('blocks non-Xarm figure from moving away from region', () => {
    let s = placeCard(makeState(), 'xarm_killing_ground', 'xarm', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    expect(() =>
      applySummonFigure(s, {
        kind: 'summoning_summon_figure', power: 'gormen', followerId: 'gormen_cultist_1', toRegion: 'talvimaa',
      }),
    ).toThrow(/Killing Ground/);
  });

  test('Xarm figures can still move away from Killing Ground region', () => {
    let s = placeCard(makeState(), 'xarm_killing_ground', 'xarm', 'norrsund');
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
    s = giveCards(s, 'gormen', ['gormen_entropy']);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'gormen', cardId: 'gormen_entropy',
      toRegion: 'norrsund', slotIndex: 0,
    });
    expect(state.regions.norrsund!.corruptionTokens.xarm).toBe(2);
  });
});

// ─── On-play: Gormen Plague Bloom ─────────────────────────────────────────────

describe('Gormen Plague Bloom (remove figures → place tokens)', () => {
  test('removes Gormen figures and places 1 token per 2 figures', () => {
    let s = placeFollower(makeState(), 'gormen', 'cultist', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = giveCards(s, 'gormen', ['gormen_plague_bloom']);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'gormen', cardId: 'gormen_plague_bloom',
      toRegion: 'norrsund', slotIndex: 0,
    });
    expect(state.regions.norrsund!.placements.filter(f => f.power === 'gormen')).toHaveLength(0);
    // 3 figures → floor(3/2) = 1 token
    expect(state.regions.norrsund!.corruptionTokens.gormen).toBe(1);
  });
});

// ─── On-play: Tenzen Arcane Siphon ───────────────────────────────────────────

describe('Tenzen Arcane Siphon (PP transfer)', () => {
  test('drains 1 PP from each opponent with a cultist and gains PP', () => {
    let s = placeFollower(makeState(), 'gormen', 'cultist', 'norrsund');
    s = giveCards(s, 'tenzen', ['tenzen_arcane_siphon']);
    s = setPP(s, 'gormen', 3);
    const beforeTenzen = s.powers.tenzen!.powerPoints;
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'tenzen', cardId: 'tenzen_arcane_siphon',
      toRegion: 'norrsund', slotIndex: 0,
    });
    expect(state.powers.gormen!.powerPoints).toBe(2); // 3 - 1
    expect(state.powers.tenzen!.powerPoints).toBe(beforeTenzen - 0 + 1); // free card (cost 0) + gain 1
  });
});

// ─── On-play: Lasha Silent Taint ─────────────────────────────────────────────

describe('Lasha Silent Taint (place corruption, no dial)', () => {
  test('places 1 Lasha corruption token without triggering dial counter', () => {
    let s = giveCards(makeState(), 'lasha', ['lasha_silent_taint']);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'lasha', cardId: 'lasha_silent_taint',
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
    let s = giveCards(makeState(), 'lasha', ['lasha_debauched_court']);
    s = setPP(s, 'lasha', 10);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'lasha', cardId: 'lasha_debauched_court',
      toRegion: 'norrsund', slotIndex: 0,
    });
    expect(state.powers.lasha!.powerPoints).toBe(10 - 3);
  });

  test('costs 0 when region has 3+ corruption tokens', () => {
    let s = addCorruption(makeState(), 'norrsund', 'gormen', 3);
    s = giveCards(s, 'lasha', ['lasha_debauched_court']);
    s = setPP(s, 'lasha', 5);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'lasha', cardId: 'lasha_debauched_court',
      toRegion: 'norrsund', slotIndex: 0,
    });
    expect(state.powers.lasha!.powerPoints).toBe(5); // cost 0
  });
});

// ─── On-play choice: War March ────────────────────────────────────────────────

describe('Xarm War March (move figures in on play)', () => {
  test('playing sets pendingAction for card_on_play_choice', () => {
    let s = placeFollower(makeState(), 'xarm', 'warrior', 'talvimaa');
    s = giveCards(s, 'xarm', ['xarm_war_march']);
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'xarm', cardId: 'xarm_war_march',
      toRegion: 'norrsund', slotIndex: 0,
    });
    expect(state.pendingAction?.actionKind).toBe('card_on_play_choice');
    expect(state.pendingAction?.waitingFor).toBe('xarm');
  });

  test('submitting choice moves figure into played region', () => {
    let s = placeFollower(makeState(), 'xarm', 'warrior', 'talvimaa');
    s = giveCards(s, 'xarm', ['xarm_war_march']);
    const { state: afterPlay } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'xarm', cardId: 'xarm_war_march',
      toRegion: 'norrsund', slotIndex: 0,
    });
    const followerId = afterPlay.powers.xarm!.followers.find(
      f => f.regionId === 'talvimaa',
    )!.id;
    const { state } = applyCardOnPlayChoice(afterPlay, {
      kind: 'card_on_play_choice', power: 'xarm', cardId: 'xarm_war_march',
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
    s = giveCards(s, 'tenzen', ['tenzen_phase_shift']);
    const { state: afterPlay } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'tenzen', cardId: 'tenzen_phase_shift',
      toRegion: 'norrsund', slotIndex: 0,
    });
    const followerId = afterPlay.regions.norrsund!.placements[0]!.id;
    const { state } = applyCardOnPlayChoice(afterPlay, {
      kind: 'card_on_play_choice', power: 'tenzen', cardId: 'tenzen_phase_shift',
      regionId: 'norrsund', choices: { followerId, toRegion: 'mittelreich' },
    });
    expect(state.regions.norrsund!.placements).toHaveLength(0);
    expect(state.regions.mittelreich!.placements).toHaveLength(1);
  });
});

// ─── On-play choice: Tenzen Stolen Thoughts ──────────────────────────────────

describe('Tenzen Stolen Thoughts (opponent discards 2 cards)', () => {
  test('target opponent has 2 forced discards queued after Stolen Thoughts resolves', () => {
    let s = giveCards(makeState(), 'xarm', ['xarm_scorched_earth', 'xarm_war_frenzy', 'xarm_killing_ground']);
    s = giveCards(s, 'tenzen', ['tenzen_stolen_thoughts']);
    const { state: afterPlay } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'tenzen', cardId: 'tenzen_stolen_thoughts',
      toRegion: 'norrsund', slotIndex: 0,
    });
    const { state } = applyCardOnPlayChoice(afterPlay, {
      kind: 'card_on_play_choice', power: 'tenzen', cardId: 'tenzen_stolen_thoughts',
      regionId: 'norrsund', choices: { targetPower: 'xarm' },
    });
    // Stolen Thoughts queues a forced discard on xarm's next turn (not immediate)
    expect(state.powers.xarm!.pendingForcedDiscards).toBe(2);
  });
});

// ─── On-play choice: Tenzen Fate's Aegis ─────────────────────────────────────

describe("Tenzen Fate's Aegis (protect figure)", () => {
  test('chosen figure gets protected = true', () => {
    let s = placeFollower(makeState(), 'tenzen', 'warrior', 'norrsund');
    s = giveCards(s, 'tenzen', ['tenzen_fates_aegis']);
    const { state: afterPlay } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'tenzen', cardId: 'tenzen_fates_aegis',
      toRegion: 'norrsund', slotIndex: 0,
    });
    const followerId = afterPlay.regions.norrsund!.placements[0]!.id;
    const { state } = applyCardOnPlayChoice(afterPlay, {
      kind: 'card_on_play_choice', power: 'tenzen', cardId: 'tenzen_fates_aegis',
      regionId: 'norrsund', choices: { followerId },
    });
    expect(state.regions.norrsund!.placements.find(f => f.id === followerId)!.protected).toBe(true);
  });
});

// ─── On-play choice: Lasha Invisible Hand ────────────────────────────────────

describe('Lasha Invisible Hand (move token)', () => {
  test('moves a Noble token from played region to destination', () => {
    let s = addToken(makeState(), 'norrsund', 'noble');
    s = giveCards(s, 'lasha', ['lasha_invisible_hand']);
    const { state: afterPlay } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'lasha', cardId: 'lasha_invisible_hand',
      toRegion: 'norrsund', slotIndex: 0,
    });
    const { state } = applyCardOnPlayChoice(afterPlay, {
      kind: 'card_on_play_choice', power: 'lasha', cardId: 'lasha_invisible_hand',
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
    s = giveCards(s, 'lasha', ['lasha_enthrallment']);
    s = setPP(s, 'lasha', 10);
    const { state: afterPlay } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'lasha', cardId: 'lasha_enthrallment',
      toRegion: 'norrsund', slotIndex: 0,
    });
    const followerId = afterPlay.regions.norrsund!.placements[0]!.id;
    const { state } = applyCardOnPlayChoice(afterPlay, {
      kind: 'card_on_play_choice', power: 'lasha', cardId: 'lasha_enthrallment',
      regionId: 'norrsund', choices: { followerId },
    });
    const f = state.regions.norrsund!.placements.find(f => f.id === followerId)!;
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
});

// ─── Tenzen Apprentice upgrade: carry Chaos Stone ────────────────────────────

describe('Tenzen Apprentices upgrade (carry Chaos Stone)', () => {
  test('moving apprentice from region with Chaos Stone carries the stone', () => {
    let s = withUpgrade(makeState(), 'tenzen', 'tenzen_apprentices_up');
    s = placeFollower(s, 'tenzen', 'cultist', 'norrsund');
    s = addToken(s, 'norrsund', 'chaos_stone');
    const { state } = applySummonFigure(s, {
      kind: 'summoning_summon_figure', power: 'tenzen', followerId: 'tenzen_cultist_1',
      toRegion: 'talvimaa',
    });
    expect(state.regions.norrsund!.tokens.includes('chaos_stone')).toBe(false);
    expect(state.regions.talvimaa!.tokens.includes('chaos_stone')).toBe(true);
  });
});

// ─── Tenzen Fractals upgrade: free Fractal on magic symbol card ───────────────

describe('Tenzen Fractals upgrade (free Fractal on magic symbol card)', () => {
  test('playing a magic symbol card summons a Fractal to that region for free', () => {
    let s = withUpgrade(makeState(), 'tenzen', 'tenzen_fractals_up');
    s = giveCards(s, 'tenzen', ['tenzen_null_weave']); // hasMagicSymbol: true
    const fractalsInRegionBefore = s.regions.norrsund!.placements.filter(
      f => f.class === 'warrior' && f.power === 'tenzen',
    ).length;
    const { state } = applyPlayCard(s, {
      kind: 'summoning_play_card', power: 'tenzen', cardId: 'tenzen_null_weave',
      toRegion: 'norrsund', slotIndex: 0,
    });
    const fractalsAfter = state.regions.norrsund!.placements.filter(
      f => f.class === 'warrior' && f.power === 'tenzen',
    ).length;
    expect(fractalsAfter).toBe(fractalsInRegionBefore + 1);
    // PP should only decrease by card cost (0), not warrior cost
    expect(state.powers.tenzen!.powerPoints).toBe(BASE_POWER_POINTS.tenzen);
  });
});
