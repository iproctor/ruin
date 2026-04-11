import { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import type { Power, Action, RegionId, FollowerClass } from '@ruin/engine';
import type { DragItem } from '../types/drag.js';
import { applyAction, applyActionForPreview, getLegalActions, CARD_BY_ID } from '@ruin/engine';
import { useAuth } from '../contexts/AuthContext.js';
import { GameProvider, useGame } from '../contexts/GameContext.js';
import { useGameStream } from '../hooks/useGameStream.js';
import { getGame, submitAction, sendChat } from '../api/client.js';
import Board from '../components/Board.js';
import StatusBar from '../components/StatusBar.js';
import Tableau from '../components/Tableau.js';
import LogPanel from '../components/LogPanel.js';
import ActionPanel, { CardOnPlayChoicePanel } from '../components/ActionPanel.js';
import { POWER_COLORS, POWER_LABELS } from '../lib/display.js';
import { usePhaseAnimation } from '../hooks/usePhaseAnimation.js';

// ── Drag data types ────────────────────────────────────────────────────────────

export type { DragItem } from '../types/drag.js';

// ── DragGhost — what renders under the cursor while dragging ──────────────────

function DragGhost({ item }: { item: DragItem }) {
  const color = POWER_COLORS[item.power];
  if (item.kind === 'hand_card') {
    const def = CARD_BY_ID[item.cardId];
    return (
      <div style={{
        width: 52, height: 72, background: '#1a1433',
        border: `2px solid ${color}`, borderRadius: 6,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '0.65rem', fontWeight: 700, color: '#fff', padding: 4,
        textAlign: 'center', boxShadow: `0 0 16px ${color}88`, opacity: 0.9,
        pointerEvents: 'none',
      }}>
        {def?.name.split(' ').pop() ?? item.cardId}
      </div>
    );
  }
  const shape = item.followerClass === 'incarnation' ? '■'
              : item.followerClass === 'warrior'     ? '▲'
              :                                        '▌';
  return (
    <div style={{
      width: 32, height: 32,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: item.followerClass === 'warrior' ? '1.4rem' : '1.1rem',
      color, opacity: 0.9,
      filter: `drop-shadow(0 0 6px ${color})`,
      pointerEvents: 'none',
    }}>
      {shape}
    </div>
  );
}

// ── Collapsible log wrapper ──────────────────────────────────────────────────

function CollapsibleLog(props: {
  events: import('@ruin/engine').GameEvent[];
  eventLog: string[];
  chat: import('../hooks/useGameStream.js').ChatMessage[];
  myPower: Power | null;
  onSendChat: (message: string) => Promise<void>;
  connected: boolean;
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
          background: '#13121f',
          border: '1px solid #2d2d5e',
          borderRight: 'none',
          borderRadius: '16px 0 0 16px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#64748b',
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
}

function GameInner({ gameId, myPowers, players }: GameInnerProps) {
  const { state: serverState, setState } = useGame();
  const { state: streamState, eventLog, events, chat, connected } = useGameStream(gameId);

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
  const anim = usePhaseAnimation(serverState, events, myPowers);
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
      const legal = getLegalActions(displayState, myPowerEarly);
      return new Set(
        legal
          .filter(a => a.kind === 'summoning_play_card' && a.cardId === activeDrag.cardId)
          .map(a => (a as { toRegion: RegionId }).toRegion)
      );
    }

    // For follower drags (reserve or board), consult legal actions for valid toRegions
    if (activeDrag.kind === 'reserve_follower' || activeDrag.kind === 'board_follower') {
      const legal = getLegalActions(displayState, myPowerEarly);
      return new Set(
        legal
          .filter(
            (a) =>
              a.kind === 'summoning_summon_figure' &&
              a.followerId === activeDrag.followerId
          )
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
      const action: Action = {
        kind: 'summoning_summon_figure',
        power: myPower,
        followerId: drag.followerId,
        toRegion: dropRegion,
      };
      setPendingAction(action);
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
      let latest = serverState!;
      if (pendingAction) {
        latest = await submitAction(gameId, pendingAction);
        setState(latest);
        setPendingAction(null);
        setSelectedCardId(null);
      }
      if (pendingOnPlayChoice) {
        latest = await submitAction(gameId, pendingOnPlayChoice);
        setState(latest);
        setPendingOnPlayChoice(null);
      }
      // Only auto-pass if the player clicked End Turn without staging any action
      // (i.e. pure "pass" intent). After AI turns run it could be our turn again
      // (new summoning rotation) — do NOT pass that new tick.
      if (!hadStagedAction && latest.pendingAction?.waitingFor === acting && latest.pendingAction?.actionKind === 'summoning_action') {
        const sPass = await submitAction(gameId, { kind: 'summoning_pass', power: acting });
        setState(sPass);
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
      const newState = await submitAction(gameId, action);
      setState(newState);
      setSelectedCardId(null);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setSubmitting(false);
    }
  }, [gameId, setState]);

  const handleChatSend = useCallback(async (message: string) => {
    await sendChat(gameId, message);
  }, [gameId]);

  // ── Render ───────────────────────────────────────────────────────────────────

  if (!displayState) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#475569' }}>
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
  const isSummoningTurn = isMyTurn && serverPending?.actionKind === 'summoning_action';

  // After applying pendingAction client-side, the engine may pause for an on-play choice
  const afterPlayPending = pendingAction ? displayState.pendingAction : null;
  const needsOnPlayChoice = !!pendingAction && afterPlayPending?.actionKind === 'card_on_play_choice';
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
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0d0d1f', overflow: 'hidden' }}>

        {/* Status bar shows committed state so Acting doesn't flicker ahead */}
        <StatusBar state={statusState} myPower={myPower} players={players} />

        {/* Main area */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 8, padding: '8px 0 8px 8px' }}>

          {/* Board */}
          <div style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <Board
              state={(anim.animationPhase ? anim.displayState : displayState) ?? displayState}
              highlightRegions={activeDrag ? highlightRegions : onPlayHighlight}
              dimmedRegions={activeDrag ? dimmedRegions : undefined}
              pendingAction={anim.animationPhase ? null : pendingAction}
              onRegionClick={needsOnPlayChoice && !pendingOnPlayChoice ? handleOnPlayRegionClick : undefined}
              myPower={isSummoningTurn && !pendingAction && !anim.animationPhase ? myPower : null}
              animationRegion={anim.animationPhase === 'battle' || anim.animationPhase === 'corruption' ? anim.activeRegion : null}
              animationKilledIds={anim.animationPhase ? anim.killedIds : undefined}
              hideKilled={anim.hideKilled}
              battlePaneEvents={(anim.animationPhase === 'battle' || anim.animationPhase === 'battle_continue') ? anim.processedEvents : undefined}
              dominationLabels={anim.animationPhase === 'corruption' ? anim.dominationLabels : undefined}
              corruptionOverrides={anim.animationPhase === 'corruption' ? anim.corruptionOverrides : undefined}
              corruptionFlies={anim.animationPhase === 'corruption' ? anim.corruptionFlies : undefined}
            />
          </div>

          {/* Middle: non-summoning action panels */}
          {!anim.animationPhase && (needsOnPlayChoice || (isMyTurn && serverPending?.actionKind !== 'summoning_action')) && (
            <div style={{ width: 240, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, flexShrink: 0 }}>
              {needsOnPlayChoice && myPower && !pendingOnPlayChoice && onPlayContext && (
                <div style={{ background: '#1a1040', border: '2px solid #7c3aed', borderRadius: 8, padding: '0.75rem', flexShrink: 0 }}>
                  <CardOnPlayChoicePanel
                    state={displayState}
                    myPower={myPower}
                    context={onPlayContext as Record<string, unknown>}
                    onAction={handleOnPlayChoice}
                    onUndo={handleUndo}
                  />
                </div>
              )}

              {isMyTurn && serverPending?.actionKind !== 'summoning_action' && (
                <div style={{ background: '#16213e', border: '2px solid #312e81', borderRadius: 8, padding: '0.75rem', flexShrink: 0 }}>
                  {submitError && <p style={{ color: '#f87171', fontSize: '0.8rem', marginBottom: 6 }}>{submitError}</p>}
                  <ActionPanel
                    state={displayState}
                    myPower={myPower}
                    selectedCardId={selectedCardId}
                    onAction={handleDirectAction}
                    onClearCard={() => setSelectedCardId(null)}
                  />
                </div>
              )}
            </div>
          )}

          {/* During battle decisions, show action panel with server state */}
          {anim.needsDecision && anim.decisionState && myPower && (
            <div style={{ width: 240, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, flexShrink: 0 }}>
              <div style={{ background: '#16213e', border: '2px solid #7f1d1d', borderRadius: 8, padding: '0.75rem', flexShrink: 0 }}>
                <ActionPanel
                  state={anim.decisionState}
                  myPower={myPower}
                  selectedCardId={null}
                  onAction={handleDirectAction}
                  onClearCard={() => {}}
                />
              </div>
            </div>
          )}


          {/* Right: collapsible log */}
          <CollapsibleLog
            events={events}
            eventLog={eventLog}
            chat={chat}
            myPower={myPower}
            onSendChat={handleChatSend}
            connected={connected}
          />
        </div>

        {/* Tableau — hidden during animation, Continue button during battle_continue */}
        {anim.animationPhase === 'battle_continue' && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 8px', background: '#16213e', borderTop: '1px solid #3a3a6e' }}>
            <button
              onClick={anim.onContinue}
              style={{
                fontSize: '0.85rem',
                padding: '8px 32px',
                borderRadius: 6,
                border: 'none',
                background: '#7f1d1d',
                color: '#fca5a5',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Continue to Corruption Phase
            </button>
          </div>
        )}
        {!anim.animationPhase && myPower && (
          <Tableau
            state={serverState ?? displayState}
            displayState={displayState}
            myPower={myPower}
            selectedCardId={selectedCardId}
            onSelectCard={setSelectedCardId}
            pendingAction={pendingOnPlayChoice ?? pendingAction}
            onUndo={handleUndo}
            onEndTurn={isSummoningTurn && (!needsOnPlayChoice || !!pendingOnPlayChoice) ? handleEndTurn : undefined}
            submitError={submitError}
          />
        )}
      </div>

      {/* Drag ghost */}
      <DragOverlay dropAnimation={null}>
        {activeDrag ? <DragGhost item={activeDrag} /> : null}
      </DragOverlay>

      {/* Submitting overlay */}
      {submitting && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <span style={{ color: '#e2e8f0', fontWeight: 600 }}>Submitting…</span>
        </div>
      )}
    </DndContext>
  );
}

