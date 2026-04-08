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

export function isPointlessAction(state: GameState, action: Action): boolean {
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
  return actions.filter(a => !isPointlessAction(state, a));
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
