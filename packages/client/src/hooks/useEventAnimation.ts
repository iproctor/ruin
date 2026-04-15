import { useEffect, useRef, useState, useCallback } from 'react';
import type { GameState, Power, RegionId, GameEvent, Phase } from '@ruin/engine';

// ── Constants ────────────────────────────────────────────────────────────────

const CORRUPTION_FLY_MS = 1100;
const FIGURE_ANIM_MS = 800;
const CARD_ANIM_MS = 800;
const BANNER_MS = 1500;

const PHASE_LABELS: Partial<Record<Phase, string>> = {
  world: 'WORLD',
  draw: 'DRAW',
  summoning: 'SUMMONING',
  battle: 'BATTLE',
  corruption: 'CORRUPTION',
  end: 'END',
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface DominationLabel {
  power: Power;
  vp: number;
}

export interface CorruptionFlyEvent {
  id: number;
  regionId: RegionId;
  power: Power;
  tokens: number;
  startedAt: number;
}

export interface EventAnimationResult {
  // ── Phase banner ──
  phaseBanner: string | null;

  // ── Summoning animations ──
  appearingFigures: Set<string>;
  movingFigures: Map<string, { fromRegion: RegionId; toRegion: RegionId }>;
  appearingCards: Set<string>;

  // ── Battle / corruption ──
  animationPhase: 'battle' | 'corruption' | null;
  activeRegion: RegionId | null;
  killedIds: Set<string>;
  hideKilled: boolean;
  processedBattleEvents: GameEvent[];
  dominationLabels: Map<RegionId, DominationLabel>;
  corruptionOverrides: Map<RegionId, Partial<Record<Power, number>>>;
  corruptionFlies: CorruptionFlyEvent[];

  // ── Display state (snapshot during battle/corruption, server state otherwise) ──
  displayState: GameState;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useEventAnimation(
  serverState: GameState | null,
  lastEvent: GameEvent | null,
  myPowers: Power[],
): EventAnimationResult {
  // ── Phase banner ──
  const [phaseBanner, setPhaseBanner] = useState<string | null>(null);

  // ── Summoning ──
  const [appearingFigures, setAppearingFigures] = useState<Set<string>>(new Set());
  const [movingFigures, setMovingFigures] = useState<Map<string, { fromRegion: RegionId; toRegion: RegionId }>>(new Map());
  const [appearingCards, setAppearingCards] = useState<Set<string>>(new Set());

  // ── Battle / corruption ──
  const [animPhase, setAnimPhase] = useState<'battle' | 'corruption' | null>(null);
  const [activeRegion, setActiveRegion] = useState<RegionId | null>(null);
  const [killedIds, setKilledIds] = useState<Set<string>>(new Set());
  const [processedBattleEvents, setProcessedBattleEvents] = useState<GameEvent[]>([]);
  const [dominationLabels, setDominationLabels] = useState<Map<RegionId, DominationLabel>>(new Map());
  const [corruptionOverrides, setCorruptionOverrides] = useState<Map<RegionId, Partial<Record<Power, number>>>>(new Map());
  const [corruptionFlies, setCorruptionFlies] = useState<CorruptionFlyEvent[]>([]);
  const flyIdRef = useRef(0);
  const initializedAnimPhase = useRef(false);

  // Bootstrap animPhase from server state on first load so that a refresh
  // mid-battle still treats subsequent streamed events as battle/corruption
  // animations (otherwise the UI gates them out and they appear instantly).
  useEffect(() => {
    if (initializedAnimPhase.current || !serverState) return;
    initializedAnimPhase.current = true;
    if (serverState.phase === 'battle') setAnimPhase('battle');
    else if (serverState.phase === 'corruption') setAnimPhase('corruption');
  }, [serverState]);

  // ── Helpers ──

  const isOwnAction = (ev: GameEvent) =>
    'power' in ev && myPowers.includes((ev as { power: Power }).power);

  const clearBattleState = () => {
    setAnimPhase(null);
    setActiveRegion(null);
    setKilledIds(new Set());
    setProcessedBattleEvents([]);
    setDominationLabels(new Map());
    setCorruptionOverrides(new Map());
    setCorruptionFlies([]);
  };

  // ── Timed cleanup helper ──

  const expireAfter = <T,>(
    setter: React.Dispatch<React.SetStateAction<Set<T>>>,
    value: T,
    ms: number,
  ) => {
    setter(prev => new Set([...prev, value]));
    setTimeout(() => setter(prev => { const n = new Set(prev); n.delete(value); return n; }), ms);
  };

  const expireMapAfter = <K, V>(
    setter: React.Dispatch<React.SetStateAction<Map<K, V>>>,
    key: K,
    value: V,
    ms: number,
  ) => {
    setter(prev => new Map([...prev, [key, value]]));
    setTimeout(() => setter(prev => { const n = new Map(prev); n.delete(key); return n; }), ms);
  };

  // ── Process each event ────────────────────────────────────────────────────

  useEffect(() => {
    if (!lastEvent) return;

    // ── Phase banner ──
    if (lastEvent.type === 'phase_start') {
      const label = PHASE_LABELS[lastEvent.phase];
      if (label) {
        setPhaseBanner(label);
        setTimeout(() => setPhaseBanner(null), BANNER_MS);
      }

      // Phase transitions for battle/corruption animation
      if (lastEvent.phase === 'battle') {
        setAnimPhase('battle');
        setProcessedBattleEvents([]);
        setKilledIds(new Set());
        setActiveRegion(null);
        setDominationLabels(new Map());
        setCorruptionOverrides(new Map());
        setCorruptionFlies([]);
      } else if (lastEvent.phase === 'corruption') {
        setAnimPhase('corruption');
        setProcessedBattleEvents([]);
        setActiveRegion(null);
      } else if (lastEvent.phase === 'end' || lastEvent.phase === 'summoning' || lastEvent.phase === 'world' || lastEvent.phase === 'draw') {
        clearBattleState();
      }
      return;
    }

    // ── Summoning animations (other players only) ──
    if (!isOwnAction(lastEvent)) {
      if (lastEvent.type === 'summon_figure') {
        if (lastEvent.fromRegion === null) {
          expireAfter(setAppearingFigures, lastEvent.followerId, FIGURE_ANIM_MS);
        } else {
          expireMapAfter(setMovingFigures, lastEvent.followerId, { fromRegion: lastEvent.fromRegion, toRegion: lastEvent.toRegion }, FIGURE_ANIM_MS);
        }
      }
      if (lastEvent.type === 'play_card') {
        expireAfter(setAppearingCards, `${lastEvent.toRegion}-${lastEvent.slotIndex}`, CARD_ANIM_MS);
      }
      if (lastEvent.type === 'card_effect' && (lastEvent.subtype === 'call_to_war' || lastEvent.subtype === 'teleport')) {
        const id = 'followerId' in lastEvent ? (lastEvent as { followerId: string }).followerId : null;
        if (id) {
          const from = (lastEvent as { fromRegion: RegionId }).fromRegion;
          const to = (lastEvent as { toRegion: RegionId }).toRegion;
          expireMapAfter(setMovingFigures, id, { fromRegion: from, toRegion: to }, FIGURE_ANIM_MS);
        }
      }
    }

    // ── Battle events ──
    if (animPhase === 'battle' || animPhase === 'corruption') {
      setProcessedBattleEvents(prev => [...prev, lastEvent]);
    }

    switch (lastEvent.type) {
      case 'battle_region_start':
        setActiveRegion(lastEvent.regionId);
        break;
      case 'battle_kill':
        setKilledIds(prev => new Set([...prev, lastEvent.targetId]));
        break;
      case 'domination_result':
        if (lastEvent.power && lastEvent.conquered) {
          setActiveRegion(lastEvent.regionId);
          setDominationLabels(prev => {
            const next = new Map(prev);
            next.set(lastEvent.regionId, { power: lastEvent.power!, vp: lastEvent.vp });
            return next;
          });
        } else {
          setActiveRegion(null);
        }
        break;
      case 'corruption_placement': {
        setActiveRegion(lastEvent.regionId);
        const flyId = ++flyIdRef.current;
        setCorruptionFlies(prev => [...prev, {
          id: flyId,
          regionId: lastEvent.regionId,
          power: lastEvent.power,
          tokens: lastEvent.tokens,
          startedAt: Date.now(),
        }]);
        setTimeout(() => {
          setCorruptionOverrides(prev => {
            const next = new Map(prev);
            const regionMap = { ...(next.get(lastEvent.regionId) ?? {}) };
            regionMap[lastEvent.power] = (regionMap[lastEvent.power] ?? 0) + lastEvent.tokens;
            next.set(lastEvent.regionId, regionMap);
            return next;
          });
          setCorruptionFlies(prev => prev.filter(f => f.id !== flyId));
        }, CORRUPTION_FLY_MS);
        break;
      }
      case 'ruination':
        setActiveRegion(lastEvent.regionId);
        break;
    }
  }, [lastEvent]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Result ────────────────────────────────────────────────────────────────

  const isAnimating = animPhase !== null;
  const displayState = serverState ?? null;

  return {
    phaseBanner,
    appearingFigures,
    movingFigures,
    appearingCards,
    animationPhase: animPhase,
    activeRegion,
    killedIds,
    hideKilled: animPhase === 'corruption',
    processedBattleEvents,
    dominationLabels,
    corruptionOverrides,
    corruptionFlies,
    displayState: displayState!,
  };
}
