import { useEffect, useRef, useState, useCallback } from 'react';
import type { GameState, Power, RegionId, PhaseEvent } from '@ruin/engine';

// ── Timing constants (ms) ────────────────────────────────────────────────────

const BEAT_REGION_START = 500;   // pause after highlighting region, before dice
const BEAT_ROLL         = 1000;  // pause after showing dice, before kills
const BEAT_KILL         = 500;   // per-kill pace
const BEAT_HIT_WAIT     = 200;   // acknowledgment of a pause for hit assignment
const BEAT_REGION_END   = 2000;  // pause before switching to the next region
const BEAT_DOMINATION   = 1500;  // pause at each dominated region
const BEAT_CORRUPTION   = 2750;  // matches the fly animation duration
const BEAT_RUINATION    = 1200;
const CORRUPTION_FLY_MS = 2750;

// ── Types ────────────────────────────────────────────────────────────────────

export type AnimationPhase = 'battle' | 'battle_continue' | 'corruption' | null;

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

export interface PhaseAnimationResult {
  /** The state to render. During animation, this is a frozen snapshot. */
  displayState: GameState;
  /** Current animation phase, or null if idle. */
  animationPhase: AnimationPhase;
  /** The phase event currently being displayed. */
  currentEvent: PhaseEvent | null;
  /** All phase events processed so far (for building battle panes). */
  processedEvents: PhaseEvent[];
  /** Region currently being animated. */
  activeRegion: RegionId | null;
  /** Figure IDs that have been killed in the current animation. */
  killedIds: Set<string>;
  /** Whether killed figures should be hidden entirely (vs shown with red glow). */
  hideKilled: boolean;
  /** Domination labels to display above regions: regionId → { power, vp }. */
  dominationLabels: Map<RegionId, DominationLabel>;
  /** Progressive corruption token counts to override display: regionId → power → count. */
  corruptionOverrides: Map<RegionId, Partial<Record<Power, number>>>;
  /** In-flight corruption token animations (flying circles). */
  corruptionFlies: CorruptionFlyEvent[];
  /** Call to advance past the Continue screen after battle. */
  onContinue: () => void;
  /** Whether a human decision is needed right now (show action panel). */
  needsDecision: boolean;
  /** The latest server state (for the action panel during decisions). */
  decisionState: GameState | null;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function usePhaseAnimation(
  serverState: GameState | null,
  phaseEvents: PhaseEvent[],
  myPowers: Power[],
): PhaseAnimationResult {
  // Snapshot: frozen display state from before battle started
  const [snapshot, setSnapshot] = useState<GameState | null>(null);
  const [animPhase, setAnimPhase] = useState<AnimationPhase>(null);

  // How far through the event buffer we've animated
  const [cursor, setCursor] = useState(0);
  const [currentEvent, setCurrentEvent] = useState<PhaseEvent | null>(null);
  const [processedEvents, setProcessedEvents] = useState<PhaseEvent[]>([]);
  const [activeRegion, setActiveRegion] = useState<RegionId | null>(null);
  const [killedIds, setKilledIds] = useState<Set<string>>(new Set());
  const [dominationLabels, setDominationLabels] = useState<Map<RegionId, DominationLabel>>(new Map());
  const [corruptionOverrides, setCorruptionOverrides] = useState<Map<RegionId, Partial<Record<Power, number>>>>(new Map());
  const [corruptionFlies, setCorruptionFlies] = useState<CorruptionFlyEvent[]>([]);
  const flyIdRef = useRef(0);

  // Track the latest server state for decisions and phase detection
  const latestServerState = useRef<GameState | null>(null);
  // Track the previous phase so we can detect fresh transitions into battle
  const prevPhase = useRef<string | null>(null);
  if (serverState !== latestServerState.current) {
    latestServerState.current = serverState;
  }

  // Track the full event buffer
  const eventBuffer = useRef<PhaseEvent[]>([]);

  // Whether we're paused waiting for a human decision
  const [waitingForDecision, setWaitingForDecision] = useState(false);

  // Timer ref
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Detect battle phase start ────────────────────────────────────────────
  // Trigger: state update with phase === 'battle' following a different phase.
  // The server broadcasts this intermediate state immediately after summoning
  // ends, before battle resolution runs. That's the state we snapshot.

  useEffect(() => {
    if (!serverState) return;
    const wasInDifferentPhase = prevPhase.current !== null && prevPhase.current !== 'battle';
    prevPhase.current = serverState.phase;
    if (animPhase !== null) return;
    if (serverState.phase === 'battle' && wasInDifferentPhase) {
      setSnapshot(serverState);
      setAnimPhase('battle');
      setCursor(eventBuffer.current.length);
      setProcessedEvents([]);
      setKilledIds(new Set());
      setActiveRegion(null);
      setCurrentEvent(null);
      setDominationLabels(new Map());
      setCorruptionOverrides(new Map());
      setCorruptionFlies([]);
      setWaitingForDecision(false);
    }
  }, [serverState, animPhase]);

  // Keep event buffer in sync
  useEffect(() => {
    eventBuffer.current = phaseEvents;
  }, [phaseEvents]);

  // ── Process next event with delay ────────────────────────────────────────

  const processNext = useCallback(() => {
    const events = eventBuffer.current;
    const idx = cursor;

    if (idx >= events.length) return;

    const evt = events[idx]!;
    const isCorruptionEvt = evt.type === 'domination_result' ||
                             evt.type === 'corruption_placement' ||
                             evt.type === 'corruption_ruination';

    // If we're in 'battle' and hit a corruption event, pause and show Continue button.
    // Do NOT advance cursor or process the event yet — that happens after user clicks.
    if (animPhase === 'battle' && isCorruptionEvt) {
      setAnimPhase('battle_continue');
      setActiveRegion(null); // Clear region highlight during the pause
      return;
    }

    // Apply event
    setCurrentEvent(evt);
    setProcessedEvents(prev => [...prev, evt]);

    switch (evt.type) {
      case 'battle_region_start':
        setActiveRegion(evt.regionId);
        break;
      case 'battle_roll':
        // Roll displayed in pane — no state change needed
        break;
      case 'battle_kill':
        setKilledIds(prev => new Set([...prev, evt.targetId]));
        break;
      case 'battle_hit_wait': {
        // Check if this is for a human player
        const isHuman = myPowers.includes(evt.power);
        if (isHuman) {
          setWaitingForDecision(true);
          setCursor(idx + 1);
          return; // Don't schedule next — wait for decision
        }
        break;
      }
      case 'battle_region_end':
        // Region done
        break;
      case 'domination_result':
        // Only highlight & label regions that actually had a dominator.
        // Tied / non-conquered regions are skipped visually.
        if (evt.power && evt.conquered) {
          setActiveRegion(evt.regionId);
          setDominationLabels(prev => {
            const next = new Map(prev);
            next.set(evt.regionId, { power: evt.power!, vp: evt.vp });
            return next;
          });
        } else {
          setActiveRegion(null);
        }
        break;
      case 'corruption_placement': {
        setActiveRegion(evt.regionId);
        // Spawn a fly animation
        const flyId = ++flyIdRef.current;
        setCorruptionFlies(prev => [...prev, {
          id: flyId,
          regionId: evt.regionId,
          power: evt.power,
          tokens: evt.tokens,
          startedAt: Date.now(),
        }]);
        // After fly animation finishes, increment the counter override and clean up
        setTimeout(() => {
          setCorruptionOverrides(prev => {
            const next = new Map(prev);
            const regionMap = { ...(next.get(evt.regionId) ?? {}) };
            regionMap[evt.power] = (regionMap[evt.power] ?? 0) + evt.tokens;
            next.set(evt.regionId, regionMap);
            return next;
          });
          setCorruptionFlies(prev => prev.filter(f => f.id !== flyId));
        }, CORRUPTION_FLY_MS);
        break;
      }
      case 'corruption_ruination':
        setActiveRegion(evt.regionId);
        break;
    }

    setCursor(idx + 1);
  }, [cursor, animPhase, myPowers]);

  // ── Animation timer ──────────────────────────────────────────────────────

  useEffect(() => {
    if (animPhase === null || animPhase === 'battle_continue') return;
    if (waitingForDecision) return;

    const events = eventBuffer.current;
    if (cursor >= events.length) return; // waiting for more events

    const nextEvt = events[cursor];
    if (!nextEvt) return;
    const prevEvt = cursor > 0 ? events[cursor - 1] : null;

    const delay = getDelay(nextEvt, prevEvt ?? null, myPowers);
    timerRef.current = setTimeout(processNext, delay);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [cursor, animPhase, waitingForDecision, processNext]);

  // ── Detect when battle is fully done (corruption events start arriving) ──

  useEffect(() => {
    if (animPhase !== 'battle') return;
    if (waitingForDecision) return;

    const events = eventBuffer.current;
    // If we've processed all battle events and next is corruption, show Continue
    if (cursor >= events.length) {
      // Check if server phase has moved past battle
      const srv = latestServerState.current;
      if (srv && srv.phase !== 'battle') {
        setAnimPhase('battle_continue');
      }
    }
  }, [cursor, animPhase, waitingForDecision, serverState]);

  // ── Detect when corruption animation is done ─────────────────────────────

  useEffect(() => {
    if (animPhase !== 'corruption') return;

    const events = eventBuffer.current;
    if (cursor >= events.length) {
      // Check if server is past corruption
      const srv = latestServerState.current;
      if (srv && srv.phase !== 'corruption' && srv.phase !== 'battle') {
        // Done — snap to server state and clear animation state
        setAnimPhase(null);
        setSnapshot(null);
        setActiveRegion(null);
        setKilledIds(new Set());
        setCurrentEvent(null);
        setProcessedEvents([]);
        setDominationLabels(new Map());
        setCorruptionOverrides(new Map());
        setCorruptionFlies([]);
      }
    }
  }, [cursor, animPhase, serverState]);

  // ── Detect any decision we need to make during animation ────────────────
  // Covers battle_hit_assignment and corruption_harvest_choice (Inevitable Rot).
  // Any pendingAction for one of our powers during an active animation pauses it.

  useEffect(() => {
    if (animPhase === null || animPhase === 'battle_continue') return;
    if (!serverState) return;
    const pa = serverState.pendingAction;
    const isOurDecision = pa != null && myPowers.includes(pa.waitingFor);
    if (isOurDecision && !waitingForDecision) {
      setWaitingForDecision(true);
    } else if (!isOurDecision && waitingForDecision) {
      // Decision resolved — resume animation. Do NOT update the snapshot:
      // the pre-battle state is what we want to keep showing. Kills are
      // tracked visually via killedIds driven by phase events.
      setWaitingForDecision(false);
    }
  }, [serverState, waitingForDecision, myPowers, animPhase]);

  // ── Continue callback ────────────────────────────────────────────────────

  const onContinue = useCallback(() => {
    if (animPhase === 'battle_continue') {
      // Apply kills to the snapshot — remove tipped figures from their regions
      // and clear them from power follower lists.
      if (snapshot && killedIds.size > 0) {
        const newRegions = { ...snapshot.regions };
        for (const rid of Object.keys(newRegions) as RegionId[]) {
          const region = newRegions[rid]!;
          if (region.placements.some(f => killedIds.has(f.id))) {
            newRegions[rid] = {
              ...region,
              placements: region.placements.filter(f => !killedIds.has(f.id)),
            };
          }
        }
        const newPowers = { ...snapshot.powers };
        for (const p of Object.keys(newPowers) as Power[]) {
          const ps = newPowers[p]!;
          if (ps.followers.some(f => killedIds.has(f.id))) {
            newPowers[p] = {
              ...ps,
              followers: ps.followers.map(f =>
                killedIds.has(f.id)
                  ? { ...f, regionId: null, tipped: false, controlledBy: null }
                  : f,
              ),
            };
          }
        }
        setSnapshot({ ...snapshot, regions: newRegions, powers: newPowers });
      }
      setKilledIds(new Set());
      setActiveRegion(null);
      setAnimPhase('corruption');
      // Cursor still points at the first corruption event — the timer effect will pick it up
    }
  }, [animPhase, snapshot, killedIds]);

  // ── Build result ─────────────────────────────────────────────────────────

  const isAnimating = animPhase !== null;
  const displayState = isAnimating && snapshot ? snapshot : (serverState ?? null);
  const needsDecision = waitingForDecision && serverState?.pendingAction != null;

  return {
    displayState: displayState!,
    animationPhase: animPhase,
    currentEvent,
    processedEvents,
    activeRegion,
    killedIds,
    hideKilled: animPhase === 'corruption',
    dominationLabels,
    corruptionOverrides,
    corruptionFlies,
    onContinue,
    needsDecision,
    decisionState: needsDecision ? serverState : null,
  };
}

// ── Delay lookup ───────────────────────────────────────────────────────────

const FAST_DELAY = 100;

function isOwnEvent(event: PhaseEvent, myPowers: Power[]): boolean {
  if (event.type === 'battle_roll' || event.type === 'battle_hit_wait') {
    return myPowers.includes(event.power);
  }
  if (event.type === 'battle_kill') {
    return myPowers.includes(event.attacker as Power);
  }
  return false;
}

/**
 * How long to wait before showing `next`, given the previously-shown event.
 * The delay is the "gap" between two events in the animation sequence.
 */
function getDelay(next: PhaseEvent, prev: PhaseEvent | null, myPowers: Power[]): number {
  // Your own actions animate instantly — you already know what you did.
  if (isOwnEvent(next, myPowers)) return FAST_DELAY;

  switch (next.type) {
    case 'battle_region_start':
      // Pause before switching to the next region (but not the first one).
      return prev === null ? 0 : BEAT_REGION_END;
    case 'battle_roll':
      // Pause after highlighting the region, before revealing dice.
      return BEAT_REGION_START;
    case 'battle_kill':
      // Longer pause after the roll before the first kill; shorter between kills.
      return prev?.type === 'battle_roll' ? BEAT_ROLL : BEAT_KILL;
    case 'battle_hit_wait':
      return BEAT_HIT_WAIT;
    case 'battle_region_end':
      return 0;
    case 'domination_result':
      // Non-conquered domination (tied or no dominator) is a nothing-happened
      // beat — don't linger on it.
      return (next.power && next.conquered) ? BEAT_DOMINATION : FAST_DELAY;
    case 'corruption_placement':
      if (prev?.type === 'corruption_placement') {
        // Same region: quick succession (let flies overlap).
        if (prev.regionId === next.regionId) return 400;
        // Region switch: wait for prior region's flies to finish incrementing,
        // then pause 1s before moving on.
        return CORRUPTION_FLY_MS + 1000;
      }
      return 500;
    case 'corruption_ruination':
      // If coming from placements in this region, wait for flies to land first.
      if (prev?.type === 'corruption_placement' && prev.regionId === next.regionId) {
        return CORRUPTION_FLY_MS + 500;
      }
      return BEAT_RUINATION;
    default:
      return 300;
  }
}
