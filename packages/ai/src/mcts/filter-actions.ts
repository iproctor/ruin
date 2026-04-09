import type { GameState, Action } from '@ruin/engine';
import { CHAOS_CARDS } from '@ruin/engine';

/**
 * Hard-block "pointless" card plays — actions where the card's prerequisites
 * are clearly unmet so the effect cannot fire.
 *
 * This is NOT strategic preference shaping. Each rule encodes a card-text
 * precondition. The model can still learn its own preferences within the
 * resulting action set; we just remove the obviously dead actions so MCTS
 * doesn't waste tree expansion on them.
 *
 * Only `summoning_play_card` actions are filtered. Summons, passes, and
 * non-summoning actions pass through untouched.
 */

const MAGIC_SYMBOL_CARDS = new Set(CHAOS_CARDS.filter(c => c.hasMagicSymbol).map(c => c.id));

// Cards that cost 0 PP. Playing one of these (with preconditions met) is
// nearly always strictly better than passing or summoning a low-value figure
// — they're free utility and they consume a card slot the opponent can't
// use later. Used by pruneActions to always-keep these in the root sample.
const ZERO_COST_CARDS = new Set(CHAOS_CARDS.filter(c => c.cost === 0).map(c => c.id));

export function isPointlessAction(state: GameState, action: Action): boolean {
  // Pointless pass: passing while you still have PP AND something to do is
  // wasteful. Real play almost never voluntarily forfeits resources. We
  // detect this here and let filterPointlessActions strip pass from the
  // legal set so MCTS has to commit to a real action.
  if (action.kind === 'summoning_pass') {
    const ps = state.powers[action.power];
    if (!ps) return false;
    if (ps.powerPoints <= 0) return false;       // out of PP, pass is fine
    // Hand or reserve followers available?
    const hasReserve = ps.followers.some(f => f.regionId === null);
    const hasHand = ps.hand.length > 0;
    if (!hasReserve && !hasHand) return false;   // nothing to spend on
    return true;                                  // resources + things to do = wasteful pass
  }

  // Xarm's first figure on the board should never start at an edge region.
  // Edges are too far from the action — xarm wants central where piles form.
  if (action.kind === 'summoning_summon_figure' && action.power === 'xarm') {
    const xarmOnBoard = state.powers['xarm']!.followers.some(f => f.regionId !== null);
    if (!xarmOnBoard) {
      // Only restrict when the board is also empty of enemies — once anyone
      // has committed figures, xarm may legitimately need to chase them.
      const anyEnemyOnBoard = (['gormen','tenzen','lasha'] as const).some(
        p => state.powers[p]!.followers.some(f => f.regionId !== null)
      );
      if (!anyEnemyOnBoard) {
        const INTERIOR = new Set(['mittelreich', 'normagne', 'toscavar', 'volensk']);
        if (!INTERIOR.has(action.toRegion)) return true;
      }
    }
  }

  if (action.kind !== 'summoning_play_card') return false;

  const region = state.regions[action.toRegion];
  if (!region) return false;

  const power = action.power;
  const ownFigs = region.placements.filter(f => (f.controlledBy ?? f.power) === power);
  const enemyFigs = region.placements.filter(f => (f.controlledBy ?? f.power) !== power);
  const enemyCultists = enemyFigs.filter(f => f.class === 'cultist');
  const ownCorr = region.corruptionTokens[power] ?? 0;

  switch (action.cardId) {
    // Need own figures present
    case 'xarm_ritual_death':
    case 'xarm_the_red_throne':
    case 'tenzen_persistence_matrix':
    case 'tenzen_fate_shield':
    case 'gormen_deaths_perfume':
    case 'gormen_vile_consumption':
      return ownFigs.length === 0;

    // Need own figures AND enemies (extra battle is wasted on empty region)
    case 'xarm_bloody_rebirth':
      return ownFigs.length === 0 || enemyFigs.length === 0;

    // Need enemy figures present (any class)
    case 'xarm_carnage_trap':
    case 'lasha_hollow_pact':
    case 'xarm_war_frenzy':
    case 'tenzen_the_meddling_of_rats':
    case 'gormen_pestilent_touch':
      return enemyFigs.length === 0;

    // Ecstasy stops dice from being rolled — useless if there are no enemy
    // dice to stop. Cultists usually have 0 attack and don't count, EXCEPT
    // for xarm cultists when xarm has the Heartseekers upgrade in play
    // (which gives them 1 attack die). War Frenzy as a card also rolls dice
    // independently of figures.
    case 'lasha_ecstasy': {
      const xarmHasHeartseekers =
        state.powers['xarm']?.upgradesInPlay.includes('xarm_heartseekers_up') ?? false;
      const enemyDiceFigs = enemyFigs.filter(f => {
        if (f.class === 'warrior' || f.class === 'incarnation') return true;
        // Upgraded xarm cultists also roll battle dice
        const ctrl = f.controlledBy ?? f.power;
        if (f.class === 'cultist' && ctrl === 'xarm' && xarmHasHeartseekers) return true;
        return false;
      });
      const enemyHasWarFrenzy = region.chaosCards.some(
        c => c !== null && c.cardId === 'xarm_war_frenzy' && c.playedBy !== power,
      );
      return enemyDiceFigs.length === 0 && !enemyHasWarFrenzy;
    }

    // Need enemy cultists present
    case 'lasha_narcotic_musk':
    case 'tenzen_shimmer':
    case 'tenzen_siphon_power':
      return enemyCultists.length === 0;

    // Inevitable Rot kills enemies based on own corruption — needs both
    case 'gormen_inevitable_rot':
      return ownCorr === 0 || enemyFigs.length === 0;

    // Pestilent Aura: useful only if we have/will-have own corruption here.
    // Approximation: skip if no corruption AND no own cultists to place future corruption.
    case 'gormen_pestilent_aura':
      return ownCorr === 0 && ownFigs.filter(f => f.class === 'cultist').length === 0;

    // Changer of Fate: cancels other cards in region — useless without other cards
    case 'tenzen_changer_of_fate': {
      const otherCards = region.chaosCards.filter(
        c => c !== null && c.cardId !== 'tenzen_changer_of_fate',
      );
      return otherCards.length === 0;
    }

    // Teleport: needs a movable figure (cultist or warrior) of any power in region
    case 'tenzen_teleport': {
      const movable = region.placements.filter(
        f => f.class === 'cultist' || f.class === 'warrior',
      );
      return movable.length === 0;
    }

    // Sweet Lies: +2 dom per Noble or Hero token in region — useless without
    case 'lasha_sweet_lies': {
      const nobleOrHero = region.tokens.filter(t => t === 'noble' || t === 'hero');
      return nobleOrHero.length === 0;
    }

    // Hidden Influence: moves a Peasant/Hero/Noble token from region.
    // Mechanically a Peasant is movable, but Peasants are common and low-value;
    // burning Hidden Influence (cost 1) on a Peasant is almost always wasteful.
    // Block unless there's a Noble or Hero to move — those are the high-value
    // targets the card is actually meant for.
    case 'lasha_hidden_influence': {
      const movable = region.tokens.filter(t => t === 'noble' || t === 'hero');
      return movable.length === 0;
    }

    // War Cry: blocks corruption placement here this round — useless if no figures at all
    case 'xarm_war_cry':
      return region.placements.length === 0;

    // Call to War: moves up to 2 own figures into this region — needs own figures elsewhere
    case 'xarm_call_to_war': {
      const own = state.powers[power];
      if (!own) return true;
      const elsewhere = own.followers.filter(
        f => f.regionId !== null && f.regionId !== action.toRegion,
      );
      return elsewhere.length === 0;
    }

    default:
      return false;
  }
}

