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
import { applyAction, CARD_BY_ID } from '@ruin/engine';
import { useAuth } from '../contexts/AuthContext.js';
import { GameProvider, useGame } from '../contexts/GameContext.js';
import { useGameStream } from '../hooks/useGameStream.js';
import { getGame, submitAction, sendChat } from '../api/client.js';
import Board from '../components/Board.js';
import StatusBar from '../components/StatusBar.js';
import Tableau from '../components/Tableau.js';
import LogPanel from '../components/LogPanel.js';
import ActionPanel from '../components/ActionPanel.js';
import { POWER_COLORS, POWER_LABELS } from '../lib/display.js';

// ── Drag data types ────────────────────────────────────────────────────────────

export type DragItem =
  | { kind: 'reserve_follower'; followerId: string; followerClass: FollowerClass; power: Power }
  | { kind: 'board_follower';   followerId: string; followerClass: FollowerClass; power: Power; fromRegion: RegionId }
  | { kind: 'hand_card';        cardId: string; power: Power };

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
  const shape = item.followerClass === 'incarnation' ? '▲'
              : item.followerClass === 'warrior'     ? '■'
              :                                        '▌';
  return (
    <div style={{
      width: 32, height: 32,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: item.followerClass === 'incarnation' ? '1.4rem' : '1.1rem',
      color, opacity: 0.9,
      filter: `drop-shadow(0 0 6px ${color})`,
      pointerEvents: 'none',
    }}>
      {shape}
    </div>
  );
}

// ── GameInner ─────────────────────────────────────────────────────────────────

interface GameInnerProps {
  gameId: string;
  myPower: Power | null;
}

function GameInner({ gameId, myPower }: GameInnerProps) {
  const { state: serverState, setState } = useGame();
  const { state: streamState, eventLog, chat, connected } = useGameStream(gameId);

  const [pendingAction, setPendingAction]   = useState<Action | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [submitError, setSubmitError]       = useState('');
  const [submitting, setSubmitting]         = useState(false);
  const [activeDrag, setActiveDrag]         = useState<DragItem | null>(null);

  // Merge SSE state; clear pending action if phase changed or it's no longer our turn
  useEffect(() => {
    if (!streamState) return;
    setState(streamState);
    const stillMyTurn =
      myPower !== null &&
      streamState.pendingAction?.waitingFor === myPower &&
      streamState.phase === 'summoning';
    if (!stillMyTurn) {
      setPendingAction(null);
      setSelectedCardId(null);
    }
  }, [streamState, myPower, setState]);

  // displayState = serverState with pending action applied (preview)
  const displayState = useMemo(() => {
    if (!serverState) return null;
    if (!pendingAction) return serverState;
    try {
      return applyAction(serverState, pendingAction).state;
    } catch {
      return serverState;
    }
  }, [serverState, pendingAction]);

  // Valid drop target regions depend on what's being dragged
  const validDropRegions = useMemo((): Set<RegionId> | null => {
    if (!activeDrag || !displayState) return null;
    const all = displayState.activePowers
      .flatMap(() => Object.keys(displayState.regions)) as RegionId[];
    const nonRuined = all.filter((r) => displayState.regions[r]!.ruinationCardIndex === null);

    if (activeDrag.kind === 'hand_card') {
      // Valid if region has at least one empty card slot
      return new Set(nonRuined.filter((r) => {
        const cards = displayState.regions[r]!.chaosCards;
        return cards[0] === null || cards[1] === null;
      }));
    }
    if (activeDrag.kind === 'board_follower') {
      return new Set(nonRuined.filter((r) => r !== activeDrag.fromRegion));
    }
    return new Set(nonRuined);
  }, [activeDrag, displayState]);

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
    if (!myPower) return;
    setSubmitError('');
    setSubmitting(true);
    try {
      if (pendingAction) {
        const s1 = await submitAction(gameId, pendingAction);
        setState(s1);
        setPendingAction(null);
        setSelectedCardId(null);
        // If it's still our turn, pass now
        if (s1.pendingAction?.waitingFor === myPower) {
          const s2 = await submitAction(gameId, { kind: 'summoning_pass', power: myPower });
          setState(s2);
        }
      } else {
        const s = await submitAction(gameId, { kind: 'summoning_pass', power: myPower });
        setState(s);
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setSubmitting(false);
    }
  }

  function handleUndo() {
    setPendingAction(null);
    setSelectedCardId(null);
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

  const pending = displayState.pendingAction;
  const isMyTurn        = myPower !== null && pending?.waitingFor === myPower;
  const isSummoningTurn = isMyTurn && pending?.actionKind === 'summoning_action';

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0d0d1f', overflow: 'hidden' }}>

        {/* Status bar */}
        <StatusBar state={displayState} myPower={myPower} />

        {/* Main area */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 8, padding: 8 }}>

          {/* Board */}
          <div style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <Board
              state={displayState}
              highlightRegions={activeDrag ? highlightRegions : undefined}
              dimmedRegions={activeDrag ? dimmedRegions : undefined}
              pendingAction={pendingAction}
            />
          </div>

          {/* Right: log + non-summoning panels */}
          <div style={{ width: 280, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
            <LogPanel
              eventLog={eventLog}
              chat={chat}
              myPower={myPower}
              onSendChat={handleChatSend}
              connected={connected}
            />

            {isMyTurn && pending?.actionKind !== 'summoning_action' && (
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
        </div>

        {/* Tableau */}
        {myPower && (
          <Tableau
            state={serverState ?? displayState}
            displayState={displayState}
            myPower={myPower}
            selectedCardId={selectedCardId}
            onSelectCard={setSelectedCardId}
            pendingAction={pendingAction}
            onUndo={handleUndo}
            onEndTurn={isSummoningTurn ? handleEndTurn : undefined}
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
  const [myPower, setMyPower] = useState<Power | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id || !userId) return;
    let cancelled = false;
    getGame(id)
      .then((state) => {
        if (cancelled) return;
        const found = state.activePowers.find((p) => {
          const hand = state.powers[p]?.hand ?? [];
          return hand.length > 0 && hand.some((c) => c !== '?');
        });
        setMyPower(found ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load game');
      });
    return () => { cancelled = true; };
  }, [id, userId]);

  if (!id) return <p className="error-msg" style={{ padding: '2rem' }}>No game ID</p>;
  if (error) return <p className="error-msg" style={{ padding: '2rem' }}>{error}</p>;

  return (
    <GameProvider gameId={id} myPower={myPower}>
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <GameInner gameId={id} myPower={myPower} />
      </div>
    </GameProvider>
  );
}
