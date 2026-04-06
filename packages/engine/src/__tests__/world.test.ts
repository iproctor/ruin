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

describe('armistice', () => {
  test('places Event tokens on Almerida, Normagne, and Norrsund', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['armistice'] });
    const { state } = resolveWorldPhase(s);
    expect(state.regions.almerida!.tokens).toContain('event');
    expect(state.regions.normagne!.tokens).toContain('event');
    expect(state.regions.norrsund!.tokens).toContain('event');
    expect(state.phase).toBe('draw');
  });

  test('places card on world track (end_of_battle timing)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['armistice'] });
    const { state } = resolveWorldPhase(s);
    expect(state.worldTrack.slot1).toBe('armistice');
  });
});

describe('fortification', () => {
  test('places Peasant on all regions except The Barrens', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['fortification'] });
    const { state } = resolveWorldPhase(s);
    for (const r of ['norrsund', 'talvimaa', 'volensk', 'mittelreich', 'normagne',
      'almerida', 'toscavar', 'pelascos'] as const) {
      expect(state.regions[r]!.tokens).toContain('peasant');
    }
    expect(state.regions.the_barrens!.tokens).not.toContain('peasant');
  });
});

describe('the_pardon', () => {
  test('auto-replaces single Peasant with Noble when only one Peasant present', () => {
    let s = addToken(makeState({ phase: 'world', pendingAction: null, worldDeck: ['the_pardon'] }), 'norrsund', 'peasant');
    const { state } = resolveWorldPhase(s);
    expect(state.regions.norrsund!.tokens).not.toContain('peasant');
    expect(state.regions.norrsund!.tokens).toContain('noble');
    expect(state.phase).toBe('draw');
  });

  test('sets world_choice when multiple Peasants are present', () => {
    let s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['the_pardon'] });
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

describe('misdirection', () => {
  test('places Event tokens on Normagne, Mittelreich, Toscavar and Peasant on every region', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['misdirection'] });
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

describe('the_hunt', () => {
  test('places Hero on The Barrens and Pelascos', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['the_hunt'] });
    const { state } = resolveWorldPhase(s);
    expect(state.regions.the_barrens!.tokens).toContain('hero');
    expect(state.regions.pelascos!.tokens).toContain('hero');
  });
});

describe('populist_rising', () => {
  test('scores 1 VP per claimed Peasant, +3 for most', () => {
    let s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['populist_rising'] });
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
    let s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['populist_rising'] });
    s = { ...s, powers: { ...s.powers, xarm: { ...s.powers.xarm!, claimedPeasants: 1 } } };
    const { state } = resolveWorldPhase(s);
    expect(state.worldTrack.slot1).toBeNull();
  });
});

describe('false_lead', () => {
  test('draws another card from the deck immediately via autoAdvance', () => {
    // false_lead returns with phase still 'world' and no pendingAction,
    // so autoAdvance loops and resolves the next card (fortification here)
    const s = makeState({
      phase: 'world', pendingAction: null,
      worldDeck: ['false_lead', 'fortification'],
    });
    const { state, log } = autoAdvance({ state: s, log: [] });
    expect(log.some(l => l.includes('False Lead'))).toBe(true);
    // fortification places peasants on all regions except the_barrens
    expect(state.regions.norrsund!.tokens).toContain('peasant');
  });
});

// ─── Choice-requiring cards (set pendingAction) ───────────────────────────────

describe('strategic_vanguard', () => {
  test('places Noble on Normagne immediately and requires choice for second region', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['strategic_vanguard'] });
    const { state } = resolveWorldPhase(s);
    expect(state.regions.normagne!.tokens).toContain('noble');
    expect(state.pendingAction?.actionKind).toBe('world_choice');
    expect((state.pendingAction?.context as any).cardId).toBe('strategic_vanguard');
  });
});

