/**
 * Test helpers — create minimal valid game states without going through
 * createInitialState so each test controls exactly what is in play.
 */
import type {
  GameState, Power, RegionId, Phase,
  FollowerInstance, PlayedCard, TokenType, RegionState, PowerState,
} from '../types.js';
import {
  REGIONS, REGION_ORDER, FOLLOWERS, BASE_POWER_POINTS,
  UPGRADES, THREAT_DIALS,
} from '../constants.js';
import { applyAction, autoAdvance } from '../reducers.js';
import { applyBattleHitAssignment } from '../phases/battle.js';
import { resolveEndPhase } from '../phases/end.js';
import { GameLog } from '../gameLog.js';
import { followersInRegion } from '../helpers.js';

// ─── Follower factories ───────────────────────────────────────────────────────

export function makeFollowers(power: Power): FollowerInstance[] {
  const result: FollowerInstance[] = [];
  for (const cls of ['cultist', 'warrior', 'incarnation'] as const) {
    const def = FOLLOWERS[power]![cls]!;
    for (let i = 1; i <= def.count; i++) {
      result.push({
        id: `${power}_${cls}_${i}`,
        power,
        class: cls,
        regionId: null,
        controlledBy: null,
        tipped: false,
        protected: false,
        warFrenzyHits: 0,
        placedAt: 0,
      });
    }
  }
  return result;
}

// ─── State factory ────────────────────────────────────────────────────────────

export function makeState(overrides: Partial<GameState> = {}): GameState {
  const allPowers: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

  const makePowerState = (power: Power): PowerState => {
    const basePP = BASE_POWER_POINTS[power]!;
    const startDialEntry = THREAT_DIALS[power]![0]!;
    const threatValue =
      typeof startDialEntry.threat === 'number' ? startDialEntry.threat : 0;
    return {
      power,
      playerType: 'human',
      victoryPoints: 0,
      powerPoints: basePP,
      basePowerPoints: basePP,
      threatValue,
      dialPosition: 0,
      dialCounters: 0,
      hand: [],
      deckIds: [],
      discardIds: [],
      upgradesInPlay: [],
      availableUpgradeIds: UPGRADES.filter(u => u.power === power).map(u => u.id),
      claimedPeasants: 0,
      passedSummoning: false,
      followers: makeFollowers(power),
      freeRedeployIds: [],
      summoningTurnsTaken: 0,
    };
  };

  const makeRegionState = (regionId: RegionId): RegionState => {
    const def = REGIONS[regionId]!;
    return {
      regionId,
      baseValue: def.baseValue,
      resistance: def.baseValue,
      conquestValue: def.baseValue,
      populous: def.populous,
      tokens: [],
      chaosCards: [null, null],
      ruinationCardIndex: null,
      corruptionTokens: { xarm: 0, gormen: 0, tenzen: 0, lasha: 0 },
    };
  };

  const base: GameState = {
    gameId: 'test',
    round: 1,
    phase: 'summoning',
    playerCount: 4,
    activePowers: [...allPowers],
    regions: Object.fromEntries(
      REGION_ORDER.map(id => [id, makeRegionState(id)]),
    ) as Record<RegionId, RegionState>,
    powers: Object.fromEntries(
      allPowers.map(p => [p, makePowerState(p)]),
    ) as Record<Power, PowerState>,
    worldDeck: [],
    worldTrack: { slot1: null, slot2: null, discardCard: null },
    ruinationCardsUsed: 0,
    tokenSupply: { event: 6, hero: 4, noble: 6, peasant: 20, ratmen: 6, chaos_stone: 14 },
    pendingAction: {
      waitingFor: 'xarm',
      actionKind: 'summoning_action',
      context: {},
    },
    summoningOrder: [...allPowers],
    summoningIndex: 0,
    battleState: null,
    pendingDialRewards: null,
    rngSeed: 42,
    actionCount: 0,
    events: [],
    winners: null,
    winCondition: null,
  };

  return { ...base, ...overrides };
}

// ─── State mutation helpers ───────────────────────────────────────────────────

/** Place the first available reserve follower of the given class in a region. */
export function placeFollower(
  state: GameState,
  power: Power,
  cls: 'cultist' | 'warrior' | 'incarnation',
  regionId: RegionId,
  opts: { controlledBy?: Power | null; protected?: boolean } = {},
): GameState {
  const follower = state.powers[power]!.followers.find(
    f => f.class === cls && f.regionId === null,
  );
  if (!follower) throw new Error(`No ${cls} in reserve for ${power}`);
  const updated = {
    ...follower,
    regionId,
    controlledBy: opts.controlledBy ?? null,
    protected: opts.protected ?? false,
  };
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: {
        ...state.powers[power]!,
        followers: state.powers[power]!.followers.map(f =>
          f.id === follower.id ? updated : f,
        ),
      },
    },
  };
}

