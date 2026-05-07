/**
 * World phase tests — resolveWorldPhase (immediate card effects) and
 * applyWorldChoice (interactive choice resolution).
 */
import type { GameState } from '../types.js';
import { resolveWorldPhase, applyWorldChoice } from '../phases/world.js';
import { autoAdvance } from '../reducers.js';
import {
  makeState, placeFollower, addToken, addCorruption, setThreat, ruinRegion,
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
  test('places Hero on Normagne, Mittelreich, and Almerida', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['noble_scrutiny'] });
    const { state } = resolveWorldPhase(s);
    expect(state.regions.normagne!.tokens).toContain('hero');
    expect(state.regions.mittelreich!.tokens).toContain('hero');
    expect(state.regions.almerida!.tokens).toContain('hero');
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
  test('places Ratmen on The Barrens and Pelascos', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['chaos_countermeasures'] });
    const { state } = resolveWorldPhase(s);
    expect(state.regions.the_barrens!.tokens).toContain('ratmen');
    expect(state.regions.pelascos!.tokens).toContain('ratmen');
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
  test('places Hero on Normagne immediately and requires choice for second region', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['normagne_heir'] });
    const { state } = resolveWorldPhase(s);
    expect(state.regions.normagne!.tokens).toContain('hero');
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

describe('great_exorcism', () => {
  test('requires a choice (which region gets Event token)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['great_exorcism'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('ratmens_price', () => {
  test('requires a choice (pair of Ratmen regions)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['ratmens_price'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('chaos_storm', () => {
  test('requires a choice (3 regions for Chaos Stone)', () => {
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
  test('requires a choice (3 Populous Hero regions)', () => {
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

  test('comet card on incoming draw clears Event tokens placed by prior comet cards', () => {
    // Simulate prior comet card having placed Event tokens on the map.
    let s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['the_chokepoint'] });
    s = { ...s, worldTrack: { slot1: 'eastern_armistice', slot2: null, discardCard: null } };
    s = addToken(s, 'almerida', 'event');
    s = addToken(s, 'normagne', 'event');
    s = addToken(s, 'norrsund', 'event');
    const { state } = resolveWorldPhase(s);
    // Prior comet's events are gone
    expect(state.regions.almerida!.tokens).not.toContain('event');
    expect(state.regions.norrsund!.tokens).not.toContain('event');
    // New comet's events are present
    expect(state.regions.the_barrens!.tokens).toContain('event');
    expect(state.regions.mittelreich!.tokens).toContain('event');
    expect(state.regions.toscavar!.tokens).toContain('event');
    // Normagne was cleared by the comet replacement but isn't a target of chokepoint
    expect(state.regions.normagne!.tokens).not.toContain('event');
  });
});

// ─── applyWorldChoice ─────────────────────────────────────────────────────────

describe('applyWorldChoice: chaos_storm', () => {
  test('places Chaos Stone in all 3 chosen regions', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'chaos_storm' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'chaos_storm',
      choices: { regions: ['norrsund', 'almerida', 'volensk'] },
    });
    expect(state.regions.norrsund!.tokens).toContain('chaos_stone');
    expect(state.regions.almerida!.tokens).toContain('chaos_stone');
    expect(state.regions.volensk!.tokens).toContain('chaos_stone');
  });
});

describe('applyWorldChoice: grand_muster', () => {
  test('places Peasant, Hero, and Noble in chosen regions', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'grand_muster' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'grand_muster',
      choices: {
        peasantRegions: ['norrsund', 'talvimaa'],
        heroRegions: ['volensk', 'mittelreich'],
        nobleRegions: ['toscavar', 'pelascos'],
      },
    });
    expect(state.regions.norrsund!.tokens).toContain('peasant');
    expect(state.regions.volensk!.tokens).toContain('hero');
    expect(state.regions.toscavar!.tokens).toContain('noble');
  });
});

describe('applyWorldChoice: normagne_heir', () => {
  test('places Hero in chosen second region', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'normagne_heir' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'normagne_heir',
      choices: { regionId: 'almerida' },
    });
    expect(state.regions.almerida!.tokens).toContain('hero');
    expect(state.phase).toBe('draw');
  });
});

