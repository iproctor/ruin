import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { Power } from '@ruin/engine';
import { useAuth } from '../contexts/AuthContext.js';
import { GameProvider, useGame } from '../contexts/GameContext.js';
import { useGameStream } from '../hooks/useGameStream.js';
import { getGame, submitAction } from '../api/client.js';
import Board from '../components/Board.js';
import GameLog from '../components/GameLog.js';
import Hand from '../components/Hand.js';
import ActionPanel from '../components/ActionPanel.js';
import PowerPanel from '../components/PowerPanel.js';
import type { Action } from '@ruin/engine';

const POWER_LABELS: Record<Power, string> = {
  xarm: 'Xarm',
  gormen: 'Gormen',
  tenzen: 'Tenzen',
  lasha: 'Lasha',
};

interface GameInnerProps {
  gameId: string;
  myPower: Power | null;
}

function GameInner({ gameId, myPower }: GameInnerProps) {
  const { state, setState } = useGame();
  const streamState = useGameStream(gameId);
  const [submitError, setSubmitError] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

  // Merge SSE state into context
  useEffect(() => {
    if (streamState) {
      setState(streamState);
    }
  }, [streamState, setState]);

  // Build a simple log from state transitions
  useEffect(() => {
    if (state) {
      setLog((prev) => {
        const entry = `[Round ${state.round} / ${state.phase}]` +
          (state.pendingAction
            ? ` Waiting for ${state.pendingAction.waitingFor} — ${state.pendingAction.actionKind}`
            : '');
        if (prev[prev.length - 1] === entry) return prev;
        return [...prev, entry];
      });
    }
  }, [state]);

  async function handleAction(action: Action) {
    setSubmitError('');
    try {
      const newState = await submitAction(gameId, action);
      setState(newState);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  if (!state) {
    return <p style={{ padding: '2rem', color: '#aaa' }}>Connecting…</p>;
  }

  const isMyTurn =
    myPower !== null &&
    state.pendingAction !== null &&
    state.pendingAction.waitingFor === myPower;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto',
        gridTemplateColumns: '1fr 280px',
        gap: '0.75rem',
        height: '100%',
        padding: '0.75rem',
      }}
    >
      {/* Header bar */}
      <div
        style={{
          gridColumn: '1 / -1',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          background: '#16213e',
          borderRadius: 6,
          padding: '0.5rem 1rem',
        }}
      >
        <Link to="/games" style={{ color: '#aaa', fontSize: '0.85rem' }}>← Games</Link>
        <span style={{ fontWeight: 700 }}>Ruin</span>
        <span style={{ color: '#aaa', fontSize: '0.85rem' }}>
          Round {state.round} &bull; {state.phase}
        </span>
        {myPower && (
          <span className={`power-${myPower}`} style={{ fontWeight: 600, marginLeft: 'auto' }}>
            Playing as {POWER_LABELS[myPower]}
          </span>
        )}
        {state.winners && (
          <span style={{ color: '#facc15', fontWeight: 700, marginLeft: 'auto' }}>
            Game Over — Winners: {state.winners.map((w) => POWER_LABELS[w] ?? w).join(', ')}
          </span>
        )}
      </div>

      {/* Board + action panel */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', minHeight: 0 }}>
        <Board
          state={state}
          selectedCardId={selectedCardId}
          highlightRegions={isMyTurn && state.pendingAction?.actionKind === 'summoning_action' ? [] : undefined}
          onRegionClick={undefined}
        />

        {myPower && (
          <>
            <Hand
              hand={state.powers[myPower]?.hand ?? []}
              selectedCardId={selectedCardId}
              onSelectCard={(id) => setSelectedCardId((prev) => (prev === id ? null : id))}
            />
            {isMyTurn && state.pendingAction && (
              <>
                {submitError && <p className="error-msg">{submitError}</p>}
                <ActionPanel
                  state={state}
                  myPower={myPower}
                  selectedCardId={selectedCardId}
                  onAction={handleAction}
                  onClearCard={() => setSelectedCardId(null)}
                />
              </>
            )}
          </>
        )}
      </div>

      {/* Right sidebar: power panels + log */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          overflowY: 'auto',
          minHeight: 0,
        }}
      >
        {state.activePowers.map((power) => (
          <PowerPanel key={power} power={power} state={state} isMe={power === myPower} />
        ))}
        <GameLog entries={log} />
      </div>
    </div>
  );
}

// Outer loader: fetches summary to resolve myPower, then renders GameInner
export default function GamePage() {
  const { id } = useParams<{ id: string }>();
  const { userId } = useAuth();
  const [myPower, setMyPower] = useState<Power | null>(null);
  const [error, setError] = useState('');

  // Fetch the game list to find which power the current user controls.
  // We do a quick GET /api/games/:id and look at player records from the summary.
  // Since getGame returns GameState (no userId mapping), we rely on an external
  // approach: the server masks hands, so only one power has non-'?' cards.
  // We'll fetch and then check the hand contents.
  useEffect(() => {
    if (!id || !userId) return;
    let cancelled = false;
    getGame(id)
      .then((state) => {
        if (cancelled) return;
        // Heuristic: the power whose hand contains non-'?' cards is ours
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
      <div className="page-wide">
        <GameInner gameId={id} myPower={myPower} />
      </div>
    </GameProvider>
  );
}
