import type {
  GameState,
  BattleHitAssignmentAction,
  FollowerInstance,
  Power,
  RegionId,
} from '@ruin/engine';
import { followersInRegion, effectiveDefense } from '@ruin/engine';

/**
 * Enumerate hit-assignment actions at a battle_hit_assignment decision point.
 *
 * The engine's getLegalActions only returns 3 hand-picked strategies (cultists-
 * first, attack-first, max-kills+peasants). For MCTS to discriminate between
 * strategically meaningful choices, we want a richer per-(power, class)
 * action space that lets the search ask "which group should I commit kills
 * against this battle?"
 *
 * Generates one action per `kill K members of group (power, class)` for each
 * group of non-tipped, non-protected enemies in the region. Plus combinations
 * of two groups when budget allows. Plus a "claim peasants only" action when
 * applicable. Always includes the empty (no kills, no peasants) fallback.
 *
 * Cap on total enumerated actions ~30 to keep MCTS branching tractable.
 */

interface Ctx {
  regionId: RegionId;
  hitsRemaining: number;
  peasantsAvailable: number;
}

function readContext(state: GameState): Ctx | null {
  const ctx = state.pendingAction?.context;
  if (!ctx) return null;
  return {
    regionId: ctx['regionId'] as RegionId,
    hitsRemaining: ctx['hitsRemaining'] as number,
    peasantsAvailable: (ctx['peasantsAvailable'] as number | undefined) ?? 0,
  };
}


const MAX_ACTIONS = 30;

export function enumerateKillActions(
  state: GameState,
  attacker: Power,
): BattleHitAssignmentAction[] {
  if (state.pendingAction?.actionKind !== 'battle_hit_assignment') return [];
  const ctxRaw = readContext(state);
  if (!ctxRaw) return [];
  const ctx = ctxRaw; // narrow for closures
  const region = state.regions[ctx.regionId];
  if (!region) return [];

  // Non-tipped, non-protected enemies only
  const enemies = followersInRegion(state, ctx.regionId).filter(f => {
    const ctrl = f.controlledBy ?? f.power;
    return ctrl !== attacker && !f.tipped && !f.protected;
  });

  // Group by (power, class). Use the controlling power for the key so
  // mind-controlled figures group with their controller.
  const groups = new Map<string, FollowerInstance[]>();
  for (const f of enemies) {
    const ctrl = f.controlledBy ?? f.power;
    const key = `${ctrl}|${f.class}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }

  const actions: BattleHitAssignmentAction[] = [];
  const seen = new Set<string>();

  function add(ids: string[], peasants = 0): void {
    if (actions.length >= MAX_ACTIONS) return;
    const sorted = [...ids].sort();
    const key = sorted.join(',') + '|' + peasants;
    if (seen.has(key)) return;
    seen.add(key);
    actions.push(
      peasants > 0
        ? {
            kind: 'battle_hit_assignment',
            power: attacker,
            regionId: ctx.regionId,
            followerIds: ids,
            peasantsToTake: peasants,
          }
        : {
            kind: 'battle_hit_assignment',
            power: attacker,
            regionId: ctx.regionId,
            followerIds: ids,
          },
    );
  }

  // Sort each group by id for determinism
  for (const members of groups.values()) {
    members.sort((a, b) => a.id.localeCompare(b.id));
  }

  // ── Single-group commits: kill K of one (power, class) ──────────────────
  // For each group, enumerate K = 1..maxAffordable.
  // We include all K because the model should be able to choose between
  // "kill 1 cultist (save hits)" vs "kill 3 cultists (commit hard)".
  const groupArr = Array.from(groups.values());
  for (const members of groupArr) {
    const def = effectiveDefense(state, ctx.regionId, members[0]!, attacker);
    if (def <= 0) continue;
    const maxKills = Math.min(members.length, Math.floor(ctx.hitsRemaining / def));
    for (let k = 1; k <= maxKills; k++) {
      add(members.slice(0, k).map(f => f.id));
    }
  }

  // ── Cross-group pair commits: K_a from group A + K_b from group B ───────
  // Limit to at most 2 of each to keep branching tight.
  for (let i = 0; i < groupArr.length; i++) {
    for (let j = i + 1; j < groupArr.length; j++) {
      const a = groupArr[i]!;
      const b = groupArr[j]!;
      const defA = effectiveDefense(state, ctx.regionId, a[0]!, attacker);
      const defB = effectiveDefense(state, ctx.regionId, b[0]!, attacker);
      if (defA <= 0 || defB <= 0) continue;
      const maxA = Math.min(a.length, 2);
      const maxB = Math.min(b.length, 2);
      for (let ka = 1; ka <= maxA; ka++) {
        for (let kb = 1; kb <= maxB; kb++) {
          if (ka * defA + kb * defB > ctx.hitsRemaining) break;
          add([...a.slice(0, ka), ...b.slice(0, kb)].map(f => f.id));
        }
      }
    }
  }

  // ── Take peasants with leftover hits ───────────────────────────────────
  // For each existing kill action, also generate a variant that claims
  // peasants with the unused hits.
  if (ctx.peasantsAvailable > 0) {
    const baseActions = [...actions];
    for (const a of baseActions) {
      let spent = 0;
      for (const id of a.followerIds) {
        const fig = enemies.find(e => e.id === id);
        if (fig) spent += effectiveDefense(state, ctx.regionId, fig, attacker);
      }
      const peasants = Math.min(ctx.hitsRemaining - spent, ctx.peasantsAvailable);
      if (peasants > 0) add(a.followerIds, peasants);
    }
    // Also "kill nothing, take peasants only"
    const peasantsOnly = Math.min(ctx.hitsRemaining, ctx.peasantsAvailable);
    if (peasantsOnly > 0) add([], peasantsOnly);
  }

  // Always include the empty pass action as a fallback
  if (actions.length === 0) {
    add([]);
  }

  return actions;
}
