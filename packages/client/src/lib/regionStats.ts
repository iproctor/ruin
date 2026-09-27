import type { GameState, Power, RegionId, TokenType } from '@ruin/engine';
import {
  getPowerDomination,
  getRegionDomination,
  getRegionResistance,
  previewDialAdvancementEarners,
  projectedCorruptionPlacement,
} from '@ruin/engine';

const ALL: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

export interface RegionStats {
  resistance: number;
  value: number;
  ruined: boolean;
  populous: boolean;
  /** Current domination leader and value, if anyone dominates. */
  leader: { power: Power; value: number } | null;
  /** Otherwise the strongest contender and how far short they fall. */
  contender: { power: Power; short: number } | null;
  corruption: number;              // tokens + chaos stones
  incoming: number;                // projected placement this corruption phase
  danger: boolean;                 // corruption + incoming ≥ 12
  topRuiner: Power | null;
  corruptionByPower: Record<Power, number>;
  dacEarners: Power[];
  tokenCounts: Map<TokenType, number>;
}

/** Everything the board shows about a region, computed once from the engine. */
export function regionStats(state: GameState, regionId: RegionId): RegionStats {
  const region = state.regions[regionId]!;
  const tokenCounts = new Map<TokenType, number>();
  for (const t of region.tokens) tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
  const resistance = getRegionResistance(state, regionId);
  const value = region.conquestValue + (tokenCounts.get('noble') ?? 0);
  const ruined = region.ruinationCardIndex !== null;
  const corruption = (Object.values(region.corruptionTokens) as number[]).reduce((a, b) => a + b, 0) + (tokenCounts.get('chaos_stone') ?? 0);
  const projected = {} as Record<Power, number>;
  for (const p of ALL) projected[p] = projectedCorruptionPlacement(state, regionId, p);
  const incoming = ALL.reduce((a, p) => a + projected[p], 0);

  let topRuiner: Power | null = null;
  let topCount = 0;
  for (const p of ALL) {
    const n = (region.corruptionTokens[p] ?? 0) + projected[p];
    if (n > topCount) { topCount = n; topRuiner = p; }
  }

  const dom = getRegionDomination(state, regionId);
  let leader: RegionStats['leader'] = null;
  let contender: RegionStats['contender'] = null;
  if (dom.leader) leader = { power: dom.leader, value: dom.value };
  else {
    let best: Power | null = null;
    let bestDom = 0;
    for (const p of ALL) {
      const d = getPowerDomination(state, regionId, p);
      if (d > bestDom) { bestDom = d; best = p; }
    }
    if (best && bestDom > 0) contender = { power: best, short: bestDom - resistance - 1 };
  }

  return {
    resistance,
    value,
    ruined,
    populous: region.populous,
    leader,
    contender,
    corruption,
    incoming,
    danger: corruption + incoming >= 12,
    topRuiner,
    corruptionByPower: region.corruptionTokens,
    dacEarners: ruined ? [] : previewDialAdvancementEarners(state, regionId),
    tokenCounts,
  };
}