/** Place a chaos card directly in a region (bypasses hand / cost). */
export function placeCard(
  state: GameState,
  cardId: string,
  power: Power,
  regionId: RegionId,
  slot: 0 | 1 = 0,
  opts: { persistNextRound?: boolean } = {},
): GameState {
  const card: PlayedCard = {
    cardId,
    playedBy: power,
    slotIndex: slot,
    persistNextRound: opts.persistNextRound ?? false,
    placedAt: 0,
  };
  const slots = [...state.regions[regionId]!.chaosCards] as [
    PlayedCard | null,
    PlayedCard | null,
  ];
  slots[slot] = card;
  return {
    ...state,
    regions: {
      ...state.regions,
      [regionId]: { ...state.regions[regionId]!, chaosCards: slots },
    },
  };
}

/** Add corruption tokens for a power in a region. */
export function addCorruption(
  state: GameState,
  regionId: RegionId,
  power: Power,
  amount: number,
): GameState {
  return {
    ...state,
    regions: {
      ...state.regions,
      [regionId]: {
        ...state.regions[regionId]!,
        corruptionTokens: {
          ...state.regions[regionId]!.corruptionTokens,
          [power]: state.regions[regionId]!.corruptionTokens[power] + amount,
        },
      },
    },
  };
}

/** Add a world token to a region. */
export function addToken(
  state: GameState,
  regionId: RegionId,
  token: TokenType,
): GameState {
  return {
    ...state,
    regions: {
      ...state.regions,
      [regionId]: {
        ...state.regions[regionId]!,
        tokens: [...state.regions[regionId]!.tokens, token],
      },
    },
  };
}

/** Put card IDs into a power's hand. */
export function giveCards(
  state: GameState,
  power: Power,
  cardIds: string[],
): GameState {
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: {
        ...state.powers[power]!,
        hand: [...state.powers[power]!.hand, ...cardIds],
      },
    },
  };
}

/** Put card IDs into a power's deck (front). */
export function giveInDeck(
  state: GameState,
  power: Power,
  cardIds: string[],
): GameState {
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: {
        ...state.powers[power]!,
        deckIds: [...cardIds, ...state.powers[power]!.deckIds],
      },
    },
  };
}

/** Activate an upgrade card for a power. */
export function withUpgrade(
  state: GameState,
  power: Power,
  upgradeId: string,
): GameState {
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: {
        ...state.powers[power]!,
        upgradesInPlay: [...state.powers[power]!.upgradesInPlay, upgradeId],
        availableUpgradeIds: state.powers[power]!.availableUpgradeIds.filter(
          id => id !== upgradeId,
        ),
      },
    },
  };
}

/** Override power points for a power. */
export function setPP(state: GameState, power: Power, pp: number): GameState {
  return {
    ...state,
    powers: { ...state.powers, [power]: { ...state.powers[power]!, powerPoints: pp } },
  };
}

/** Override victory points for a power. */
export function setVP(state: GameState, power: Power, vp: number): GameState {
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: { ...state.powers[power]!, victoryPoints: vp },
    },
  };
}

/** Override threat value for a power. */
export function setThreat(
  state: GameState,
  power: Power,
  threatValue: number,
): GameState {
  return {
    ...state,
    powers: {
      ...state.powers,
      [power]: { ...state.powers[power]!, threatValue },
    },
  };
}

/** Mark a region as ruined. */
export function ruinRegion(
  state: GameState,
  regionId: RegionId,
  cardIndex = 1,
): GameState {
  return {
    ...state,
    ruinationCardsUsed: state.ruinationCardsUsed + 1,
    regions: {
      ...state.regions,
      [regionId]: {
        ...state.regions[regionId]!,
        ruinationCardIndex: cardIndex,
      },
    },
  };
}

/** Place a world card on the world track slot. */
export function setWorldCard(
  state: GameState,
  cardId: string,
  slot: 'slot1' | 'slot2' = 'slot1',
): GameState {
  return {
    ...state,
    worldTrack: { ...state.worldTrack, [slot]: cardId },
  };
}

/**
 * Drive a battle to completion by automatically assigning hits to the cheapest
 * available enemy figures (greedy lowest-defense-first). Handles any number of
 * sequential `battle_hit_assignment` pending actions that arise from interactive
 * battle resolution.
 */
