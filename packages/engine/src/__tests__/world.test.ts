/**
 * World phase tests — resolveWorldPhase (immediate card effects) and
 * applyWorldChoice (interactive choice resolution).
 */
import { resolveWorldPhase, applyWorldChoice } from '../phases/world.js';
import { autoAdvance } from '../reducers.js';
import {
  makeState, placeFollower, addToken, addCorruption, setThreat,
} from './helpers.js';

// ─── resolveWorldPhase: empty deck ───────────────────────────────────────────

describe('resolveWorldPhase: empty deck', () => {
  test('advances to draw phase when world deck is empty', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: [] });
    const { state } = resolveWorldPhase(s);
    expect(state.phase).toBe('draw');
  });
});

// ─── Auto-resolving cards (no choice required) ────────────────────────────────

describe('eastern_armistice', () => {
  test('places Event tokens on Almerida, Normagne, and Norrsund', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['eastern_armistice'] });
    const { state } = resolveWorldPhase(s);
    expect(state.regions.almerida!.tokens).toContain('event');
    expect(state.regions.normagne!.tokens).toContain('event');
    expect(state.regions.norrsund!.tokens).toContain('event');
    expect(state.phase).toBe('draw');
  });

  test('places card on world track (end_of_battle timing)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['eastern_armistice'] });
    const { state } = resolveWorldPhase(s);
    expect(state.worldTrack.slot1).toBe('eastern_armistice');
  });
});

describe('raise_the_militia', () => {
  test('places Peasant on all regions except The Barrens', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['raise_the_militia'] });
    const { state } = resolveWorldPhase(s);
    for (const r of ['norrsund', 'talvimaa', 'volensk', 'mittelreich', 'normagne',
      'almerida', 'toscavar', 'pelascos'] as const) {
      expect(state.regions[r]!.tokens).toContain('peasant');
    }
    expect(state.regions.the_barrens!.tokens).not.toContain('peasant');
  });
});

describe('purchased_title', () => {
  test('auto-replaces single Peasant with Noble when only one Peasant present', () => {
    let s = addToken(makeState({ phase: 'world', pendingAction: null, worldDeck: ['purchased_title'] }), 'norrsund', 'peasant');
    const { state } = resolveWorldPhase(s);
    expect(state.regions.norrsund!.tokens).not.toContain('peasant');
    expect(state.regions.norrsund!.tokens).toContain('noble');
    expect(state.phase).toBe('draw');
  });

  test('sets world_choice when multiple Peasants are present', () => {
    let s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['purchased_title'] });
    s = addToken(s, 'norrsund', 'peasant');
    s = addToken(s, 'talvimaa', 'peasant');
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('the_chokepoint', () => {
  test('places Event on The Barrens, Mittelreich, and Toscavar', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['the_chokepoint'] });
    const { state } = resolveWorldPhase(s);
    expect(state.regions.the_barrens!.tokens).toContain('event');
    expect(state.regions.mittelreich!.tokens).toContain('event');
    expect(state.regions.toscavar!.tokens).toContain('event');
    expect(state.worldTrack.slot1).toBe('the_chokepoint');
  });
});

describe('noble_scrutiny', () => {
  test('places Noble on Normagne, Mittelreich, and Almerida', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['noble_scrutiny'] });
    const { state } = resolveWorldPhase(s);
    expect(state.regions.normagne!.tokens).toContain('noble');
    expect(state.regions.mittelreich!.tokens).toContain('noble');
    expect(state.regions.almerida!.tokens).toContain('noble');
  });
});

describe('central_overpopulation', () => {
  test('places Event tokens on Normagne, Mittelreich, Toscavar and Peasant on every region', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['central_overpopulation'] });
    const { state } = resolveWorldPhase(s);
    expect(state.regions.normagne!.tokens).toContain('event');
    expect(state.regions.mittelreich!.tokens).toContain('event');
    expect(state.regions.toscavar!.tokens).toContain('event');
    // Every region should have a peasant
    for (const r of Object.keys(state.regions) as Array<keyof typeof state.regions>) {
      expect(state.regions[r]!.tokens).toContain('peasant');
    }
  });
});

describe('chaos_countermeasures', () => {
  test('places Hero on The Barrens and Pelascos', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['chaos_countermeasures'] });
    const { state } = resolveWorldPhase(s);
    expect(state.regions.the_barrens!.tokens).toContain('hero');
    expect(state.regions.pelascos!.tokens).toContain('hero');
  });
});

describe('peasant_harvest', () => {
  test('scores 1 VP per claimed Peasant, +3 for most', () => {
    let s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['peasant_harvest'] });
    s = {
      ...s, powers: {
        ...s.powers,
        xarm: { ...s.powers.xarm!, claimedPeasants: 3 },
        gormen: { ...s.powers.gormen!, claimedPeasants: 1 },
      },
    };
    const { state } = resolveWorldPhase(s);
    expect(state.powers.xarm!.victoryPoints).toBe(6);  // 3 + 3 bonus
    expect(state.powers.gormen!.victoryPoints).toBe(1); // 1, no bonus
    expect(state.powers.tenzen!.victoryPoints).toBe(0); // 0 claimed
  });

  test('is a discard-timing card — not placed on track', () => {
    let s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['peasant_harvest'] });
    s = { ...s, powers: { ...s.powers, xarm: { ...s.powers.xarm!, claimedPeasants: 1 } } };
    const { state } = resolveWorldPhase(s);
    expect(state.worldTrack.slot1).toBeNull();
  });
});

