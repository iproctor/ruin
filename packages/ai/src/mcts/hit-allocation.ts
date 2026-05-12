import type {
  GameState,
  BattleHitAssignmentAction,
  FollowerInstance,
  Power,
  RegionId,
} from '@ruin/engine';
import { followersInRegion, effectiveDefense, isBattleHitAssignmentLegal } from '@ruin/engine';

/**
 * Enumerate hit-assignment actions at a battle_hit_assignment decision point.
 *
 * The engine's `enumerateBattleHitStrategies` only returns 3 hand-picked
 * strategies. MCTS wants a richer per-(power, class) action space so it can
 * ask "which group should I commit kills against?" — but every action it sees
 * must be legal, since the engine throws on underallocated assignments.
 *
 * Approach: enumerate strategic "intents" (commit K of one group; ka of A +
 * kb of B), then greedily complete each by taking peasants up to availability
 * and killing the cheapest remaining enemy until no further hit can be spent.
 * The completion step guarantees every emitted action satisfies the engine's
 * full-allocation predicate.
 *
 * Cap on total actions ~30 to keep MCTS branching tractable.
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
  const ctx = ctxRaw;
  const region = state.regions[ctx.regionId];
  if (!region) return [];

  // Non-tipped, non-protected enemies only
  const enemies = followersInRegion(state, ctx.regionId).filter(f => {
    const ctrl = f.controlledBy ?? f.power;
    return ctrl !== attacker && !f.tipped && !f.protected;
  });

  // Per-enemy defense, cached for the duration of enumeration (state is
  // immutable here).
  const defOf = new Map<string, number>();
  for (const e of enemies) defOf.set(e.id, effectiveDefense(state, ctx.regionId, e, attacker));

  // Group by (power, class). Use the controlling power for the key so
  // mind-controlled figures group with their controller.
  const groups = new Map<string, FollowerInstance[]>();
  for (const f of enemies) {
    const ctrl = f.controlledBy ?? f.power;
    const key = `${ctrl}|${f.class}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  // Sort each group by id for determinism
  for (const members of groups.values()) {
    members.sort((a, b) => a.id.localeCompare(b.id));
  }
  const groupArr = Array.from(groups.values());

  const actions: BattleHitAssignmentAction[] = [];
  const seen = new Set<string>();

  /**
   * Take a strategic "intent" (which enemies to kill first) and greedily
   * complete it: spend peasants up to availability, then kill the cheapest
   * remaining enemy that fits in the budget, until no further hit can be
   * spent. The result is always legal per isBattleHitAssignmentLegal.
   */
  function addIntent(intent: string[]): void {
    if (actions.length >= MAX_ACTIONS) return;
    const killed = new Set<string>();
    let spent = 0;
    for (const id of intent) {
      const def = defOf.get(id);
      if (def === undefined) continue;
      if (spent + def > ctx.hitsRemaining) continue;
      killed.add(id);
      spent += def;
    }
    // Peasants first (up to availability, up to remaining budget).
    const peasants = Math.min(ctx.peasantsAvailable, ctx.hitsRemaining - spent);
    spent += peasants;
    // Then cheapest remaining enemy, repeat.
    const remaining = enemies
      .filter(e => !killed.has(e.id))
      .map(e => ({ id: e.id, def: defOf.get(e.id) ?? 0 }))
      .filter(e => e.def > 0)
      .sort((a, b) => a.def - b.def);
    for (const e of remaining) {
      if (spent + e.def > ctx.hitsRemaining) continue;
      killed.add(e.id);
      spent += e.def;
    }

    const followerIds = [...killed].sort();
    const key = followerIds.join(',') + '|' + peasants;
    if (seen.has(key)) return;
    seen.add(key);
    actions.push(
      peasants > 0
        ? { kind: 'battle_hit_assignment', power: attacker, regionId: ctx.regionId, followerIds, peasantsToTake: peasants }
        : { kind: 'battle_hit_assignment', power: attacker, regionId: ctx.regionId, followerIds },
    );
  }

  // ── Pure greedy (no committed intent) ───────────────────────────────────
  addIntent([]);

  // ── Single-group commits: kill K of one (power, class) ──────────────────
  for (const members of groupArr) {
    const def = defOf.get(members[0]!.id) ?? 0;
    if (def <= 0) continue;
    const maxKills = Math.min(members.length, Math.floor(ctx.hitsRemaining / def));
    for (let k = 1; k <= maxKills; k++) {
      addIntent(members.slice(0, k).map(f => f.id));
    }
  }

  // ── Cross-group pair commits: K_a from group A + K_b from group B ───────
  // Limit to at most 2 of each to keep branching tight.
  for (let i = 0; i < groupArr.length; i++) {
    for (let j = i + 1; j < groupArr.length; j++) {
      const a = groupArr[i]!;
      const b = groupArr[j]!;
      const defA = defOf.get(a[0]!.id) ?? 0;
      const defB = defOf.get(b[0]!.id) ?? 0;
      if (defA <= 0 || defB <= 0) continue;
      const maxA = Math.min(a.length, 2);
      const maxB = Math.min(b.length, 2);
      for (let ka = 1; ka <= maxA; ka++) {
        for (let kb = 1; kb <= maxB; kb++) {
          if (ka * defA + kb * defB > ctx.hitsRemaining) break;
          addIntent([...a.slice(0, ka), ...b.slice(0, kb)].map(f => f.id));
        }
      }
    }
  }

  if (actions.length === 0) {
    actions.push({ kind: 'battle_hit_assignment', power: attacker, regionId: ctx.regionId, followerIds: [] });
  }

  // Safety net — if a strategic intent somehow produced an illegal action
  // (state-dependent effects we didn't model), keep the engine-legal subset.
  // After the greedy fixup this should be a no-op in practice.
  const pendingCtx = state.pendingAction?.context;
  const filtered = actions.filter(a => isBattleHitAssignmentLegal(state, a, pendingCtx));
  return filtered.length > 0 ? filtered : actions;
}