export function autoResolveBattle(
  result: { state: GameState; log: GameLog },
): { state: GameState; log: GameLog } {
  let { state: s, log } = result;
  let iters = 0;

  while (s.pendingAction?.actionKind === 'battle_hit_assignment' && iters < 200) {
    const ctx = s.pendingAction.context;
    const regionId = ctx['regionId'] as RegionId;
    const hitsRemaining = ctx['hitsRemaining'] as number;
    const power = s.pendingAction.waitingFor;

    // Use actual follower stats (accounts for per-power base defense)
    const enemies = followersInRegion(s, regionId)
      .filter(f => (f.controlledBy ?? f.power) !== power && !f.tipped && !f.protected)
      .map(f => {
        const stats = FOLLOWERS[f.power as Power]?.[f.class];
        const def = stats?.base.defense ?? 1;
        return { ...f, def };
      })
      .sort((a, b) => a.def - b.def);

    let remaining = hitsRemaining;
    const chosen: string[] = [];
    for (const f of enemies) {
      if (f.def <= remaining) { chosen.push(f.id); remaining -= f.def; }
    }

    const hitResult = applyBattleHitAssignment(s, {
      kind: 'battle_hit_assignment', power, regionId, followerIds: chosen,
    });
    const next = autoAdvance(hitResult);
    s = next.state;
    log.absorb(next.log);
    iters++;
  }

  return { state: s, log };
}

/**
 * Drive the end phase to completion by auto-resolving any interactive dial
 * reward choices:
 *   - upgrade_choice: pick the first available upgrade
 *   - place_token: pick the first non-ruined region
 *   - remove_corruption: pick the first region with own tokens
 *   - remove_world_tokens: pick the first non-chaos-stone token, falling back to chaos_stone
 *
 * Returns the final resolved state (phase advanced to 'world' or 'completed').
 */
export function autoResolveEndPhase(
  result: { state: GameState; log: GameLog },
): { state: GameState; log: GameLog } {
  let { state: s, log } = result;
  let iters = 0;

  while (s.pendingDialRewards !== null && iters < 100) {
    const pending = s.pendingAction;
    if (!pending) break;
    const power = pending.waitingFor;

    let next: { state: GameState; log: GameLog };

    switch (pending.actionKind) {
      case 'upgrade_choice': {
        const upgradeId = s.powers[power]!.availableUpgradeIds[0];
        if (!upgradeId) break;
        next = applyAction(s, { kind: 'upgrade_choice', power, upgradeCardId: upgradeId });
        s = next.state; log.absorb(next.log);
        break;
      }
      case 'dial_place_token': {
        const region = REGION_ORDER.find(r => s.regions[r]!.ruinationCardIndex === null);
        if (!region) break;
        next = applyAction(s, { kind: 'dial_place_token', power, regionId: region });
        s = next.state; log.absorb(next.log);
        break;
      }
      case 'dial_remove_corruption': {
        // Default test behavior: remove the acting power's own corruption first;
        // if none, fall through to any corruption in any region.
        let region = REGION_ORDER.find(r => s.regions[r]!.corruptionTokens[power] > 0);
        let targetPower: import('../types.js').Power = power;
        if (!region) {
          const ALL: import('../types.js').Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
          for (const r of REGION_ORDER) {
            for (const tp of ALL) {
              if ((s.regions[r]!.corruptionTokens[tp] ?? 0) > 0) {
                region = r;
                targetPower = tp;
                break;
              }
            }
            if (region) break;
          }
        }
        if (!region) break;
        next = applyAction(s, { kind: 'dial_remove_corruption', power, regionId: region, targetPower });
        s = next.state; log.absorb(next.log);
        break;
      }
      case 'dial_remove_world_token': {
        // Prefer non-chaos-stone so tests that care about chaos stones can
        // isolate the code path by leaving other tokens on the board.
        let picked = false;
        for (const regionId of REGION_ORDER) {
          const token = s.regions[regionId]!.tokens.find(t => t !== 'chaos_stone');
          if (token) {
            next = applyAction(s, { kind: 'dial_remove_world_token', power, regionId, tokenType: token });
            s = next.state; log.absorb(next.log);
            picked = true;
            break;
          }
        }
        if (!picked) {
          for (const regionId of REGION_ORDER) {
            const token = s.regions[regionId]!.tokens[0];
            if (token) {
              next = applyAction(s, { kind: 'dial_remove_world_token', power, regionId, tokenType: token });
              s = next.state; log.absorb(next.log);
              break;
            }
          }
        }
        break;
      }
      default:
        break;
    }
    iters++;
  }

  // If the phase is still 'end' but no pending rewards, run the end phase once more
  // (e.g., to advance to the next round after all choices are resolved).
  if (s.phase === 'end' && s.pendingDialRewards === null && !s.pendingAction) {
    const next = resolveEndPhase(s);
    s = next.state;
    log.absorb(next.log);
  }

  return { state: s, log };
}

/** Convenience: followers of a power in a region. */
export function followersIn(
  state: GameState,
  power: Power,
  regionId: RegionId,
): FollowerInstance[] {
  return followersInRegion(state, regionId, power);
}
