import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Power } from '@ruin/engine';
import { useAuth } from '../contexts/AuthContext.js';
import {
  assignAiSlot,
  assignPlayerPower,
  cancelGame,
  createMultiplayerGame,
  getLobbySnapshot,
  getLobby,
  invitePlayer,
  joinGame,
  kickPlayer,
  leaveGame,
  pickPower,
  revokeInvitation,
  sendChat,
  sendLobbyChat,
  startGame,
  type LobbyChatMsg,
  type LobbyGameSummary,
  type LobbyOnlineUser,
  type LobbySnapshot,
  type LobbyState,
} from '../api/client.js';
import {
  connectGameStream,
  connectLobbyStream,
  type LobbyStreamEvent,
  type StreamEvent,
} from '../api/sse.js';
import { POWER_COLORS, POWER_LABELS } from '../lib/display.js';

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

type ChatTab = 'global' | 'game';
type RightMode = 'list' | 'create' | 'game';

interface GameChatMsg {
  id: string;
  username: string;
  message: string;
  power: string | null;
  createdAt: string;
}

export default function MultiplayerLobbyPage() {
  const { gameId: routeGameId } = useParams<{ gameId?: string }>();
  const { userId, logout } = useAuth();
  const navigate = useNavigate();

  // Global lobby state (from /api/lobby/stream)
  const [snap, setSnap] = useState<LobbySnapshot | null>(null);
  const [globalChat, setGlobalChat] = useState<LobbyChatMsg[]>([]);

  // Per-game lobby state (when viewing a game in the right pane)
  const [gameLobby, setGameLobby] = useState<LobbyState | null>(null);
  const [gameChat, setGameChat] = useState<GameChatMsg[]>([]);

  // UI state
  const [chatTab, setChatTab] = useState<ChatTab>('global');
  const [chatInput, setChatInput] = useState('');
  const [error, setError] = useState('');
  const [inviteInput, setInviteInput] = useState('');
  const [starting, setStarting] = useState(false);

  const chatBottomRef = useRef<HTMLDivElement>(null);
  const refetchSnapshotRef = useRef<() => void>(() => {});
  // Set when the local user is mid-voluntary-leave so the kick-detection
  // effect doesn't race with our own navigate('/home') and redirect to
  // '/lobby' instead.
  const voluntaryLeaveRef = useRef(false);

  const rightMode: RightMode = routeGameId ? 'game' : 'list';
  const showGameTab = !!routeGameId;

  // ── Lobby SSE ────────────────────────────────────────────────────────────
  useEffect(() => {
    refetchSnapshotRef.current = () => {
      getLobbySnapshot()
        .then((s) => {
          setSnap(s);
          setGlobalChat(s.chat);
        })
        .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load lobby'));
    };
    refetchSnapshotRef.current();

    const cleanup = connectLobbyStream((e: LobbyStreamEvent) => {
      if (e.type === 'snapshot') {
        setSnap(e.snapshot);
        setGlobalChat(e.snapshot.chat);
      } else if (e.type === 'presence') {
        setSnap((prev) => (prev ? { ...prev, online: e.online } : prev));
      } else if (e.type === 'games_update') {
        // Refetch our viewer-specific games list
        refetchSnapshotRef.current();
      } else if (e.type === 'chat') {
        setGlobalChat((prev) => [...prev, e.message]);
      } else if (e.type === 'invited') {
        // Pull updated games list (which now includes this private invite)
        refetchSnapshotRef.current();
      }
    });
    return cleanup;
  }, []);

  // ── Per-game SSE (when viewing a game in the right pane) ────────────────
  useEffect(() => {
    if (!routeGameId) {
      setGameLobby(null);
      setGameChat([]);
      return;
    }
    // Initial fetch
    getLobby(routeGameId)
      .then(setGameLobby)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load game'));

    const cleanup = connectGameStream(routeGameId, (e: StreamEvent) => {
      if (e.type === 'lobby_state') {
        const x = e as any;
        if (x.lobby) setGameLobby(x.lobby);
        if (x.chat) setGameChat(x.chat);
      } else if (e.type === 'lobby_update') {
        const x = e as any;
        setGameLobby((prev) => (prev ? {
          ...prev,
          players: x.players,
          invitations: x.invitations,
          aiSlots: x.aiSlots ?? prev.aiSlots,
        } : prev));
      } else if (e.type === 'chat') {
        setGameChat((prev) => [...prev, (e as any).message]);
      } else if (e.type === 'game_started') {
        navigate(`/games/${routeGameId}`, { replace: true });
      }
    });
    return cleanup;
  }, [routeGameId, navigate]);

  // Default chat tab when entering/leaving a game
  useEffect(() => {
    setChatTab(routeGameId ? 'game' : 'global');
    voluntaryLeaveRef.current = false;
  }, [routeGameId]);

  // Kick detection: if we're viewing a game and the roster no longer includes
  // us, we were kicked. Bounce back to the game list. Skip when the roster
  // drop was our own handleLeave so we don't fight that navigate('/home').
  useEffect(() => {
    if (!routeGameId || !gameLobby || !userId) return;
    if (voluntaryLeaveRef.current) return;
    const stillIn = gameLobby.players.some((p) => p.userId === userId);
    if (!stillIn) navigate('/lobby', { replace: true });
  }, [gameLobby, routeGameId, userId, navigate]);

  // Auto-scroll chat
  const visibleChatLength = chatTab === 'global' ? globalChat.length : gameChat.length;
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView();
  }, [visibleChatLength, chatTab]);

  const isCreator = !!gameLobby && gameLobby.game.createdBy === userId;
  const myCreatedGameId = snap?.myPendingGameId ?? null;

  // ── Handlers ─────────────────────────────────────────────────────────────
  async function handleSendChat() {
    const text = chatInput.trim();
    if (!text) return;
    try {
      if (chatTab === 'global') await sendLobbyChat(text);
      else if (routeGameId) await sendChat(routeGameId, text);
      setChatInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
    }
  }

  async function handleJoin(g: LobbyGameSummary) {
    try {
      await joinGame(g.id);
      navigate(`/lobby/g/${g.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join');
    }
  }

  async function handleInviteFromInput() {
    const target = inviteInput.trim();
    if (!routeGameId || !target) return;
    try {
      await invitePlayer(routeGameId, target);
      setInviteInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invite failed');
    }
  }

  const handleInviteUser = useCallback(
    async (target: LobbyOnlineUser) => {
      if (!myCreatedGameId) {
        setError('Create a game first to invite players.');
        return;
      }
      if (target.inGame) {
        setError(`${target.username} is already in a game.`);
        return;
      }
      if (target.userId === userId) return;
      try {
        await invitePlayer(myCreatedGameId, target.username);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Invite failed');
      }
    },
    [myCreatedGameId, userId],
  );

  async function handleLeave() {
    if (!routeGameId) return;
    voluntaryLeaveRef.current = true;
    try {
      await leaveGame(routeGameId);
      navigate('/home');
    } catch (err) {
      voluntaryLeaveRef.current = false;
      setError(err instanceof Error ? err.message : 'Failed to leave');
    }
  }

  async function handlePickPower(power: Power | null) {
    if (!routeGameId) return;
    try {
      await pickPower(routeGameId, power);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pick power');
    }
  }

  async function handleCancel() {
    if (!routeGameId) return;
    if (!window.confirm('Cancel this game? This cannot be undone.')) return;
    voluntaryLeaveRef.current = true;
    try {
      await cancelGame(routeGameId);
      navigate('/lobby');
    } catch (err) {
      voluntaryLeaveRef.current = false;
      setError(err instanceof Error ? err.message : 'Failed to cancel');
    }
  }

  async function handleStart() {
    if (!routeGameId) return;
    setStarting(true);
    try {
      await startGame(routeGameId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start');
    } finally {
      setStarting(false);
    }
  }

  async function handleAssignPlayer(targetUserId: string, power: string | null) {
    if (!routeGameId) return;
    try {
      await assignPlayerPower(routeGameId, targetUserId, power);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign');
    }
  }

  async function handleAssignAi(aiIndex: number, power: string | null) {
    if (!routeGameId) return;
    try {
      await assignAiSlot(routeGameId, aiIndex, power);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign');
    }
  }

  // ── Sorted games list (invited-to first) ─────────────────────────────────
  const sortedGames = useMemo(() => {
    if (!snap) return [];
    return [...snap.games].sort((a, b) => {
      if (a.invitedYou !== b.invitedYou) return a.invitedYou ? -1 : 1;
      return a.name?.localeCompare(b.name ?? '') ?? 0;
    });
  }, [snap]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', padding: '0.75rem', gap: '0.75rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Link to="/home" style={{ color: '#aaa', fontSize: '0.85rem' }}>← Home</Link>
        <h1 style={{ margin: 0, fontSize: '1.1rem' }}>Multiplayer Lobby</h1>
        <span style={{ fontSize: '0.75rem', color: '#888', marginLeft: 'auto' }}>
          {snap?.online.length ?? 0} online
        </span>
        <button className="secondary" onClick={logout} style={{ fontSize: '0.75rem' }}>
          Sign out
        </button>
      </div>

      {error && (
        <div className="error-msg" style={{ fontSize: '0.8rem' }} onClick={() => setError('')}>
          {error}
        </div>
      )}

      {/* Two-column layout */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', minHeight: 0 }}>
        {/* LEFT: chat + online users */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, padding: '0.5rem' }}>
          {/* Chat tabs */}
          <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.4rem' }}>
            <button
              className={chatTab === 'global' ? 'primary' : 'secondary'}
              onClick={() => setChatTab('global')}
              style={{ fontSize: '0.75rem', padding: '3px 10px' }}
            >
              Global
            </button>
            {showGameTab && (
              <button
                className={chatTab === 'game' ? 'primary' : 'secondary'}
                onClick={() => setChatTab('game')}
                style={{ fontSize: '0.75rem', padding: '3px 10px' }}
              >
                Game
              </button>
            )}
          </div>

          {/* Chat body: online users (left col) + chat history (right col) */}
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '160px 1fr', gap: '0.5rem', minHeight: 0 }}>
            <OnlineUsersList
              users={snap?.online ?? []}
              currentUserId={userId}
              canInvite={chatTab === 'global' && !!myCreatedGameId}
              onInvite={handleInviteUser}
            />
            <ChatHistory
              tab={chatTab}
              global={globalChat}
              game={gameChat}
              currentUserId={userId}
              canInvite={chatTab === 'global' && !!myCreatedGameId}
              online={snap?.online ?? []}
              onInviteByUserId={(uid) => {
                const u = snap?.online.find((o) => o.userId === uid);
                if (u) handleInviteUser(u);
              }}
              bottomRef={chatBottomRef}
            />
          </div>

          {/* Chat input */}
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
            <input
              type="text"
              placeholder={chatTab === 'global' ? 'Say hello…' : 'Game chat…'}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleSendChat())}
              style={{ flex: 1, fontSize: '0.8rem' }}
            />
            <button
              className="primary"
              onClick={handleSendChat}
              disabled={!chatInput.trim()}
              style={{ fontSize: '0.8rem', padding: '4px 12px' }}
            >
              →
            </button>
          </div>
        </div>

        {/* RIGHT: game list / create / game lobby */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, padding: '0.5rem' }}>
          {rightMode === 'list' && (
            <GameListPane
              games={sortedGames}
              currentUserId={userId}
              myCreatedGameId={myCreatedGameId}
              onJoin={handleJoin}
            />
          )}
          {rightMode === 'game' && gameLobby && (
            <GameLobbyPane
              lobby={gameLobby}
              isCreator={isCreator}
              currentUserId={userId}
              inviteInput={inviteInput}
              setInviteInput={setInviteInput}
              onInvite={handleInviteFromInput}
              onRevoke={(invId) => routeGameId && void revokeInvitation(routeGameId, invId)}
              onKick={(uid) => routeGameId && void kickPlayer(routeGameId, uid)}
              onLeave={handleLeave}
              onCancel={handleCancel}
              onPickPower={handlePickPower}
              onAssignPlayer={handleAssignPlayer}
              onAssignAi={handleAssignAi}
              onStart={handleStart}
              starting={starting}
            />
          )}
          {rightMode === 'game' && !gameLobby && (
            <p style={{ color: '#aaa', fontSize: '0.85rem' }}>Loading game…</p>
          )}
        </div>
      </div>
    </div>
  );

}

// ───────────────────────────────────────────────────────────────────────────
// Sub-components
// ───────────────────────────────────────────────────────────────────────────

function OnlineUsersList({
  users,
  currentUserId,
  canInvite,
  onInvite,
}: {
  users: LobbyOnlineUser[];
  currentUserId: string | null;
  canInvite: boolean;
  onInvite: (u: LobbyOnlineUser) => void;
}) {
  return (
    <div style={{
      borderRight: '1px solid #2d2d5e', paddingRight: '0.4rem', overflowY: 'auto',
      fontSize: '0.78rem',
    }}>
      <div style={{ color: '#888', fontSize: '0.7rem', marginBottom: '0.3rem', textTransform: 'uppercase' }}>
        Online ({users.length})
      </div>
      {users.length === 0 && <div style={{ color: '#666' }}>No one online</div>}
      {users.map((u) => {
        const isMe = u.userId === currentUserId;
        const clickable = canInvite && !isMe && !u.inGame;
        return (
          <div
            key={u.userId}
            onClick={() => clickable && onInvite(u)}
            title={
              isMe ? 'You' :
              u.inGame ? 'Already in a game' :
              clickable ? 'Click to invite to your game' :
              'Create a game to invite this player'
            }
            style={{
              padding: '3px 6px', borderRadius: 4, marginBottom: 2,
              cursor: clickable ? 'pointer' : 'default',
              background: clickable ? '#1e1e3a' : 'transparent',
              opacity: u.inGame ? 0.55 : 1,
              display: 'flex', alignItems: 'center', gap: '0.3rem',
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: u.inGame ? '#facc15' : '#22c55e', flexShrink: 0,
            }} />
            <span style={{ color: isMe ? '#a78bfa' : '#cbd5e1', fontWeight: isMe ? 700 : 400 }}>
              {u.username}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ChatHistory({
  tab,
  global,
  game,
  currentUserId,
  canInvite,
  online,
  onInviteByUserId,
  bottomRef,
}: {
  tab: ChatTab;
  global: LobbyChatMsg[];
  game: GameChatMsg[];
  currentUserId: string | null;
  canInvite: boolean;
  online: LobbyOnlineUser[];
  onInviteByUserId: (userId: string) => void;
  bottomRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div style={{ overflowY: 'auto', fontSize: '0.8rem', paddingRight: '0.25rem' }}>
      {tab === 'global' && global.map((m) => {
        const onlineUser = online.find((o) => o.userId === m.userId);
        const isMe = m.userId === currentUserId;
        const clickable = canInvite && !isMe && onlineUser && !onlineUser.inGame;
        return (
          <div key={m.id} style={{ marginBottom: '0.2rem' }}>
            <span
              onClick={() => clickable && onInviteByUserId(m.userId)}
              title={clickable ? 'Click to invite to your game' : ''}
              style={{
                fontWeight: 600,
                color: isMe ? '#a78bfa' : '#7dd3fc',
                cursor: clickable ? 'pointer' : 'default',
                textDecoration: clickable ? 'underline dotted' : 'none',
              }}
            >
              {m.username}:
            </span>{' '}
            <span style={{ color: '#cbd5e1' }}>{m.message}</span>
          </div>
        );
      })}
      {tab === 'game' && game.map((m) => (
        <div key={m.id} style={{ marginBottom: '0.2rem' }}>
          <span style={{
            fontWeight: 600,
            color: m.power ? POWER_COLORS[m.power as Power] : '#7dd3fc',
          }}>
            {m.username}:
          </span>{' '}
          <span style={{ color: '#cbd5e1' }}>{m.message}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function GameListPane({
  games,
  currentUserId,
  myCreatedGameId,
  onJoin,
}: {
  games: LobbyGameSummary[];
  currentUserId: string | null;
  myCreatedGameId: string | null;
  onJoin: (g: LobbyGameSummary) => void;
}) {
  // Also handles "create" mode via local state since we don't want a new route just for the form.
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setCreateError('');
    try {
      const res = await createMultiplayerGame(name.trim(), isPublic);
      navigate(`/lobby/g/${res.gameId}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setCreating(false);
    }
  }

  if (showCreate) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <button className="secondary" onClick={() => setShowCreate(false)} style={{ fontSize: '0.75rem' }}>
            ← Back
          </button>
          <h2 style={{ margin: 0, fontSize: '1rem' }}>Create Game</h2>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div className="form-group">
            <label htmlFor="game-name">Game name</label>
            <input
              id="game-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Friday Night Ruin"
              maxLength={60}
              autoFocus
            />
          </div>
          <label
            style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.5rem 0.6rem', borderRadius: 6,
              border: `2px solid ${isPublic ? '#6366f1' : '#2d2d5e'}`,
              background: isPublic ? '#1e1b4b' : '#16213e',
              cursor: 'pointer', fontSize: '0.85rem',
            }}
          >
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              style={{ width: 'auto' }}
            />
            <span style={{ color: isPublic ? '#c7d2fe' : '#888' }}>
              Public (anyone can find and join)
            </span>
          </label>
          {createError && <p className="error-msg">{createError}</p>}
          <button type="submit" className="primary" disabled={creating || !name.trim()}>
            {creating ? 'Creating…' : 'Create Lobby'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem 0' }}>Open Games</h2>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {games.length === 0 && (
          <p style={{ color: '#888', fontSize: '0.85rem' }}>No open games right now.</p>
        )}
        {games.map((g) => {
          const isYours = g.createdBy === currentUserId;
          return (
            <div
              key={g.id}
              onClick={() => isYours ? navigate(`/lobby/g/${g.id}`) : onJoin(g)}
              style={{
                padding: '0.6rem', marginBottom: '0.4rem', borderRadius: 6,
                cursor: 'pointer',
                border: g.invitedYou ? '2px solid #facc15' : '1px solid #2d2d5e',
                background: g.invitedYou ? '#3a2f0c' : '#16213e',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontWeight: 600 }}>
                  {g.name ?? '(unnamed)'}
                  {g.invitedYou && (
                    <span style={{
                      marginLeft: '0.5rem', fontSize: '0.65rem', padding: '1px 6px',
                      borderRadius: 3, background: '#facc15', color: '#1f1300', fontWeight: 700,
                    }}>
                      INVITED
                    </span>
                  )}
                  {!g.isPublic && (
                    <span style={{
                      marginLeft: '0.4rem', fontSize: '0.65rem', padding: '1px 5px',
                      borderRadius: 3, background: '#374151', color: '#cbd5e1',
                    }}>
                      PRIVATE
                    </span>
                  )}
                </div>
                <span style={{ fontSize: '0.7rem', color: '#888' }}>
                  {g.players.length}/4
                </span>
              </div>
              <div style={{ fontSize: '0.75rem', color: '#888', marginTop: '0.2rem' }}>
                Host: {g.createdByUsername}
                {g.players.length > 1 && (
                  <span> · {g.players.map((p) => p.username).join(', ')}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <button
        className="primary"
        onClick={() => {
          if (myCreatedGameId) navigate(`/lobby/g/${myCreatedGameId}`);
          else setShowCreate(true);
        }}
        style={{ marginTop: '0.5rem' }}
      >
        {myCreatedGameId ? 'Open Your Game' : '+ Create Game'}
      </button>
    </div>
  );
}

function GameLobbyPane({
  lobby,
  isCreator,
  currentUserId,
  inviteInput,
  setInviteInput,
  onInvite,
  onRevoke,
  onKick,
  onLeave,
  onCancel,
  onPickPower,
  onAssignPlayer,
  onAssignAi,
  onStart,
  starting,
}: {
  lobby: LobbyState;
  isCreator: boolean;
  currentUserId: string | null;
  inviteInput: string;
  setInviteInput: (v: string) => void;
  onInvite: () => void;
  onRevoke: (invitationId: string) => void;
  onKick: (userId: string) => void;
  onLeave: () => void;
  onCancel: () => void;
  onPickPower: (power: Power | null) => void;
  onAssignPlayer: (userId: string, power: string | null) => void;
  onAssignAi: (aiIndex: number, power: string | null) => void;
  onStart: () => void;
  starting: boolean;
}) {
  const pendingInvites = lobby.invitations.filter((i) => i.status === 'pending');
  const me = lobby.players.find((p) => p.userId === currentUserId) ?? null;
  const myLocked = me?.locked ?? false;

  // Show players alphabetically by username (case-insensitive)
  const sortedPlayers = [...lobby.players].sort((a, b) =>
    a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }),
  );

  // Derive AI slots sized to pad up to 4 total slots (humans + ai)
  const aiSlotCount = Math.max(0, 4 - sortedPlayers.length);
  const aiSlots: { power: string | null; locked: boolean }[] = [];
  for (let i = 0; i < aiSlotCount; i++) {
    aiSlots.push(lobby.aiSlots[i] ?? { power: null, locked: false });
  }

  // "Taken" for UI-disable purposes: powers held by LOCKED slots are
  // immovable. Unlocked AI slots can be stolen via self-pick, so don't
  // count them as taken. Powers held by other humans are also immovable
  // to joiners (creator can still takeover via `allowTakeover`).
  const takenPowers = new Set<string>([
    ...sortedPlayers.map((p) => p.power).filter((x): x is string => !!x),
    ...aiSlots.filter((s) => s.locked && s.power).map((s) => s.power as string),
  ]);
  const humanAssignedCount = sortedPlayers.filter((p) => !!p.power).length;
  const aiAssignedCount = aiSlots.filter((s) => !!s.power).length;
  const canStart = humanAssignedCount === sortedPlayers.length
    && humanAssignedCount + aiAssignedCount >= 2;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem', flex: 1 }}>{lobby.game.name ?? 'Game'}</h2>
        <span style={{
          fontSize: '0.7rem', padding: '2px 6px', borderRadius: 3,
          background: lobby.game.isPublic ? '#1e3a5e' : '#374151',
          color: lobby.game.isPublic ? '#7dd3fc' : '#cbd5e1',
        }}>
          {lobby.game.isPublic ? 'PUBLIC' : 'PRIVATE'}
        </span>
        {isCreator ? (
          <button className="danger" onClick={onCancel} style={{ fontSize: '0.7rem' }}>
            Cancel Game
          </button>
        ) : (
          <button className="secondary" onClick={onLeave} style={{ fontSize: '0.7rem' }}>
            Leave
          </button>
        )}
      </div>

      {/* Invite */}
      {isCreator && lobby.players.length < 4 && (
        <div style={{ marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.75rem', color: '#888', marginBottom: '0.3rem' }}>Invite</div>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <input
              type="text"
              placeholder="username or email"
              value={inviteInput}
              onChange={(e) => setInviteInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onInvite())}
              style={{ flex: 1, fontSize: '0.8rem' }}
            />
            <button
              className="primary"
              onClick={onInvite}
              disabled={!inviteInput.trim()}
              style={{ fontSize: '0.75rem' }}
            >
              Send
            </button>
          </div>
          {pendingInvites.length > 0 && (
            <div style={{ marginTop: '0.4rem' }}>
              {pendingInvites.map((i) => (
                <div key={i.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  fontSize: '0.7rem', color: '#888', padding: '2px 0',
                }}>
                  <span>{i.label} <em style={{ color: '#facc15' }}>(pending)</em></span>
                  <button
                    className="secondary"
                    onClick={() => onRevoke(i.id)}
                    style={{ fontSize: '0.6rem', padding: '1px 5px' }}
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Power slots (visible to everyone) */}
      <div>
        <div style={{ fontSize: '0.75rem', color: '#888', marginBottom: '0.3rem' }}>
          Power Assignment
        </div>

        {/* Human slots (alphabetical) */}
        {sortedPlayers.map((p) => {
          const isMe = p.userId === currentUserId;
          const canInteract =
            // creator can set any human's power
            isCreator ||
            // joiner (me), only if not locked
            (isMe && !p.locked);
          return (
            <SlotRow
              key={`h-${p.userId}`}
              label={
                <>
                  {p.username}
                  {p.isCreator && <span style={{ color: '#facc15', marginLeft: '0.3rem' }}>★</span>}
                  {p.locked && <span style={{ opacity: 0.6, marginLeft: '0.3rem' }}>🔒</span>}
                </>
              }
              currentPower={p.power}
              takenPowers={takenPowers}
              disabled={!canInteract}
              allowTakeover={isCreator}
              onPick={(pw) => {
                if (isCreator) {
                  onAssignPlayer(p.userId, pw);
                } else if (isMe) {
                  onPickPower(pw as Power | null);
                }
              }}
              hintWhenDisabled={
                isMe && p.locked ? 'Host has locked your power' :
                !isMe && !isCreator ? null :
                null
              }
              rightAction={
                isCreator && !p.isCreator ? (
                  <button
                    className="secondary"
                    onClick={() => onKick(p.userId)}
                    style={{ fontSize: '0.65rem', padding: '2px 6px' }}
                  >
                    Kick
                  </button>
                ) : null
              }
            />
          );
        })}

        {/* AI padding slots */}
        {aiSlots.map((slot, i) => (
          <SlotRow
            key={`ai-${i}`}
            label={
              <span style={{ color: '#93c5fd' }}>
                AI #{i + 1}
                {slot.locked && <span style={{ opacity: 0.6, marginLeft: '0.3rem' }}>🔒</span>}
              </span>
            }
            currentPower={slot.power}
            takenPowers={takenPowers}
            disabled={!isCreator}
            allowOff
            allowTakeover={isCreator}
            onPick={(pw) => onAssignAi(i, pw)}
            hintWhenDisabled={null}
          />
        ))}

        {isCreator && (
          <button
            className="primary"
            onClick={onStart}
            disabled={starting || !canStart}
            style={{ width: '100%', marginTop: '0.75rem', padding: '0.5rem' }}
            title={!canStart ? 'Every player needs a power and at least 2 powers must be active' : ''}
          >
            {starting ? 'Starting…' : 'Start Game'}
          </button>
        )}

        {!isCreator && (
          <div style={{ fontSize: '0.7rem', color: '#666', marginTop: '0.4rem' }}>
            {myLocked
              ? 'The host has locked your power assignment.'
              : 'Pick a power. The host can override.'}
          </div>
        )}
      </div>
    </div>
  );
}

function SlotRow({
  label,
  currentPower,
  takenPowers,
  disabled,
  allowOff = false,
  allowTakeover = false,
  onPick,
  hintWhenDisabled,
  rightAction = null,
}: {
  label: React.ReactNode;
  currentPower: string | null;
  takenPowers: Set<string>;
  disabled: boolean;
  allowOff?: boolean;
  /** If true, the caller can click a power held elsewhere (server will swap). */
  allowTakeover?: boolean;
  onPick: (power: string | null) => void;
  hintWhenDisabled: string | null;
  /** Rendered at the far right of the row (e.g. Kick). */
  rightAction?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.5rem',
      padding: '0.3rem 0.5rem', borderBottom: '1px solid #2d2d5e',
      fontSize: '0.8rem',
    }}>
      <span style={{ minWidth: 90, flex: '0 0 auto' }}>{label}</span>
      <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', flex: 1 }}>
        {ALL_POWERS.map((power) => {
          const isCurrent = currentPower === power;
          const isTakenElsewhere = !isCurrent && takenPowers.has(power);
          const btnDisabled = disabled || (isTakenElsewhere && !allowTakeover);
          return (
            <button
              key={power}
              disabled={btnDisabled}
              onClick={() => onPick(isCurrent ? null : power)}
              title={
                disabled ? (hintWhenDisabled ?? '') :
                isTakenElsewhere && allowTakeover ? 'Take over (swaps with current holder)' :
                isTakenElsewhere ? 'Already taken' :
                isCurrent ? 'Click to unselect' : `Pick ${POWER_LABELS[power]}`
              }
              style={{
                fontSize: '0.7rem', padding: '3px 0',
                width: 72, textAlign: 'center',
                background: isCurrent ? POWER_COLORS[power] : 'transparent',
                color: isCurrent ? '#fff' : POWER_COLORS[power],
                border: `1px ${isTakenElsewhere && allowTakeover ? 'dashed' : 'solid'} ${POWER_COLORS[power]}`,
                fontWeight: isCurrent ? 700 : 400,
                opacity: btnDisabled && !isCurrent ? 0.45 : 1,
              }}
            >
              {POWER_LABELS[power]}
            </button>
          );
        })}
        {allowOff && (() => {
          const isOff = currentPower === null;
          return (
            <button
              disabled={disabled}
              onClick={() => onPick(null)}
              title={isOff ? 'Already off' : 'Disable this AI slot'}
              style={{
                fontSize: '0.7rem', padding: '3px 0',
                width: 72, textAlign: 'center',
                background: isOff ? '#64748b' : 'transparent',
                color: isOff ? '#fff' : '#94a3b8',
                border: '1px solid #64748b',
                fontWeight: isOff ? 700 : 400,
                opacity: disabled && !isOff ? 0.45 : 1,
              }}
            >
              Off
            </button>
          );
        })()}
      </div>
      {rightAction && (
        <div style={{ flex: '0 0 auto', marginLeft: 'auto' }}>{rightAction}</div>
      )}
    </div>
  );
}