export function filterPointlessActions(state: GameState, actions: Action[]): Action[] {
  const filtered = actions.filter(a => !isPointlessAction(state, a));
  // Safety: if the filter removes everything (unlikely but possible in
  // edge cases — e.g. no reserve, no useful cards, but PP remaining),
  // fall back to the unfiltered set so MCTS has something to expand.
  return filtered.length > 0 ? filtered : actions;
}

/**
 * Returns true if `action` plays a high-value xarm DELAY card. War Cry and
 * Bloody Rebirth are the two main "delay opponents long enough for xarm to
 * dial-win" tools. Their value is mostly indirect (denied opponent VP, denied
 * future corruption placers) and not visible to a value head trained on
 * outcomes alone — so we hand-bias the search toward sampling them when their
 * preconditions look strong.
 *
 *   War Cry — blocks new corruption placement in the region for the round.
 *     Triggers:
 *       1. corruption + chaos_stones + cultists ≥ 12 — region is about to ruin
 *       2. cultists > 6 — massive incoming corruption
 *
 *   Bloody Rebirth — adds a second battle round in the region. Doubles kill
 *     potential, eradicating opponent cultists who would otherwise corrupt
 *     next round. The DAC reward caps at one per region per round, so the
 *     extra kills are "wasted" from the value head's perspective even though
 *     they materially delay opponents.
 *     Triggers:
 *       1. xarm has attack dice present AND ≥ 3 enemy figures, OR
 *       2. enemy cultists ≥ 4 (lots of next-round corruption to deny)
 */
export function isXarmDelayPlay(state: GameState, action: Action): boolean {
  if (action.kind !== 'summoning_play_card') return false;
  const region = state.regions[action.toRegion];
  if (!region) return false;

  if (action.cardId === 'xarm_war_cry') {
    const cultistCount = region.placements.filter(
      f => f.class === 'cultist' && !f.tipped,
    ).length;
    if (cultistCount > 6) return true;
    const corruptionTotal = Object.values(region.corruptionTokens).reduce((a, b) => a + b, 0);
    const chaosStones = region.tokens.filter(t => t === 'chaos_stone').length;
    return corruptionTotal + chaosStones + cultistCount >= 12;
  }

  if (action.cardId === 'xarm_bloody_rebirth') {
    // Bloody Rebirth runs an extra battle in the region — does nothing
    // unless xarm has attack dice there. The delay value comes specifically
    // from eradicating enemy cultists (who would otherwise place corruption
    // next round); killing warriors/incarnations is tactical but doesn't
    // directly stall the opponent's VP race the same way.
    const xarmAttackPresent = region.placements.some(f =>
      !f.tipped &&
      (f.controlledBy ?? f.power) === 'xarm' &&
      (f.class === 'warrior' || f.class === 'incarnation'),
    );
    if (!xarmAttackPresent) return false;
    const enemyCultistCount = region.placements.filter(f =>
      !f.tipped &&
      f.class === 'cultist' &&
      (f.controlledBy ?? f.power) !== 'xarm',
    ).length;
    return enemyCultistCount >= 3;
  }

  return false;
}