describe('accelerating_doom', () => {
  test('logs message and advances to draw, leaving remaining deck intact', () => {
    // false_lead pops itself and logs, but the next card stays in the deck
    // for the next world phase (advanceToDrawPhase runs unconditionally)
    const s = makeState({
      phase: 'world', pendingAction: null,
      worldDeck: ['accelerating_doom', 'raise_the_militia'],
    });
    const { state, log } = resolveWorldPhase(s);
    expect(log.entries.some(l => l.includes('Accelerating Doom'))).toBe(true);
    expect(state.phase).toBe('draw');
    expect(state.worldDeck).toContain('raise_the_militia');
  });
});

// ─── Choice-requiring cards (set pendingAction) ───────────────────────────────

describe('normagne_heir', () => {
  test('places Noble on Normagne immediately and requires choice for second region', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['normagne_heir'] });
    const { state } = resolveWorldPhase(s);
    expect(state.regions.normagne!.tokens).toContain('noble');
    expect(state.pendingAction?.actionKind).toBe('world_choice');
    expect((state.pendingAction?.context as any).cardId).toBe('normagne_heir');
  });
});

describe('mittelreich_diplomacy', () => {
  test('places Event on Mittelreich immediately and requires choice for second region', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['mittelreich_diplomacy'] });
    const { state } = resolveWorldPhase(s);
    expect(state.regions.mittelreich!.tokens).toContain('event');
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('northern_heir', () => {
  test('requires a choice (pair selection)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['northern_heir'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('ratmen_incursion', () => {
  test('requires a choice (2 regions for Ratmen)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['ratmen_incursion'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('peasant_prosperity', () => {
  test('requires a choice (2 regions for Peasant)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['peasant_prosperity'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('great_exorcism', () => {
  test('requires a choice (which region gets Event token)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['great_exorcism'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('heroes_of_order', () => {
  test('requires a choice (pair of Hero regions)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['heroes_of_order'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('chaos_storm', () => {
  test('requires a choice (2 regions for Chaos Stone)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['chaos_storm'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('the_exchange', () => {
  test('requires a choice (region for 2 Chaos Stones)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['the_exchange'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('diplomatic_envoy', () => {
  test('requires a choice (3 Noble regions)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['diplomatic_envoy'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('forward_scouts', () => {
  test('requires choice when Chaos Stone is present', () => {
    let s = addToken(makeState({ phase: 'world', pendingAction: null, worldDeck: ['forward_scouts'] }),
      'norrsund', 'chaos_stone');
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });

  test('no effect when no Chaos Stones on board', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['forward_scouts'] });
    const { state, log } = resolveWorldPhase(s);
    expect(log.entries.some(l => l.includes('no Chaos Stone'))).toBe(true);
    expect(state.phase).toBe('draw');
  });
});

// ─── World track placement ────────────────────────────────────────────────────

describe('world track', () => {
  test('persistent card is placed in slot1, shifting existing slot1 to slot2', () => {
    let s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['eastern_armistice'] });
    s = { ...s, worldTrack: { slot1: 'raise_the_militia', slot2: null, discardCard: null } };
    const { state } = resolveWorldPhase(s);
    expect(state.worldTrack.slot1).toBe('eastern_armistice');
    expect(state.worldTrack.slot2).toBe('raise_the_militia');
  });

  test('comet card on incoming draw clears existing comet card from track', () => {
    // armistice has hasCometIcon = true; put an existing comet card (war_zone) on track
    let s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['eastern_armistice'] });
    s = { ...s, worldTrack: { slot1: 'mittelreich_diplomacy', slot2: null, discardCard: null } }; // war_zone has hasCometIcon = true
    const { state, log } = resolveWorldPhase(s);
    expect(log.entries.some(l => l.includes('comet'))).toBe(true);
    expect(state.worldTrack.slot1).toBe('eastern_armistice');
    expect(state.worldTrack.slot2).toBeNull();
  });
});

// ─── applyWorldChoice ─────────────────────────────────────────────────────────

describe('applyWorldChoice: purchased_title', () => {
  test('replaces Peasant with Noble in chosen region', () => {
    let s = addToken(makeState(), 'talvimaa', 'peasant');
    s = { ...s, pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'purchased_title' } } };
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'purchased_title', choices: { regionId: 'talvimaa' },
    });
    expect(state.regions.talvimaa!.tokens).not.toContain('peasant');
    expect(state.regions.talvimaa!.tokens).toContain('noble');
    expect(state.phase).toBe('draw');
  });
});

describe('applyWorldChoice: ratmen_incursion', () => {
  test('places Ratmen in both chosen regions', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'ratmen_incursion' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'ratmen_incursion',
      choices: { regions: ['norrsund', 'talvimaa'] },
    });
    expect(state.regions.norrsund!.tokens).toContain('ratmen');
    expect(state.regions.talvimaa!.tokens).toContain('ratmen');
  });
});

