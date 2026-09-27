import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import type { Power, Action, RegionId, FollowerClass, GameState, GameEvent } from '@ruin/engine';
import type { DragItem } from '../types/drag.js';
import { applyAction, applyActionForPreview, getLegalActions, CARD_BY_ID, CHAOS_CARDS, REGIONS } from '@ruin/engine';
import { useAuth } from '../contexts/AuthContext.js';
import { GameProvider, useGame } from '../contexts/GameContext.js';
import { useGameStream } from '../hooks/useGameStream.js';
import { useEventAnimation } from '../hooks/useEventAnimation.js';
import { getGame, submitAction, submitActions, sendChat, leaveGame } from '../api/client.js';
import GameBoard from '../components/GameBoard.js';
import GameCard from '../components/cards/GameCard.js';
import { followerArt } from '../lib/art.js';
import StatusBar from '../components/StatusBar.js';
import Tableau from '../components/Tableau.js';
import LogPanel from '../components/LogPanel.js';
import ActionPanel, { CardOnPlayChoicePanel } from '../components/ActionPanel.js';
import { POWER_COLORS, POWER_LABELS } from '../lib/display.js';
import { eventDuration } from '../lib/timing.js';
import { useSettings, SPEED_FACTOR } from '../contexts/SettingsContext.js';
import { SoundProvider } from '../contexts/SoundContext.js';
import { FxProvider } from '../components/fx/FxProvider.js';
import CinematicLayer from '../components/cinematics/CinematicLayer.js';
import { INK, SOOT, PARCHMENT, BORDER, BORDER_HI, PAPER, PAPER_DIM, PAPER_FADE, BRASS, BRASS_DIM, CARD_FACE, CARD_INK, RUINED, ERROR } from '../lib/gameColors.js';
import './GamePage.css';

// ── Drag data types ────────────────────────────────────────────────────────────

export type { DragItem } from '../types/drag.js';

// ── useClampedPopupPosition — keep floating popups on screen ─────────────────
// Measures the popup after render and, if its preferred top/left would spill
// past the viewport, flips it above the anchor or clamps it to the edge.

function useClampedPopupPosition(anchorX: number | null, anchorY: number | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; ready: boolean }>(
    { top: 0, left: 0, ready: false },
  );

  useLayoutEffect(() => {
    if (anchorX == null || anchorY == null) {
      setPos((prev) => (prev.ready ? { top: 0, left: 0, ready: false } : prev));
      return;
    }
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    let top = anchorY + 6;
    let left = anchorX + 6;
    if (top + height > window.innerHeight - margin) {
      const above = anchorY - height - 6;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - height - margin);
    }
    if (left + width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - width - margin);
    }
    setPos((prev) =>
      prev.top === top && prev.left === left && prev.ready ? prev : { top, left, ready: true },
    );
  }, [anchorX, anchorY]);

  return { ref, pos };
}

// ── DragGhost — what renders under the cursor while dragging ──────────────────

function DragGhost({ item }: { item: DragItem }) {
  const color = POWER_COLORS[item.power];
  if (item.kind === 'hand_card') {
    return (
      <div style={{ pointerEvents: 'none', transform: 'rotate(-4deg) scale(1.05)', filter: `drop-shadow(0 12px 24px rgba(0,0,0,0.8)) drop-shadow(0 0 14px ${color})` }}>
        <GameCard cardId={item.cardId} size="sm" />
      </div>
    );
  }
  const art = followerArt(item.power, item.followerClass);
  const size = item.followerClass === 'incarnation' ? 60 : item.followerClass === 'warrior' ? 50 : 42;
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: art ? `#120d0a url(${art}) center 25% / cover` : color,
      boxShadow: `0 0 0 2px #0a0604, 0 0 0 4px ${color}, 0 0 22px ${color}, 0 10px 20px rgba(0,0,0,0.8)`,
      pointerEvents: 'none',
    }} />
  );
}

// ── Collapsible log wrapper ──────────────────────────────────────────────────

function CollapsibleLog(props: {
  events: import('@ruin/engine').GameEvent[];
  chat: import('../hooks/useGameStream.js').ChatMessage[];
  onSendChat: (message: string) => Promise<void>;
  connected: boolean;
  players: import('../api/client.js').GamePlayerInfo[];
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'row',
      minHeight: 0,
      flexShrink: 0,
    }}>
      {/* Toggle tab */}
      <button
        onClick={() => setCollapsed(c => !c)}
        style={{
          width: 20,
          background: SOOT,
          border: `1px solid ${BORDER}`,
          borderRight: 'none',
          borderRadius: '16px 0 0 16px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: PAPER_FADE,
          fontSize: '0.6rem',
          flexShrink: 0,
          padding: 0,
        }}
        title={collapsed ? 'Show log' : 'Hide log'}
      >
        {collapsed ? '◂' : '▸'}
      </button>

      {/* Log panel */}
      {!collapsed && (
        <div style={{ width: 260, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <LogPanel {...props} />
        </div>
      )}
    </div>
  );
}