describe('applyWorldChoice: northern_heir', () => {
  test('pair ab places Heroes on Norrsund and Volensk', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'northern_heir' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'northern_heir',
      choices: { pair: 'ab' },
    });
    expect(state.regions.norrsund!.tokens).toContain('hero');
    expect(state.regions.volensk!.tokens).toContain('hero');
  });

  test('pair cd places Heroes on Talvimaa and Mittelreich', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'northern_heir' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'northern_heir',
      choices: { pair: 'cd' },
    });
    expect(state.regions.talvimaa!.tokens).toContain('hero');
    expect(state.regions.mittelreich!.tokens).toContain('hero');
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

describe("applyWorldChoice: ratmens_price", () => {
  test("pair ab places Ratmen on Normagne and Mittelreich", () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'ratmens_price' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'ratmens_price',
      choices: { pair: 'ab' },
    });
    expect(state.regions.normagne!.tokens).toContain('ratmen');
    expect(state.regions.mittelreich!.tokens).toContain('ratmen');
  });

  test("pair cd places Ratmen on Almerida and Toscavar", () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'ratmens_price' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'ratmens_price',
      choices: { pair: 'cd' },
    });
    expect(state.regions.almerida!.tokens).toContain('ratmen');
    expect(state.regions.toscavar!.tokens).toContain('ratmen');
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
  test('places Hero in each of the 3 chosen Populous regions', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'diplomatic_envoy' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'diplomatic_envoy',
      choices: { regions: ['volensk', 'mittelreich', 'normagne'] },
    });
    expect(state.regions.volensk!.tokens).toContain('hero');
    expect(state.regions.mittelreich!.tokens).toContain('hero');
    expect(state.regions.normagne!.tokens).toContain('hero');
  });
});

describe('applyWorldChoice: forward_scouts', () => {
  test('places Ratmen in chosen region', () => {
    // forward_scouts requires the target region (or one adjacent) to hold a
    // chaos stone — without it, getWorldChoiceRegions returns [] and the
    // engine would have auto-skipped instead of pausing for choice.
    let s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'forward_scouts' } } });
    s = addToken(s, 'norrsund', 'chaos_stone');
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'forward_scouts',
      choices: { regionId: 'norrsund' },
    });
    expect(state.regions.norrsund!.tokens).toContain('ratmen');
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

// ─── World choice validation ─────────────────────────────────────────────────
// Per-card semantics enforcement. A submitted action must satisfy the card's
// required count / shape; the engine refuses partial input rather than
// silently doing as much as possible (which would let a buggy or malicious
// client place 1 chaos stone instead of 3 for chaos_storm).

