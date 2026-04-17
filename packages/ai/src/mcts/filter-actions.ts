import type { GameState, Action, RegionId } from '@ruin/engine';
import { CHAOS_CARDS, REGIONS, followersInRegion } from '@ruin/engine';

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

// Cards that cost 0 PP. Used by isZeroCostCardPlay for prior boost.
const ZERO_COST_CARDS = new Set(CHAOS_CARDS.filter(c => c.cost === 0).map(c => c.id));

export function isPointlessAction(state: GameState, action: Action): boolean {
  // Pointless pass: passing while you still have PP AND something to do is
  // wasteful. Real play almost never voluntarily forfeits resources. We
  // detect this here and let filterPointlessActions strip pass from the
  // legal set so MCTS has to commit to a real action.
  if (action.kind === 'summoning_pass') {
    const ps = state.powers[action.power];
    if (!ps) return false;
    // Only block pass as clearly wasteful when you have plenty of PP AND
    // reserve figures to summon. Saving cards in hand for a better round is
    // legitimate; low-PP passes are fine even with resources lying around.
    if (ps.powerPoints <= 2) return false;
    return ps.followers.some(f => f.regionId === null);
  }

  // Summoning into a ruined region is almost always pointless — no corruption,
  // no domination, no card slots. The only value is contesting ruination scoring
  // (end-phase VP from corruption tokens), which is too niche to justify the cost.
  if (action.kind === 'summoning_summon_figure') {
    const region = state.regions[action.toRegion];
    if (region && region.ruinationCardIndex !== null) return true;
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

  // 0-cost cards are never pointless — even if preconditions aren't ideal,
  // they cycle the hand for free and occupy a card slot.
  if (ZERO_COST_CARDS.has(action.cardId)) return false;

  const region = state.regions[action.toRegion];
  if (!region) return false;

  const power = action.power;
  const allFigs = followersInRegion(state, action.toRegion);
  const ownFigs = allFigs.filter(f => (f.controlledBy ?? f.power) === power);
  const enemyFigs = allFigs.filter(f => (f.controlledBy ?? f.power) !== power);
  const enemyCultists = enemyFigs.filter(f => f.class === 'cultist');
  const ownCorr = region.corruptionTokens[power] ?? 0;

  switch (action.cardId) {
    // Need own figures present
    case 'xarm_the_red_throne':
    case 'tenzen_persistence_matrix':
    case 'tenzen_fate_shield':
    case 'gormen_deaths_perfume':
    case 'gormen_vile_consumption':
      return ownFigs.length === 0;

    // Need own figures AND enemies
    case 'xarm_ritual_death':
    case 'xarm_bloody_rebirth':
      return ownFigs.length === 0 || enemyFigs.length === 0;

    // Need enemy figures present (any class)
    case 'xarm_carnage_trap':
    case 'lasha_hollow_pact':
    case 'tenzen_the_meddling_of_rats':
    case 'gormen_pestilent_touch':
      return enemyFigs.length === 0;

    // War Frenzy: pointless here if no enemies AND there's a better region
    // (enemies + free card slot) to play it in.
    case 'xarm_war_frenzy': {
      if (enemyFigs.length > 0) return false;
      const ALL_REGIONS = Object.keys(REGIONS) as RegionId[];
      const betterRegionExists = ALL_REGIONS.some(r => {
        if (r === action.toRegion) return false;
        const reg = state.regions[r];
        if (!reg || reg.ruinationCardIndex !== null) return false;
        if (reg.chaosCards[0] !== null && reg.chaosCards[1] !== null) return false;
        return followersInRegion(state, r).some(
          f => (f.controlledBy ?? f.power) !== power,
        );
      });
      return betterRegionExists;
    }

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
      const movable = followersInRegion(state, action.toRegion).filter(
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
      return followersInRegion(state, action.toRegion).length === 0;

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
 * Returns true if `action` plays a 0-cost chaos card whose preconditions are
 * met. 0-cost cards are essentially free utility — they cost no PP, occupy a
 * card slot the opponent can't reuse, and (when their preconditions hold)
 * have a real positive effect. Used for prior boost in MCTS root.
 */
export function isZeroCostCardPlay(state: GameState, action: Action): boolean {
  if (action.kind !== 'summoning_play_card') return false;
  if (!ZERO_COST_CARDS.has(action.cardId)) return false;
  return !isPointlessAction(state, action);
}

/**
 * Can xarm deal battle damage in this region? Checks figures (warriors,
 * incarnation, upgraded cultists) plus War Frenzy card presence.
 */
function xarmCanAttackInRegion(state: GameState, regionId: string): boolean {
  const region = state.regions[regionId as import('@ruin/engine').RegionId];
  if (!region) return false;

  // Battle-suppressing effects: Ecstasy (no dice rolled) and Mittelreich
  // Diplomacy world card + event token (no battle at all).
  const hasEcstasy = region.chaosCards.some(c => c !== null && c.cardId === 'lasha_ecstasy');
  if (hasEcstasy) return false;

  // Mittelreich Diplomacy world card: no battles in regions with event tokens.
  const hasDiplomacy = state.worldTrack.slot1 === 'mittelreich_diplomacy'
    || state.worldTrack.slot2 === 'mittelreich_diplomacy';
  if (hasDiplomacy && region.tokens.includes('event')) return false;

  const hasWarFrenzy = region.chaosCards.some(
    c => c !== null && c.cardId === 'xarm_war_frenzy',
  );
  if (hasWarFrenzy) return true;

  const xarmHasHeartseekers =
    state.powers['xarm']?.upgradesInPlay.includes('xarm_heartseekers_up') ?? false;

  return followersInRegion(state, regionId as import('@ruin/engine').RegionId).some(f => {
    if (f.tipped) return false;
    if ((f.controlledBy ?? f.power) !== 'xarm') return false;
    if (f.class === 'warrior' || f.class === 'incarnation') return true;
    if (f.class === 'cultist' && xarmHasHeartseekers) return true;
    return false;
  });
}

/**
 * Urgent retreat: moving a solo (≤1) cultist OUT of a region where xarm
 * can attack INTO a region where xarm can't attack. This is the "save
 * your only cultist from certain death" case — should get a very strong
 * prior boost for all non-xarm powers.
 */
export function isUrgentRetreatFromXarm(state: GameState, action: Action): boolean {
  if (action.kind !== 'summoning_summon_figure') return false;
  if (action.power === 'xarm') return false;

  const ps = state.powers[action.power];
  if (!ps) return false;
  const follower = ps.followers.find(f => f.id === action.followerId);
  if (!follower || follower.regionId === null) return false; // from reserve

  // Source region must be Xarm-threatened
  if (!xarmCanAttackInRegion(state, follower.regionId)) return false;
  // Must be moving to a DIFFERENT region
  if (action.toRegion === follower.regionId) return false;
  // Destination must be SAFE from Xarm
  if (xarmCanAttackInRegion(state, action.toRegion)) return false;

  // Only fires when this is a lone cultist (≤1 own cultists there).
  // If there's a pile, the concentration is worth more than the losses.
  const ownCultists = followersInRegion(state, follower.regionId as import('@ruin/engine').RegionId, action.power)
    .filter(f => !f.tipped && f.class === 'cultist').length;
  return ownCultists <= 1;
}