// Backward-compat alias — kept so external callers don't break.
export const isWarCryDelayPlay = isXarmDelayPlay;

/**
 * Returns true if `action` plays a 0-cost chaos card whose preconditions are
 * met (i.e. the action would not be filtered as pointless). 0-cost cards are
 * essentially free utility — they cost no PP, occupy a card slot the opponent
 * can't reuse, and (when their preconditions hold) have a real positive
 * effect. Always-keep these in the root MCTS sample.
 */
export function isZeroCostCardPlay(state: GameState, action: Action): boolean {
  if (action.kind !== 'summoning_play_card') return false;
  if (!ZERO_COST_CARDS.has(action.cardId)) return false;
  // Defer to the same precondition checks used everywhere else.
  return !isPointlessAction(state, action);
}

/**
 * Returns true if `action` actively builds toward earning a Dial Advancement
 * Counter for the acting power. Used by MCTS root pruning to preferentially
 * keep these actions in the sampled set, breaking the chicken-and-egg loop
 * where non-xarm powers never earn DAC because the model doesn't know to
 * pursue the trigger conditions.
 *
 * DAC trigger reminder:
 *   xarm   — kill an enemy figure (any region)
 *   gormen — ≥2 own corruption tokens placed in a populous region
 *   tenzen — ≥2 own corruption tokens in a region with ≥2 magic symbols + chaos stones
 *   lasha  — ≥2 own corruption tokens in a region with a noble or hero token
 */
export function actionBuildsTowardDac(state: GameState, action: Action): boolean {
  if (action.kind === 'summoning_summon_figure') {
    const isCultist = action.followerId.includes('_cultist_');
    const region = state.regions[action.toRegion];
    if (!region) return false;
    const power = action.power;

    if (power === 'gormen') {
      // Cultists in populous regions place corruption next phase
      return isCultist && region.populous;
    }

    if (power === 'tenzen') {
      // Need cultists in a region with magic symbols or chaos stones
      if (!isCultist) return false;
      const magicSymbols = region.chaosCards.filter(
        c => c !== null && MAGIC_SYMBOL_CARDS.has(c.cardId),
      ).length;
      const chaosStones = region.tokens.filter(t => t === 'chaos_stone').length;
      return magicSymbols + chaosStones >= 1;
    }

    if (power === 'lasha') {
      // Cultists in regions with a Noble or Hero token
      if (!isCultist) return false;
      return region.tokens.some(t => t === 'noble' || t === 'hero');
    }

    if (power === 'xarm') {
      // Any figure into a contested region (xarm earns DAC from kills)
      return region.placements.some(f => (f.controlledBy ?? f.power) !== 'xarm');
    }
  }

  if (action.kind === 'summoning_play_card') {
    const region = state.regions[action.toRegion];
    if (!region) return false;
    const power = action.power;

    // Tenzen: playing a magic-symbol card into a region with own cultists
    // moves toward the (≥2 magic symbols + own corruption) trigger.
    if (power === 'tenzen' && MAGIC_SYMBOL_CARDS.has(action.cardId)) {
      const tenzenHere = region.placements.filter(
        f => (f.controlledBy ?? f.power) === 'tenzen',
      ).length;
      return tenzenHere > 0;
    }

    // Lasha: Hidden Influence to bring a Noble/Hero into a region with own cultists.
    if (power === 'lasha' && action.cardId === 'lasha_hidden_influence') {
      const lashaHere = region.placements.filter(
        f => (f.controlledBy ?? f.power) === 'lasha',
      ).length;
      return lashaHere > 0;
    }

    // Gormen: corruption-enabling cards in populous regions where gormen has presence.
    if (power === 'gormen' && region.populous) {
      const helpfulCards = new Set([
        'gormen_pestilent_aura',
        'gormen_pandemic',
        'gormen_deaths_perfume',
      ]);
      if (helpfulCards.has(action.cardId)) {
        const gormenHere = region.placements.filter(
          f => (f.controlledBy ?? f.power) === 'gormen',
        ).length;
        return gormenHere > 0;
      }
    }

    // Xarm: combat-buffing cards in contested regions
    if (power === 'xarm') {
      const combatCards = new Set([
        'xarm_war_frenzy',
        'xarm_call_to_war',
        'xarm_bloody_rebirth',
      ]);
      if (combatCards.has(action.cardId)) {
        return region.placements.some(f => (f.controlledBy ?? f.power) !== 'xarm');
      }
    }
  }

  return false;
}