describe('applyWorldChoice: validation', () => {
  function pendingFor(cardId: string): GameState {
    return makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId } } });
  }

  test('chaos_storm rejects fewer than 3 regions', () => {
    const s = pendingFor('chaos_storm');
    expect(() => applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'chaos_storm',
      choices: { regions: ['norrsund', 'talvimaa'] },
    })).toThrow(/exactly 3/);
  });

  test('chaos_storm rejects more than 3 regions', () => {
    const s = pendingFor('chaos_storm');
    expect(() => applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'chaos_storm',
      choices: { regions: ['norrsund', 'talvimaa', 'volensk', 'mittelreich'] },
    })).toThrow(/exactly 3/);
  });

  test('chaos_storm rejects duplicate regions', () => {
    const s = pendingFor('chaos_storm');
    expect(() => applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'chaos_storm',
      choices: { regions: ['norrsund', 'norrsund', 'volensk'] },
    })).toThrow(/distinct/);
  });

  test('chaos_storm rejects ruined region', () => {
    let s = pendingFor('chaos_storm');
    s = ruinRegion(s, 'norrsund');
    expect(() => applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'chaos_storm',
      choices: { regions: ['norrsund', 'talvimaa', 'volensk'] },
    })).toThrow(/invalid region "norrsund"/);
  });

  test('chaos_storm accepts exactly 3 distinct non-ruined regions', () => {
    const s = pendingFor('chaos_storm');
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'chaos_storm',
      choices: { regions: ['norrsund', 'talvimaa', 'volensk'] },
    });
    expect(state.regions.norrsund!.tokens).toContain('chaos_stone');
    expect(state.regions.talvimaa!.tokens).toContain('chaos_stone');
    expect(state.regions.volensk!.tokens).toContain('chaos_stone');
  });

  test('diplomatic_envoy rejects fewer than 3 regions', () => {
    const s = pendingFor('diplomatic_envoy');
    expect(() => applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'diplomatic_envoy',
      choices: { regions: ['mittelreich'] },
    })).toThrow(/exactly 3/);
  });

  test('diplomatic_envoy rejects non-populous region', () => {
    const s = pendingFor('diplomatic_envoy');
    // norrsund is non-populous → not in allowed
    expect(() => applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'diplomatic_envoy',
      choices: { regions: ['norrsund', 'mittelreich', 'almerida'] },
    })).toThrow(/invalid region "norrsund"/);
  });

  test('diplomatic_envoy accepts 3 distinct populous regions', () => {
    const s = pendingFor('diplomatic_envoy');
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'diplomatic_envoy',
      choices: { regions: ['mittelreich', 'volensk', 'almerida'] },
    });
    expect(state.regions.mittelreich!.tokens).toContain('hero');
    expect(state.regions.volensk!.tokens).toContain('hero');
    expect(state.regions.almerida!.tokens).toContain('hero');
  });

  test('grand_muster rejects when a group is short', () => {
    const s = pendingFor('grand_muster');
    expect(() => applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'grand_muster',
      choices: {
        peasantRegions: ['norrsund'],          // need 2
        heroRegions:    ['volensk', 'mittelreich'],
        nobleRegions:   ['toscavar', 'pelascos'],
      },
    })).toThrow(/peasantRegions.*exactly 2/);
  });

  test('grand_muster rejects overlap across groups', () => {
    const s = pendingFor('grand_muster');
    expect(() => applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'grand_muster',
      choices: {
        peasantRegions: ['norrsund', 'talvimaa'],
        heroRegions:    ['norrsund', 'mittelreich'], // norrsund repeated
        nobleRegions:   ['toscavar', 'pelascos'],
      },
    })).toThrow(/all be distinct/);
  });

  test('grand_muster accepts 2+2+2 distinct regions', () => {
    const s = pendingFor('grand_muster');
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'grand_muster',
      choices: {
        peasantRegions: ['norrsund', 'talvimaa'],
        heroRegions:    ['volensk', 'mittelreich'],
        nobleRegions:   ['toscavar', 'pelascos'],
      },
    });
    expect(state.regions.norrsund!.tokens).toContain('peasant');
    expect(state.regions.volensk!.tokens).toContain('hero');
    expect(state.regions.toscavar!.tokens).toContain('noble');
  });

  test('grand_muster accepts a short final bucket when fewer than 6 regions remain (regression)', () => {
    // Ruin 4 regions so only 5 non-ruined remain. legalActions splits 2+2+1;
    // validator must accept that rather than demanding nobleRegions=2.
    let s = pendingFor('grand_muster');
    s = ruinRegion(s, 'mittelreich');
    s = ruinRegion(s, 'normagne');
    s = ruinRegion(s, 'almerida');
    s = ruinRegion(s, 'the_barrens');
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'grand_muster',
      choices: {
        peasantRegions: ['norrsund', 'talvimaa'],
        heroRegions:    ['volensk', 'toscavar'],
        nobleRegions:   ['pelascos'],
      },
    });
    expect(state.regions.norrsund!.tokens).toContain('peasant');
    expect(state.regions.volensk!.tokens).toContain('hero');
    expect(state.regions.pelascos!.tokens).toContain('noble');
  });

  test('northern_heir rejects bad pair', () => {
    const s = pendingFor('northern_heir');
    expect(() => applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'northern_heir',
      choices: { pair: 'xx' },
    })).toThrow(/"pair"/);
  });

  test('great_exorcism rejects ruined region', () => {
    let s = pendingFor('great_exorcism');
    s = ruinRegion(s, 'mittelreich');
    expect(() => applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'great_exorcism',
      choices: { regionId: 'mittelreich' },
    })).toThrow(/regionId.*must be one of/);
  });
});
