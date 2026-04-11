/**
 * getLegalActions tests — verifies that the correct set of actions is returned
 * for each pending action type.
 */
import { getLegalActions } from '../legalActions.js';
import {
  makeState, placeFollower, placeCard, addCorruption, addToken,
  giveCards, withUpgrade, setPP,
} from './helpers.js';
import type { Power } from '../types.js';

// ─── No pending action ────────────────────────────────────────────────────────

describe('no pendingAction', () => {
  test('returns empty array when pendingAction is null', () => {
    const s = makeState({ pendingAction: null });
    expect(getLegalActions(s, 'xarm')).toHaveLength(0);
  });
});

describe('wrong power', () => {
  test('returns empty array when action is waiting for a different power', () => {
    const s = makeState({
      pendingAction: { waitingFor: 'gormen', actionKind: 'summoning_action', context: {} },
    });
    expect(getLegalActions(s, 'xarm')).toHaveLength(0);
  });
});

// ─── Summoning actions ────────────────────────────────────────────────────────

describe('summoning_action', () => {
  test('returns summoning_pass when power has 0 PP', () => {
    const s = setPP(makeState(), 'xarm', 0);
    const actions = getLegalActions(s, 'xarm');
    expect(actions.every(a => a.kind === 'summoning_pass')).toBe(true);
    expect(actions.length).toBe(1);
  });

  test('returns summoning_pass when power has already passed', () => {
    const s = makeState({
      powers: {
        ...makeState().powers,
        xarm: { ...makeState().powers.xarm!, passedSummoning: true },
      },
    });
    const actions = getLegalActions(s, 'xarm');
    expect(actions.every(a => a.kind === 'summoning_pass')).toBe(true);
  });

  test('includes summoning_pass among actions when PP > 0', () => {
    const s = makeState();
    const actions = getLegalActions(s, 'xarm');
    expect(actions.some(a => a.kind === 'summoning_pass')).toBe(true);
  });

  test('includes summon_figure actions for all non-ruined regions', () => {
    const s = makeState();
    const actions = getLegalActions(s, 'xarm');
    const summons = actions.filter(a => a.kind === 'summoning_summon_figure');
    expect(summons.length).toBeGreaterThan(0);
  });

  test('includes play_card actions when power has cards in hand', () => {
    const s = giveCards(makeState(), 'xarm', ['xarm_war_cry']);
    const actions = getLegalActions(s, 'xarm');
    const plays = actions.filter(a => a.kind === 'summoning_play_card');
    expect(plays.length).toBeGreaterThan(0);
  });

  test('does not include play_card if card is too expensive', () => {
    let s = giveCards(makeState(), 'xarm', ['xarm_call_to_war']); // cost 2
    s = setPP(s, 'xarm', 1); // only 1 PP
    const actions = getLegalActions(s, 'xarm');
    expect(actions.some(a => a.kind === 'summoning_play_card' && (a as any).cardId === 'xarm_call_to_war')).toBe(false);
  });

  test('moving sole figure only allows adjacent regions, not the whole map', () => {
    // Place xarm incarnation in normagne — it's xarm's only figure on the board.
    // normagne is adjacent to: mittelreich, almerida, toscavar.
    // talvimaa is NOT adjacent → must not appear as a legal move destination.
    let s = placeFollower(makeState(), 'xarm', 'incarnation', 'normagne');
    s = setPP(s, 'xarm', 10); // enough PP
    const actions = getLegalActions(s, 'xarm');
    const moveToTalvimaa = actions.filter(
      a => a.kind === 'summoning_summon_figure' &&
        (a as any).toRegion === 'talvimaa' &&
        s.powers.xarm!.followers.find(f => f.id === (a as any).followerId)?.regionId === 'normagne',
    );
    expect(moveToTalvimaa).toHaveLength(0);

    // But moving to adjacent regions should be allowed
    const moveToMittelreich = actions.filter(
      a => a.kind === 'summoning_summon_figure' &&
        (a as any).toRegion === 'mittelreich' &&
        s.powers.xarm!.followers.find(f => f.id === (a as any).followerId)?.regionId === 'normagne',
    );
    expect(moveToMittelreich.length).toBeGreaterThan(0);
  });

  test('Killing Ground filters out non-Xarm move actions', () => {
    let s = placeCard(makeState(), 'xarm_carnage_trap', 'xarm', 'norrsund');
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    s = makeState({
      ...s,
      pendingAction: { waitingFor: 'gormen', actionKind: 'summoning_action', context: {} },
      summoningIndex: 1,
    });
    // Ensure the killing ground card is in norrsund
    s = placeCard(s, 'xarm_carnage_trap', 'xarm', 'norrsund');
    // Place gormen cultist in norrsund
    s = placeFollower(s, 'gormen', 'cultist', 'norrsund');
    const actions = getLegalActions(s, 'gormen');
    // Gormen should not be able to move their cultist away from norrsund
    const moveFromNorrsund = actions.filter(
      a => a.kind === 'summoning_summon_figure' &&
        s.powers.gormen!.followers.find(f => f.id === (a as any).followerId)?.regionId === 'norrsund',
    );
    expect(moveFromNorrsund).toHaveLength(0);
  });
});

// ─── Tenzen discard ───────────────────────────────────────────────────────────