describe('war_zone', () => {
  test('places Event on Mittelreich immediately and requires choice for second region', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['war_zone'] });
    const { state } = resolveWorldPhase(s);
    expect(state.regions.mittelreich!.tokens).toContain('event');
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('the_gambit', () => {
  test('requires a choice (pair selection)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['the_gambit'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('frontier_settlement', () => {
  test('requires a choice (2 regions for Ratmen)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['frontier_settlement'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('border_garrison', () => {
  test('requires a choice (2 regions for Peasant)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['border_garrison'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('the_exodus', () => {
  test('requires a choice (which region gets Event token)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['the_exodus'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('entanglement', () => {
  test('requires a choice (pair of Hero regions)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['entanglement'] });
    const { state } = resolveWorldPhase(s);
    expect(state.pendingAction?.actionKind).toBe('world_choice');
  });
});

describe('buried_cache', () => {
  test('requires a choice (2 regions for Chaos Stone)', () => {
    const s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['buried_cache'] });
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
    expect(log.some(l => l.includes('no Chaos Stone'))).toBe(true);
    expect(state.phase).toBe('draw');
  });
});

// ─── World track placement ────────────────────────────────────────────────────

describe('world track', () => {
  test('persistent card is placed in slot1, shifting existing slot1 to slot2', () => {
    let s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['armistice'] });
    s = { ...s, worldTrack: { slot1: 'fortification', slot2: null } };
    const { state } = resolveWorldPhase(s);
    expect(state.worldTrack.slot1).toBe('armistice');
    expect(state.worldTrack.slot2).toBe('fortification');
  });

  test('comet card on incoming draw clears existing comet card from track', () => {
    // armistice has hasCometIcon = true; put an existing comet card (war_zone) on track
    let s = makeState({ phase: 'world', pendingAction: null, worldDeck: ['armistice'] });
    s = { ...s, worldTrack: { slot1: 'war_zone', slot2: null } }; // war_zone has hasCometIcon = true
    const { state, log } = resolveWorldPhase(s);
    expect(log.some(l => l.includes('comet'))).toBe(true);
    expect(state.worldTrack.slot1).toBe('armistice');
    expect(state.worldTrack.slot2).toBeNull();
  });
});

// ─── applyWorldChoice ─────────────────────────────────────────────────────────

describe('applyWorldChoice: the_pardon', () => {
  test('replaces Peasant with Noble in chosen region', () => {
    let s = addToken(makeState(), 'talvimaa', 'peasant');
    s = { ...s, pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'the_pardon' } } };
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'the_pardon', choices: { regionId: 'talvimaa' },
    });
    expect(state.regions.talvimaa!.tokens).not.toContain('peasant');
    expect(state.regions.talvimaa!.tokens).toContain('noble');
    expect(state.phase).toBe('draw');
  });
});

describe('applyWorldChoice: frontier_settlement', () => {
  test('places Ratmen in both chosen regions', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'frontier_settlement' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'frontier_settlement',
      choices: { regions: ['norrsund', 'talvimaa'] },
    });
    expect(state.regions.norrsund!.tokens).toContain('ratmen');
    expect(state.regions.talvimaa!.tokens).toContain('ratmen');
  });
});

describe('applyWorldChoice: border_garrison', () => {
  test('places Peasant in both chosen regions', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'border_garrison' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'border_garrison',
      choices: { regions: ['volensk', 'pelascos'] },
    });
    expect(state.regions.volensk!.tokens).toContain('peasant');
    expect(state.regions.pelascos!.tokens).toContain('peasant');
  });
});

describe('applyWorldChoice: buried_cache', () => {
  test('places Chaos Stone in both chosen regions', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'buried_cache' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'buried_cache',
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

describe('applyWorldChoice: strategic_vanguard', () => {
  test('places Noble in chosen second region', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'strategic_vanguard' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'strategic_vanguard',
      choices: { regionId: 'almerida' },
    });
    expect(state.regions.almerida!.tokens).toContain('noble');
    expect(state.phase).toBe('draw');
  });
});

describe('applyWorldChoice: the_gambit', () => {
  test('pair ab places Nobles on Norrsund and Volensk', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'the_gambit' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'the_gambit',
      choices: { pair: 'ab' },
    });
    expect(state.regions.norrsund!.tokens).toContain('noble');
    expect(state.regions.volensk!.tokens).toContain('noble');
  });

  test('pair cd places Nobles on Talvimaa and Mittelreich', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'the_gambit' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'the_gambit',
      choices: { pair: 'cd' },
    });
    expect(state.regions.talvimaa!.tokens).toContain('noble');
    expect(state.regions.mittelreich!.tokens).toContain('noble');
  });
});

describe('applyWorldChoice: war_zone', () => {
  test('places Event in chosen second region', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'war_zone' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'war_zone',
      choices: { regionId: 'talvimaa' },
    });
    expect(state.regions.talvimaa!.tokens).toContain('event');
  });
});

describe('applyWorldChoice: entanglement', () => {
  test('pair ab places Heroes on Normagne and Mittelreich', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'entanglement' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'entanglement',
      choices: { pair: 'ab' },
    });
    expect(state.regions.normagne!.tokens).toContain('hero');
    expect(state.regions.mittelreich!.tokens).toContain('hero');
  });

  test('pair cd places Heroes on Almerida and Toscavar', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'entanglement' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'entanglement',
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

describe('applyWorldChoice: the_exodus', () => {
  test('places Event in chosen region', () => {
    const s = makeState({ pendingAction: { waitingFor: 'xarm', actionKind: 'world_choice', context: { cardId: 'the_exodus' } } });
    const { state } = applyWorldChoice(s, {
      kind: 'world_choice', power: 'xarm', cardId: 'the_exodus',
      choices: { regionId: 'toscavar' },
    });
    expect(state.regions.toscavar!.tokens).toContain('event');
  });
});