// ── GameInner ─────────────────────────────────────────────────────────────────

interface GameInnerProps {
  gameId: string;
  myPowers: Power[];
  players: import('../api/client.js').GamePlayerInfo[];
  isMultiplayer: boolean;
}

/** Find a follower by ID across all powers. */
function findFollower(state: GameState, followerId: string) {
  for (const power of state.activePowers) {
    const f = state.powers[power]!.followers.find(f => f.id === followerId);
    if (f) return f;
  }
  return null;
}

function GameInner({ gameId, myPowers, players, isMultiplayer }: GameInnerProps) {
  const { state: serverState, setState } = useGame();
  const { settings } = useSettings();
  const timingRef = useRef({ myPowers, cinematics: settings.cinematics, speed: SPEED_FACTOR[settings.animSpeed] });
  timingRef.current = { myPowers, cinematics: settings.cinematics, speed: SPEED_FACTOR[settings.animSpeed] };
  const durationFor = useCallback((ev: GameEvent) => eventDuration(ev, timingRef.current), []);
  const { state: streamState, events, lastEvent, chat, connected, syncAfterAction, paused, resume, subscribe } = useGameStream(gameId, { eventDuration: durationFor });

  const [pendingAction, setPendingAction]         = useState<Action | null>(null);
  const [pendingOnPlayChoice, setPendingOnPlayChoice] = useState<Action | null>(null);
  const [selectedCardId, setSelectedCardId]       = useState<string | null>(null);
  const [submitError, setSubmitError]             = useState('');
  const [submitting, setSubmitting]               = useState(false);
  const [activeDrag, setActiveDrag]               = useState<DragItem | null>(null);

  // Merge SSE state; clear pending action if phase changed or it's no longer our turn
  useEffect(() => {
    if (!streamState) return;
    setState(streamState);
    const actingPower = streamState.pendingAction?.waitingFor;
    const stillMyTurn =
      actingPower !== undefined &&
      myPowers.includes(actingPower) &&
      streamState.phase === 'summoning';
    if (!stillMyTurn) {
      setPendingAction(null);
      setPendingOnPlayChoice(null);
      setSelectedCardId(null);
    }
  }, [streamState, myPowers, setState]);

  // displayState = serverState + pendingAction (+ pendingOnPlayChoice if set)
  // Use applyActionForPreview (no autoAdvance) so the tableau shows the immediate
  // board/PP changes without racing through battle → corruption → end phases.
  const displayState = useMemo(() => {
    if (!serverState) return null;
    let s = serverState;
    if (pendingAction) {
      try { s = applyActionForPreview(s, pendingAction).state; } catch { /* ignore */ }
    }
    if (pendingOnPlayChoice) {
      try { s = applyActionForPreview(s, pendingOnPlayChoice).state; } catch { /* ignore */ }
    }
    return s;
  }, [serverState, pendingAction, pendingOnPlayChoice]);

  // Phase animation — buffers phase events and drives battle/corruption animation
  const anim = useEventAnimation(serverState, lastEvent, myPowers);
  // When animating, use the animation's display state; otherwise use the normal one
  const effectiveDisplay = anim.animationPhase ? anim.displayState : displayState;

  // myPower: hoisted before validDropRegions (a memo) so both run in the hooks section.
  // If a buffered action exists, lock to that power; otherwise use server's acting player.
  const myPowerEarly: Power | null = pendingAction
    ? (pendingAction as { power: Power }).power
    : (serverState?.pendingAction?.waitingFor && myPowers.includes(serverState.pendingAction.waitingFor))
      ? serverState.pendingAction.waitingFor
      : null;

  // Valid drop target regions — derived from getLegalActions so placement rules are respected
  const validDropRegions = useMemo((): Set<RegionId> | null => {
    if (!activeDrag || !displayState || !myPowerEarly) return null;

    if (activeDrag.kind === 'hand_card') {
      // Free-play humans have a masked hand ('?' entries). Substitute the
      // power's full roster so getLegalActions can enumerate plays for the
      // dragged cardId; the server accepts '?' as a fallback when applying.
      const me = displayState.powers[myPowerEarly];
      const freePlay = !!displayState.companionOptions?.humanPlaysFree
        && me?.playerType === 'human';
      const enumerationState = freePlay && me
        ? {
            ...displayState,
            powers: {
              ...displayState.powers,
              [myPowerEarly]: {
                ...me,
                hand: CHAOS_CARDS.filter((c) => c.power === myPowerEarly).map((c) => c.id),
              },
            },
          }
        : displayState;
      const legal = getLegalActions(enumerationState, myPowerEarly);
      return new Set(
        legal
          .filter(a => a.kind === 'summoning_play_card' && a.cardId === activeDrag.cardId)
          .map(a => (a as { toRegion: RegionId }).toRegion)
      );
    }

    // For follower drags, find legal actions for any equivalent follower (same
    // class, source region, protected, controlledBy).  getLegalActions deduplicates
    // identical followers so the dragged figure's ID may not appear directly.
    if (activeDrag.kind === 'reserve_follower' || activeDrag.kind === 'board_follower') {
      const legal = getLegalActions(displayState, myPowerEarly);
      const dragged = findFollower(displayState, activeDrag.followerId);
      if (!dragged) return null;
      return new Set(
        legal
          .filter((a) => {
            if (a.kind !== 'summoning_summon_figure') return false;
            const rep = findFollower(displayState, a.followerId);
            return rep && rep.class === dragged.class
              && rep.regionId === dragged.regionId
              && rep.protected === dragged.protected
              && (rep.controlledBy ?? rep.power) === (dragged.controlledBy ?? dragged.power);
          })
          .map((a) => (a as { toRegion: RegionId }).toRegion)
      );
    }

    return null;
  }, [activeDrag, displayState, myPowerEarly]);

  const highlightRegions = validDropRegions
    ? (Object.keys(displayState?.regions ?? {}) as RegionId[])
        .filter((r) => validDropRegions.has(r))
    : undefined;

  const dimmedRegions = validDropRegions
    ? (Object.keys(displayState?.regions ?? {}) as RegionId[])
        .filter((r) => !validDropRegions.has(r))
    : undefined;

  // ── Play-card popup (click-to-play from hand via slot) ───────────────────
  const [slotPopup, setSlotPopup] = useState<
    { regionId: RegionId; slotIndex: 0 | 1; x: number; y: number } | null
  >(null);

  // All legal summoning_play_card actions for myPower right now — used both
  // to decide if a slot is clickable and to fill the popup dropdown.
  // Only meaningful during a player's summoning turn; guard getLegalActions
  // which throws for non-enumerable action kinds (battle hit assignment, etc).
  const legalPlayCardActions = useMemo(() => {
    if (!displayState || !myPowerEarly) return [];
    if (displayState.pendingAction?.actionKind !== 'summoning_action') return [];

    // Free-play humans have a masked hand ('?' entries) in the engine but
    // physically hold a real hand. Pretend the engine sees one of every
    // card in their power's deck so slot-click offers the full roster; the
    // server's play validation accepts the '?' fallback when the chosen
    // card isn't literally in the masked hand.
    const me = displayState.powers[myPowerEarly];
    const freePlay = !!displayState.companionOptions?.humanPlaysFree
      && me?.playerType === 'human';
    const enumerationState = freePlay && me
      ? {
          ...displayState,
          powers: {
            ...displayState.powers,
            [myPowerEarly]: {
              ...me,
              hand: CHAOS_CARDS.filter((c) => c.power === myPowerEarly).map((c) => c.id),
            },
          },
        }
      : displayState;

    return getLegalActions(enumerationState, myPowerEarly)
      .filter((a) => a.kind === 'summoning_play_card') as Array<
        Extract<Action, { kind: 'summoning_play_card' }>
      >;
  }, [displayState, myPowerEarly]);

  const slotPlayable = useCallback(
    (regionId: RegionId, slotIndex: 0 | 1) =>
      legalPlayCardActions.some((a) => a.toRegion === regionId && a.slotIndex === slotIndex),
    [legalPlayCardActions],
  );

  const handleSlotClick = useCallback(
    (regionId: RegionId, slotIndex: 0 | 1, x: number, y: number) => {
      setSlotPopup({ regionId, slotIndex, x, y });
    },
    [],
  );

  // Deduped list of cards playable in the currently-open slot, sorted the
  // same way the hand is (cost asc, then short/name).
  const slotChoices = useMemo(() => {
    if (!slotPopup) return [];
    const ids = new Set<string>();
    const list: string[] = [];
    for (const a of legalPlayCardActions) {
      if (a.toRegion !== slotPopup.regionId || a.slotIndex !== slotPopup.slotIndex) continue;
      if (ids.has(a.cardId)) continue;
      ids.add(a.cardId);
      list.push(a.cardId);
    }
    list.sort((a, b) => {
      const ca = CARD_BY_ID[a];
      const cb = CARD_BY_ID[b];
      const costA = ca?.cost ?? 0;
      const costB = cb?.cost ?? 0;
      if (costA !== costB) return costA - costB;
      const nameA = ca?.shortName ?? ca?.name ?? a;
      const nameB = cb?.shortName ?? cb?.name ?? b;
      return nameA.localeCompare(nameB);
    });
    return list;
  }, [slotPopup, legalPlayCardActions]);

  function stageFromSlotPopup(cardId: string) {
    if (!slotPopup || !myPowerEarly) return;
    const action: Action = {
      kind: 'summoning_play_card',
      power: myPowerEarly,
      cardId,
      toRegion: slotPopup.regionId,
      slotIndex: slotPopup.slotIndex,
    };
    setPendingAction(action);
    setSelectedCardId(cardId);
    setSlotPopup(null);
  }

  // ── Summon popup (click the + on a region) ──────────────────────────────
  const [summonPopup, setSummonPopup] = useState<
    { regionId: RegionId; x: number; y: number } | null
  >(null);

  // Clamped positions (measure after render, flip/clip if off-screen).
  // Pass primitives so the effect's deps array is stable between renders.
  const { ref: slotPopupRef, pos: slotPopupPos } = useClampedPopupPosition(
    slotPopup?.x ?? null,
    slotPopup?.y ?? null,
  );
  const { ref: summonPopupRef, pos: summonPopupPos } = useClampedPopupPosition(
    summonPopup?.x ?? null,
    summonPopup?.y ?? null,
  );

  const legalSummonActions = useMemo(() => {
    if (!displayState || !myPowerEarly) return [];
    if (displayState.pendingAction?.actionKind !== 'summoning_action') return [];
    return getLegalActions(displayState, myPowerEarly)
      .filter((a) => a.kind === 'summoning_summon_figure') as Array<
        Extract<Action, { kind: 'summoning_summon_figure' }>
      >;
  }, [displayState, myPowerEarly]);

  const canSummon = useCallback(
    (regionId: RegionId) =>
      legalSummonActions.some((a) => {
        if (a.toRegion !== regionId) return false;
        const fig = displayState ? findFollower(displayState, a.followerId) : null;
        return fig?.regionId === null;
      }),
    [legalSummonActions, displayState],
  );

  const handleSummonClick = useCallback(
    (regionId: RegionId, x: number, y: number) => {
      setSummonPopup({ regionId, x, y });
    },
    [],
  );

  // Choices for the open region — deduped by (class, source region, controlledBy, protected).
  // getLegalActions already dedupes equivalent followers, but we also need a
  // label, so we pair each action with a human-readable descriptor.
  const summonChoices = useMemo(() => {
    if (!summonPopup || !displayState) return [] as Array<{
      action: Extract<Action, { kind: 'summoning_summon_figure' }>;
      label: string;
      cost: number;
    }>;
    const out: Array<{
      action: Extract<Action, { kind: 'summoning_summon_figure' }>;
      label: string;
      cost: number;
    }> = [];
    for (const a of legalSummonActions) {
      if (a.toRegion !== summonPopup.regionId) continue;
      const fig = findFollower(displayState, a.followerId);
      if (!fig) continue;
      // Reserve-only: don't show on-board figures being moved.
      if (fig.regionId !== null) continue;
      const label = fig.class.charAt(0).toUpperCase() + fig.class.slice(1);
      const cost = (a as { cost?: number }).cost
        ?? (displayState.powers[myPowerEarly!]!.powerPoints
            - (applyActionForPreview(displayState, a).state.powers[myPowerEarly!]!.powerPoints));
      out.push({ action: a, label, cost });
    }
    return out;
  }, [summonPopup, displayState, legalSummonActions, myPowerEarly]);

  function stageFromSummonPopup(action: Extract<Action, { kind: 'summoning_summon_figure' }>) {
    setPendingAction(action);
    setSummonPopup(null);
  }

  // ── DnD sensors ─────────────────────────────────────────────────────────────

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveDrag(event.active.data.current as DragItem);
    setSubmitError('');
  }

  function handleDragEnd(event: DragEndEvent) {
    const drag = event.active.data.current as DragItem | undefined;
    const dropRegion = event.over?.id as RegionId | undefined;

    setActiveDrag(null);

    if (!drag || !dropRegion || !displayState || !myPower) return;
    if (!validDropRegions?.has(dropRegion)) return;

    if (drag.kind === 'reserve_follower' || drag.kind === 'board_follower') {
      // Map to the representative followerId from getLegalActions — the dragged
      // figure may have been deduped away in favour of an equivalent one.
      const legal = getLegalActions(displayState, myPower);
      const dragged = findFollower(displayState, drag.followerId);
      const match = dragged && legal.find((a) => {
        if (a.kind !== 'summoning_summon_figure') return false;
        if ((a as { toRegion: RegionId }).toRegion !== dropRegion) return false;
        const rep = findFollower(displayState, a.followerId);
        return rep && rep.class === dragged.class
          && rep.regionId === dragged.regionId
          && rep.protected === dragged.protected
          && (rep.controlledBy ?? rep.power) === (dragged.controlledBy ?? dragged.power);
      });
      if (!match) return;

      setPendingAction(match as Action);
    } else if (drag.kind === 'hand_card') {
      const region = displayState.regions[dropRegion]!;
      const slotIndex = region.chaosCards[0] === null ? 0 : 1;
      const action: Action = {
        kind: 'summoning_play_card',
        power: myPower,
        cardId: drag.cardId,
        toRegion: dropRegion,
        slotIndex,
      };
      setPendingAction(action);
      setSelectedCardId(drag.cardId);
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function handleEndTurn() {
    const acting = myPower;
    if (!acting) return;
    setSubmitError('');
    setSubmitting(true);
    // Track whether the player staged an action before clicking End Turn.
    // If they did, "End Turn" means "submit my action" — not "pass summoning".
    // The AI will run, and it may come back to the human player's next summoning
    // tick. We must NOT auto-pass that new tick.
    const hadStagedAction = !!pendingAction || !!pendingOnPlayChoice;
    try {
      let lastResult: { state: GameState; seq: number; events: GameEvent[] } | null = null;
      if (pendingAction) {
        lastResult = await submitAction(gameId, pendingAction);
        setPendingAction(null);
        setSelectedCardId(null);
      }
      if (pendingOnPlayChoice) {
        lastResult = await submitAction(gameId, pendingOnPlayChoice);
        setPendingOnPlayChoice(null);
      }
      // Pure pass: End Turn clicked without staging any action
      if (!hadStagedAction) {
        lastResult = await submitAction(gameId, { kind: 'summoning_pass', power: acting });
      }
      if (lastResult) {
        syncAfterAction(lastResult.state, lastResult.seq, lastResult.events);
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setSubmitting(false);
    }
  }

  function handleUndo() {
    if (pendingOnPlayChoice) {
      setPendingOnPlayChoice(null);
    } else {
      setPendingAction(null);
      setSelectedCardId(null);
    }
  }

  // Non-summoning actions go directly to server
  const handleDirectAction = useCallback(async (action: Action) => {
    setSubmitError('');
    setSubmitting(true);
    try {
      const { state: newState, seq, events: actionEvents } = await submitAction(gameId, action);
      setSelectedCardId(null);
      // Use the returned state + events directly. The game was blocked on
      // this player so there are no pending events. SSE duplicates are
      // skipped via knownSeq.
      syncAfterAction(newState, seq, actionEvents);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setSubmitting(false);
    }
  }, [gameId, syncAfterAction]);

  // Submit a batch of actions (e.g. multi-pick dial rewards). Server applies
  // them sequentially in one transactional save so the picks commit together.
  const handleDirectActions = useCallback(async (actions: Action[]) => {
    if (actions.length === 0) return;
    setSubmitError('');
    setSubmitting(true);
    try {
      const { state: newState, seq, events: actionEvents } = await submitActions(gameId, actions);
      setSelectedCardId(null);
      syncAfterAction(newState, seq, actionEvents);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setSubmitting(false);
    }
  }, [gameId, syncAfterAction]);

  const handleChatSend = useCallback(async (message: string) => {
    await sendChat(gameId, message);
  }, [gameId]);

  const navigate = useNavigate();
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const handleLeaveGame = useCallback(async () => {
    setLeaving(true);
    try {
      await leaveGame(gameId);
      navigate('/home');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to leave');
      setLeaveConfirmOpen(false);
    } finally {
      setLeaving(false);
    }
  }, [gameId, navigate]);

  // ── Render ───────────────────────────────────────────────────────────────────

  if (!displayState) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: PAPER_FADE }}>
        Connecting…
      </div>
    );
  }

  // Use server state for status bar so "Acting:" doesn't jump ahead of the buffer
  const statusState = serverState ?? displayState;
  const serverPending = statusState.pendingAction;

  // myPower: if we have a buffered action, it belongs to that power (keep tableau visible).
  // Otherwise derive from the server state's acting player.
  const myPower: Power | null = pendingAction
    ? (pendingAction as { power: Power }).power
    : (serverPending?.waitingFor && myPowers.includes(serverPending.waitingFor))
      ? serverPending.waitingFor
      : null;
  const isMyTurn        = myPower !== null;
  // The tableau stays up for the whole game so the board never jumps in size.
  const tablePower: Power | null = myPower ?? myPowers[0] ?? null;
  const isSummoningTurn = isMyTurn && serverPending?.actionKind === 'summoning_action';

  // After applying pendingAction client-side, the engine may pause for a follow-up choice
  const afterPlayPending = pendingAction ? displayState.pendingAction : null;
  const needsOnPlayChoice = !!pendingAction && afterPlayPending?.actionKind === 'card_on_play_choice';
  const needsApprenticeChoice = !!pendingAction && afterPlayPending?.actionKind === 'tenzen_apprentice_choice';
  const onPlayContext = needsOnPlayChoice ? (afterPlayPending!.context ?? {}) : null;

  // When choosing a destination region for the on-play choice, highlight all valid regions
  // (all except source) and enable board clicks
  const onPlaySourceRegion = onPlayContext ? (onPlayContext['regionId'] as RegionId | undefined) : undefined;
  const onPlayHighlight = needsOnPlayChoice && !pendingOnPlayChoice
    ? (Object.keys(displayState.regions) as RegionId[]).filter(r => r !== onPlaySourceRegion)
    : undefined;

  function handleOnPlayChoice(action: Action) {
    setPendingOnPlayChoice(action);
  }

  function handleOnPlayRegionClick(regionId: RegionId) {
    // Only used when the panel has already selected a token — handled inside the panel
    // This is a fallback for direct map clicks; we rely on the panel for token selection
    void regionId;
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="game-ui" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: INK, overflow: 'clip' }}>

        {/* Status bar shows committed state so Acting doesn't flicker ahead */}
        <StatusBar
          state={statusState}
          myPower={myPower}
          players={players}
          events={events}
          onLeave={myPowers.length > 0 ? () => setLeaveConfirmOpen(true) : undefined}
          leaveLabel={isMultiplayer ? 'Leave Game' : 'Delete Game'}
        />

        {/* Main area */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 8, padding: '8px 0 8px 8px' }}>

          {/* Board */}
          <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative', display: 'flex', justifyContent: 'center' }}>
            <GameBoard
              state={(anim.animationPhase ? anim.displayState : displayState) ?? displayState}
              highlightRegions={activeDrag ? highlightRegions : onPlayHighlight}
              dimmedRegions={activeDrag ? dimmedRegions : undefined}
              pendingAction={anim.animationPhase ? null : pendingAction}
              onRegionClick={needsOnPlayChoice && !pendingOnPlayChoice ? handleOnPlayRegionClick : undefined}
              myPower={isSummoningTurn && !pendingAction && !anim.animationPhase ? myPower : null}
              animationRegion={!paused && (anim.animationPhase === 'battle' || anim.animationPhase === 'corruption') ? anim.activeRegion : null}
              animationKilledIds={anim.animationPhase ? anim.killedIds : undefined}
              hideKilled={anim.hideKilled}
              battlePaneEvents={(anim.animationPhase === 'battle' || anim.animationPhase === 'corruption' || paused) ? anim.processedBattleEvents : undefined}
              dominationLabels={anim.animationPhase === 'corruption' ? anim.dominationLabels : undefined}
              corruptionOverrides={anim.animationPhase === 'corruption' ? anim.corruptionOverrides : undefined}
              corruptionFlies={anim.animationPhase === 'corruption' ? anim.corruptionFlies : undefined}
              summoningAnim={{ appearingFigures: anim.appearingFigures, movingFigures: anim.movingFigures, appearingCards: anim.appearingCards }}
              onSlotClick={isSummoningTurn && !pendingAction && !anim.animationPhase ? handleSlotClick : undefined}
              slotPlayable={isSummoningTurn && !pendingAction && !anim.animationPhase ? slotPlayable : undefined}
              onSummonClick={isSummoningTurn && !pendingAction && !anim.animationPhase ? handleSummonClick : undefined}
              canSummon={isSummoningTurn && !pendingAction && !anim.animationPhase ? canSummon : undefined}
            />
            <CinematicLayer
              subscribe={subscribe}
              state={serverState ?? displayState}
              myPowers={myPowers}
              paused={paused}
              onResume={resume}
            />
          </div>

          {/* Middle: non-summoning action panels */}
          {(needsOnPlayChoice || needsApprenticeChoice || (isMyTurn && serverPending?.actionKind !== 'summoning_action')) && (
            <div style={{ width: 270, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, flexShrink: 0, ['--accent' as string]: myPower ? POWER_COLORS[myPower] : undefined }}>
              {needsOnPlayChoice && myPower && !pendingOnPlayChoice && onPlayContext && (
                <div className="ap-dock">
                  <CardOnPlayChoicePanel
                    state={displayState}
                    myPower={myPower}
                    context={onPlayContext as Record<string, unknown>}
                    onAction={handleOnPlayChoice}
                    onUndo={handleUndo}
                  />
                </div>
              )}

              {needsApprenticeChoice && myPower && afterPlayPending && (
                <div className="ap-dock">
                  <div style={{ fontSize: '0.8rem', color: PAPER, marginBottom: 6, fontWeight: 600 }}>
                    Chaos Stone
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#aaa', marginBottom: 8 }}>
                    Carry the Chaos Stone from {REGIONS[afterPlayPending.context['fromRegion'] as RegionId].name} to {REGIONS[afterPlayPending.context['toRegion'] as RegionId].name}?
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className="primary"
                      onClick={() => setPendingAction(prev => prev ? { ...prev, carry: true } as typeof prev : prev)}
                      style={{ flex: 1, fontSize: '0.85rem', padding: '0.5rem' }}
                    >
                      Carry
                    </button>
                    <button
                      className="secondary"
                      onClick={() => setPendingAction(prev => prev ? { ...prev, carry: false } as typeof prev : prev)}
                      style={{ flex: 1, fontSize: '0.85rem', padding: '0.5rem' }}
                    >
                      Leave
                    </button>
                  </div>
                </div>
              )}

              {isMyTurn && serverPending?.actionKind !== 'summoning_action' && (
                <div className="ap-dock">
                  {submitError && <p style={{ color: ERROR, fontSize: '0.8rem', marginBottom: 6 }}>{submitError}</p>}
                  <ActionPanel
                    state={displayState}
                    myPower={myPower}
                    selectedCardId={selectedCardId}
                    onAction={handleDirectAction}
                    onActions={handleDirectActions}
                    onClearCard={() => setSelectedCardId(null)}
                  />
                </div>
              )}
            </div>
          )}

          {/* Right: collapsible log */}
          <CollapsibleLog
            events={events}
            chat={chat}
            onSendChat={handleChatSend}
            connected={connected}
            players={players}
          />
        </div>

        {tablePower && (
          <Tableau
            state={serverState ?? displayState}
            displayState={displayState}
            myPower={tablePower}
            selectedCardId={selectedCardId}
            onSelectCard={setSelectedCardId}
            pendingAction={pendingOnPlayChoice ?? pendingAction}
            onUndo={handleUndo}
            onEndTurn={isSummoningTurn && (!needsOnPlayChoice || !!pendingOnPlayChoice) && !needsApprenticeChoice ? handleEndTurn : undefined}
            submitError={submitError}
          />
        )}
      </div>

      {/* Drag ghost */}
      <DragOverlay dropAnimation={null}>
        {activeDrag ? <DragGhost item={activeDrag} /> : null}
      </DragOverlay>

      {/* Play-card popup: pick a card to play into a clicked slot */}
      {slotPopup && (
        <div
          onClick={() => setSlotPopup(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 250 }}
        >
          <div
            ref={slotPopupRef}
            onClick={(e) => e.stopPropagation()}
            className="gpopup"
            style={{
              top: slotPopupPos.top,
              left: slotPopupPos.left,
              minWidth: 190,
              maxHeight: 'calc(100vh - 16px)',
              overflowY: 'auto',
              visibility: slotPopupPos.ready ? 'visible' : 'hidden',
            }}
          >
            <div className="gpopup-label">Play a Card</div>
            {slotChoices.length === 0 && (
              <div className="gpopup-empty">No playable cards.</div>
            )}
            {slotChoices.map((cardId) => {
              const def = CARD_BY_ID[cardId];
              const name = def?.name ?? cardId;
              const cost = def?.cost ?? 0;
              return (
                <button
                  key={cardId}
                  onClick={() => stageFromSlotPopup(cardId)}
                  className="gpopup-item"
                >
                  <span>{name}</span>
                  <span className="gpopup-item-cost">PP {cost}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Summon popup: pick a follower to summon into a clicked region */}
      {summonPopup && (
        <div
          onClick={() => setSummonPopup(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 250 }}
        >
          <div
            ref={summonPopupRef}
            onClick={(e) => e.stopPropagation()}
            className="gpopup"
            style={{
              top: summonPopupPos.top,
              left: summonPopupPos.left,
              maxHeight: 'calc(100vh - 16px)',
              overflowY: 'auto',
              visibility: summonPopupPos.ready ? 'visible' : 'hidden',
            }}
          >
            <div className="gpopup-label">Summon a Follower</div>
            {summonChoices.length === 0 && (
              <div className="gpopup-empty">No summon options.</div>
            )}
            {summonChoices.map(({ action, label, cost }, i) => (
              <button
                key={`${action.followerId}-${i}`}
                onClick={() => stageFromSummonPopup(action)}
                className="gpopup-item"
              >
                <span>{label}</span>
                <span className="gpopup-item-cost">PP {cost}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Submitting overlay */}
      {submitting && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <span style={{ color: PAPER, fontWeight: 600 }}>Submitting…</span>
        </div>
      )}

      {/* Leave game confirmation */}
      {leaveConfirmOpen && (
        <div
          onClick={() => !leaving && setLeaveConfirmOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: PARCHMENT, border: `1px solid ${BORDER_HI}`, borderRadius: 8,
              padding: '1.25rem 1.5rem', maxWidth: 420, width: '92%',
              boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
            }}
          >
            <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.05rem', color: ERROR }}>
              {isMultiplayer ? 'Leave this game?' : 'Delete this game?'}
            </h2>
            <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: PAPER, lineHeight: 1.5 }}>
              {isMultiplayer ? (
                <>
                  Your power will be taken over by AI and the game will continue without you.
                  You'll be permanently removed from this game — it won't appear in your game list any more.
                  If you're the last human, the game will be deleted entirely. This cannot be undone.
                </>
              ) : (
                <>This will permanently delete the game. This cannot be undone.</>
              )}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button
                className="secondary"
                onClick={() => setLeaveConfirmOpen(false)}
                disabled={leaving}
              >
                Cancel
              </button>
              <button
                className="danger"
                onClick={handleLeaveGame}
                disabled={leaving}
              >
                {leaving
                  ? (isMultiplayer ? 'Leaving…' : 'Deleting…')
                  : (isMultiplayer ? 'Leave Game' : 'Delete Game')}
              </button>
            </div>
          </div>
        </div>
      )}
    </DndContext>
  );
}

// ── GamePage ──────────────────────────────────────────────────────────────────

export default function GamePage() {
  const { id } = useParams<{ id: string }>();
  const { userId } = useAuth();
  const navigate = useNavigate();
  const [myPowers, setMyPowers] = useState<Power[]>([]);
  const [players, setPlayers] = useState<import('../api/client.js').GamePlayerInfo[]>([]);
  const [initialState, setInitialState] = useState<GameState | null>(null);
  const [isMultiplayer, setIsMultiplayer] = useState(false);
  const [error, setError] = useState('');
  const shakeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id || !userId) return;
    let cancelled = false;
    getGame(id)
      .then(({ state, myPower, myPowers, players, name }) => {
        if (cancelled) return;
        // Seed the display with the HTTP state so the board is visible immediately,
        // before the SSE 'history' event arrives.
        setInitialState(state);
        setPlayers(players ?? []);
        // Multiplayer games always have a name (set by createMultiplayerGame).
        setIsMultiplayer(name !== null);
        // Server returns every power this user controls (hot-seat: one user can own multiple).
        if (myPowers && myPowers.length > 0) {
          setMyPowers(myPowers as Power[]);
        } else if (myPower) {
          setMyPowers([myPower as Power]);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Failed to load game';
        // Stale game links (cancelled or last-human-left) no longer resolve —
        // bounce to /home instead of showing a dead-end error screen.
        if (/not found/i.test(msg)) {
          navigate('/home', { replace: true });
          return;
        }
        setError(msg);
      });
    return () => { cancelled = true; };
  }, [id, userId, navigate]);

  if (!id) return <p className="error-msg" style={{ padding: '2rem' }}>No game ID</p>;
  if (error) return <p className="error-msg" style={{ padding: '2rem' }}>{error}</p>;

  return (
    <GameProvider gameId={id} myPower={myPowers[0] ?? null} initialState={initialState}>
      <SoundProvider>
        <FxProvider shakeRoot={shakeRef}>
          <div ref={shakeRef} style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'clip' }}>
            <GameInner gameId={id} myPowers={myPowers} players={players} isMultiplayer={isMultiplayer} />
          </div>
        </FxProvider>
      </SoundProvider>
    </GameProvider>
  );
}