describe('applyWorldChoice: peasant_prosperity', () => {
  test('places Peasant in both chosen regions', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'peasant_prosperity' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'peasant_prosperity',
      choices: { regions: ['volensk', 'pelascos'] },
    });
    expect(state.regions.volensk!.tokens).toContain('peasant');
    expect(state.regions.pelascos!.tokens).toContain('peasant');
  });
});

describe('applyWorldChoice: chaos_storm', () => {
  test('places Chaos Stone in both chosen regions', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'chaos_storm' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'chaos_storm',
      choices: { regions: ['norrsund', 'almerida'] },
    });
    expect(state.regions.norrsund!.tokens).toContain('chaos_stone');
    expect(state.regions.almerida!.tokens).toContain('chaos_stone');
  });
});

describe('applyWorldChoice: grand_muster', () => {
  test('places Peasant, Noble, and Ratmen in chosen regions', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'grand_muster' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'grand_muster',
      choices: {
        peasantRegions: ['norrsund', 'talvimaa'],
        nobleRegions: ['volensk', 'mittelreich'],
        ratmenRegions: ['toscavar', 'pelascos'],
      },
    });
    expect(state.regions.norrsund!.tokens).toContain('peasant');
    expect(state.regions.volensk!.tokens).toContain('noble');
    expect(state.regions.toscavar!.tokens).toContain('ratmen');
  });
});

describe('applyWorldChoice: normagne_heir', () => {
  test('places Noble in chosen second region', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'normagne_heir' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'normagne_heir',
      choices: { regionId: 'almerida' },
    });
    expect(state.regions.almerida!.tokens).toContain('noble');
    expect(state.phase).toBe('draw');
  });
});

describe('applyWorldChoice: northern_heir', () => {
  test('pair ab places Nobles on Norrsund and Volensk', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'northern_heir' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'northern_heir',
      choices: { pair: 'ab' },
    });
    expect(state.regions.norrsund!.tokens).toContain('noble');
    expect(state.regions.volensk!.tokens).toContain('noble');
  });

  test('pair cd places Nobles on Talvimaa and Mittelreich', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'northern_heir' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'northern_heir',
      choices: { pair: 'cd' },
    });
    expect(state.regions.talvimaa!.tokens).toContain('noble');
    expect(state.regions.mittelreich!.tokens).toContain('noble');
  });
});

describe('applyWorldChoice: mittelreich_diplomacy', () => {
  test('places Event in chosen second region', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'mittelreich_diplomacy' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'mittelreich_diplomacy',
      choices: { regionId: 'talvimaa' },
    });
    expect(state.regions.talvimaa!.tokens).toContain('event');
  });
});

describe('applyWorldChoice: heroes_of_order', () => {
  test('pair ab places Heroes on Normagne and Mittelreich', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'heroes_of_order' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'heroes_of_order',
      choices: { pair: 'ab' },
    });
    expect(state.regions.normagne!.tokens).toContain('hero');
    expect(state.regions.mittelreich!.tokens).toContain('hero');
  });

  test('pair cd places Heroes on Almerida and Toscavar', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'heroes_of_order' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'heroes_of_order',
      choices: { pair: 'cd' },
    });
    expect(state.regions.almerida!.tokens).toContain('hero');
    expect(state.regions.toscavar!.tokens).toContain('hero');
  });
});

describe('applyWorldChoice: cleansing_wave', () => {
  test('places Event in chosen adjacent region', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'cleansing_wave' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'cleansing_wave',
      choices: { regionId: 'mittelreich' },
    });
    expect(state.regions.mittelreich!.tokens).toContain('event');
  });
});

describe('applyWorldChoice: the_exchange', () => {
  test('places 2 Chaos Stones in chosen region', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'the_exchange' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'the_exchange',
      choices: { regionId: 'norrsund' },
    });
    const stoneCount = state.regions.norrsund!.tokens.filter(t => t === 'chaos_stone').length;
    expect(stoneCount).toBe(2);
  });
});

describe('applyWorldChoice: diplomatic_envoy', () => {
  test('places Noble in each of the 3 chosen regions', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'diplomatic_envoy' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'diplomatic_envoy',
      choices: { regions: ['norrsund', 'talvimaa', 'volensk'] },
    });
    expect(state.regions.norrsund!.tokens).toContain('noble');
    expect(state.regions.talvimaa!.tokens).toContain('noble');
    expect(state.regions.volensk!.tokens).toContain('noble');
  });
});

describe('applyWorldChoice: forward_scouts', () => {
  test('places Hero in chosen region', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'forward_scouts' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'forward_scouts',
      choices: { regionId: 'norrsund' },
    });
    expect(state.regions.norrsund!.tokens).toContain('hero');
  });
});

describe('applyWorldChoice: great_exorcism', () => {
  test('places Event in chosen region', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'great_exorcism' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'great_exorcism',
      choices: { regionId: 'toscavar' },
    });
    expect(state.regions.toscavar!.tokens).toContain('event');
  });
});