describe('tenzen_discard', () => {
  test('returns null option plus each card in hand', () => {
    let s = giveCards(makeState(), 'tenzen', ['tenzen_persistence_matrix', 'tenzen_shimmer']);
    s = {
      ...s,
      pendingAction: { waitingFor: 'tenzen', actionKind: 'tenzen_discard', context: {} },
    };
    const actions = getLegalActions(s, 'tenzen');
    expect(actions.some(a => a.kind === 'tenzen_discard' && (a as any).cardId === null)).toBe(true);
    expect(actions.some(a => a.kind === 'tenzen_discard' && (a as any).cardId === 'tenzen_persistence_matrix')).toBe(true);
    expect(actions.some(a => a.kind === 'tenzen_discard' && (a as any).cardId === 'tenzen_shimmer')).toBe(true);
  });
});

// ─── Upgrade choice ───────────────────────────────────────────────────────────

describe('upgrade_choice', () => {
  test('returns all available upgrade cards', () => {
    let s = makeState({
      pendingAction: { waitingFor: 'xarm', actionKind: 'upgrade_choice', context: {} },
    });
    const actions = getLegalActions(s, 'xarm');
    expect(actions.every(a => a.kind === 'upgrade_choice')).toBe(true);
    expect(actions.length).toBe(s.powers.xarm!.availableUpgradeIds.length);
  });
});

// ─── Corruption harvest choice ────────────────────────────────────────────────

describe('corruption_harvest_choice', () => {
  test('returns action with up to maxKills enemy cultists/warriors', () => {
    let s = makeState({
      pendingAction: {
        waitingFor: 'gormen',
        actionKind: 'corruption_harvest_choice',
        context: { regionId: 'norrsund', maxKills: 2 },
      },
    });
    s = placeFollower(s, 'xarm', 'cultist', 'norrsund');
    const actions = getLegalActions(s, 'gormen');
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]!.kind).toBe('corruption_harvest_choice');
  });
});

// ─── Card on play choice ──────────────────────────────────────────────────────

describe('card_on_play_choice', () => {
  test('War March returns move actions for own figures in other regions', () => {
    let s = placeFollower(makeState(), 'xarm', 'warrior', 'talvimaa');
    s = {
      ...s,
      pendingAction: {
        waitingFor: 'xarm',
        actionKind: 'card_on_play_choice',
        context: { cardId: 'xarm_call_to_war', regionId: 'norrsund' },
      },
    };
    const actions = getLegalActions(s, 'xarm');
    expect(actions.some(a => a.kind === 'card_on_play_choice')).toBe(true);
  });

  test('Phase Shift returns move actions for cultists/warriors in region', () => {
    let s = placeFollower(makeState(), 'gormen', 'cultist', 'norrsund');
    s = {
      ...s,
      pendingAction: {
        waitingFor: 'tenzen',
        actionKind: 'card_on_play_choice',
        context: { cardId: 'tenzen_teleport', regionId: 'norrsund' },
      },
    };
    const actions = getLegalActions(s, 'tenzen');
    expect(actions.some(a =>
      a.kind === 'card_on_play_choice' && (a as any).cardId === 'tenzen_teleport',
    )).toBe(true);
  });

  test("Meddling of Rats returns opponent targets", () => {
    let s = giveCards(makeState(), 'xarm', ['xarm_war_cry']);
    s = {
      ...s,
      pendingAction: {
        waitingFor: 'tenzen',
        actionKind: 'card_on_play_choice',
        context: { cardId: 'tenzen_the_meddling_of_rats', regionId: 'norrsund' },
      },
    };
    const actions = getLegalActions(s, 'tenzen');
    expect(actions.some(a =>
      a.kind === 'card_on_play_choice' && (a as any).choices?.targetPower === 'xarm',
    )).toBe(true);
  });

  test("Fate's Aegis returns own figures in region", () => {
    let s = placeFollower(makeState(), 'tenzen', 'warrior', 'norrsund');
    s = {
      ...s,
      pendingAction: {
        waitingFor: 'tenzen',
        actionKind: 'card_on_play_choice',
        context: { cardId: 'tenzen_fate_shield', regionId: 'norrsund' },
      },
    };
    const actions = getLegalActions(s, 'tenzen');
    expect(actions.some(a =>
      a.kind === 'card_on_play_choice' && (a as any).cardId === 'tenzen_fate_shield',
    )).toBe(true);
  });

  test('Invisible Hand returns token move actions', () => {
    let s = addToken(makeState(), 'norrsund', 'noble');
    s = {
      ...s,
      pendingAction: {
        waitingFor: 'lasha',
        actionKind: 'card_on_play_choice',
        context: { cardId: 'lasha_hidden_influence', regionId: 'norrsund' },
      },
    };
    const actions = getLegalActions(s, 'lasha');
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]!.kind).toBe('card_on_play_choice');
  });

  test('Enthrallment returns enemy cultists in region', () => {
    let s = placeFollower(makeState(), 'gormen', 'cultist', 'norrsund');
    s = {
      ...s,
      pendingAction: {
        waitingFor: 'lasha',
        actionKind: 'card_on_play_choice',
        context: { cardId: 'lasha_narcotic_musk', regionId: 'norrsund' },
      },
    };
    const actions = getLegalActions(s, 'lasha');
    expect(actions.some(a =>
      a.kind === 'card_on_play_choice' && (a as any).cardId === 'lasha_narcotic_musk',
    )).toBe(true);
  });
});