// ── GamePage ──────────────────────────────────────────────────────────────────

export default function GamePage() {
  const { id } = useParams<{ id: string }>();
  const { userId } = useAuth();
  const [myPowers, setMyPowers] = useState<Power[]>([]);
  const [players, setPlayers] = useState<import('../api/client.js').GamePlayerInfo[]>([]);
  const [initialState, setInitialState] = useState<GameState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id || !userId) return;
    let cancelled = false;
    getGame(id)
      .then(({ state, myPower, myPowers, players }) => {
        if (cancelled) return;
        // Seed the display with the HTTP state so the board is visible immediately,
        // before the SSE 'history' event arrives.
        setInitialState(state);
        setPlayers(players ?? []);
        // Server returns every power this user controls (hot-seat: one user can own multiple).
        if (myPowers && myPowers.length > 0) {
          setMyPowers(myPowers as Power[]);
        } else if (myPower) {
          setMyPowers([myPower as Power]);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load game');
      });
    return () => { cancelled = true; };
  }, [id, userId]);

  if (!id) return <p className="error-msg" style={{ padding: '2rem' }}>No game ID</p>;
  if (error) return <p className="error-msg" style={{ padding: '2rem' }}>{error}</p>;

  return (
    <GameProvider gameId={id} myPower={myPowers[0] ?? null} initialState={initialState}>
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <GameInner gameId={id} myPowers={myPowers} players={players} />
      </div>
    </GameProvider>
  );
}
