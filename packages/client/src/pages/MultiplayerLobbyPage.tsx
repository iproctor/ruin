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
import './LobbyPage.css';

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
      navigate('/lobby');
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
    <main className="lobby">
      <div className="lobby-grain" aria-hidden="true" />
      <div className="lobby-vignette" aria-hidden="true" />

      <header className="lobby-head">
        <Link to="/home" className="lobby-back">← return</Link>
        <h1 className="lobby-title">Lobby</h1>
        <span className="lobby-head-spacer" aria-hidden="true" />
        <span className="lobby-online-count">{snap?.online.length ?? 0} online</span>
        <button className="lobby-signout" onClick={logout}>Sign out</button>
      </header>

      {error && (
        <div className="lobby-error" onClick={() => setError('')} role="alert">
          {error}
        </div>
      )}

      <div className="lobby-body">
        <section className="lobby-panel lobby-chat">
          <div className="lobby-chat-tabs">
            <button
              className={`lobby-tab ${chatTab === 'global' ? 'is-active' : ''}`}
              onClick={() => setChatTab('global')}
            >
              Global
            </button>
            {showGameTab && (
              <button
                className={`lobby-tab ${chatTab === 'game' ? 'is-active' : ''}`}
                onClick={() => setChatTab('game')}
              >
                Game
              </button>
            )}
          </div>

          <div className="lobby-chat-body">
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

          <div className="lobby-chat-input">
            <input
              className="lobby-input"
              type="text"
              placeholder={chatTab === 'global' ? 'Speak freely…' : 'Game chat…'}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleSendChat())}
            />
            <button
              className="lobby-send"
              onClick={handleSendChat}
              disabled={!chatInput.trim()}
              aria-label="Send"
            >
              →
            </button>
          </div>
        </section>

        <section className="lobby-panel lobby-games">
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
            <p className="lobby-games-empty">Loading game…</p>
          )}
        </section>
      </div>
    </main>
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
    <div className="lobby-online">
      <div className="lobby-online-label">Online · {users.length}</div>
      {users.length === 0 && <div className="lobby-online-empty">No gods are watching.</div>}
      {users.map((u) => {
        const isMe = u.userId === currentUserId;
        const clickable = canInvite && !isMe && !u.inGame;
        const classes = [
          'lobby-online-row',
          clickable && 'is-clickable',
          isMe && 'is-me',
          u.inGame && 'is-busy',
        ].filter(Boolean).join(' ');
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
            className={classes}
          >
            <span className="lobby-online-dot" aria-hidden="true" />
            <span>{u.username}</span>
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
  const globalRows: React.ReactNode[] = [];
  let prevGlobalTs = 0;
  for (const m of global) {
    const ts = new Date(m.createdAt).getTime();
    if (ts - prevGlobalTs >= TEN_MIN_MS) {
      globalRows.push(
        <ChatTimestampSeparator key={`sep-${m.id}`} ts={ts} />,
      );
    }
    prevGlobalTs = ts;
    const onlineUser = online.find((o) => o.userId === m.userId);
    const isMe = m.userId === currentUserId;
    const clickable = canInvite && !isMe && onlineUser && !onlineUser.inGame;
    const nameClass = [
      'lobby-chat-name',
      isMe && 'is-me',
      clickable && 'is-clickable',
    ].filter(Boolean).join(' ');
    globalRows.push(
      <div key={m.id} className="lobby-chat-row">
        <span
          className={nameClass}
          onClick={() => clickable && onInviteByUserId(m.userId)}
          title={clickable ? 'Click to invite to your game' : ''}
        >
          {m.username}:
        </span>{' '}
        <span className="lobby-chat-text">{m.message}</span>
      </div>,
    );
  }

  return (
    <div className="lobby-chat-history">
      {tab === 'global' && globalRows}
      {tab === 'game' && game.map((m) => (
        <div key={m.id} className="lobby-chat-row">
          <span
            className="lobby-chat-name"
            style={m.power ? { color: POWER_COLORS[m.power as Power] } : undefined}
          >
            {m.username}:
          </span>{' '}
          <span className="lobby-chat-text">{m.message}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

const TEN_MIN_MS = 10 * 60 * 1000;

function ChatTimestampSeparator({ ts }: { ts: number }) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const label = sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return <div className="lobby-chat-sep">{label}</div>;
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
      <div className="lobby-create-panel">
        <div className="lobby-create-head">
          <button
            type="button"
            className="lobby-back"
            onClick={() => setShowCreate(false)}
          >
            ← back
          </button>
          <h2 className="lobby-create-title">New Game</h2>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <label className="lobby-field">
            <span className="lobby-field-label">Game Name</span>
            <input
              className="lobby-field-input"
              id="game-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Friday Night Ruin"
              maxLength={60}
              autoFocus
            />
          </label>
          <button
            type="button"
            onClick={() => setIsPublic((v) => !v)}
            className={`lobby-toggle ${isPublic ? 'is-on' : ''}`}
            aria-pressed={isPublic}
          >
            <span className="lobby-toggle-box" aria-hidden="true">{isPublic && '✕'}</span>
            <span className="lobby-toggle-body">
              <span className="lobby-toggle-name">Public</span>
              <span className="lobby-toggle-note">
                {isPublic
                  ? 'Any god may answer. Seen in the open lobby.'
                  : 'Only invited names may enter.'}
              </span>
            </span>
          </button>
          {createError && <p className="lobby-error" style={{ marginTop: '0.25rem' }}>{createError}</p>}
          <button type="submit" className="lobby-create" disabled={creating || !name.trim()}>
            <span className="lobby-create-label">
              {creating ? 'Creating…' : 'Create Game'}
            </span>
          </button>
        </form>
      </div>
    );
  }

  return (
    <>
      <div className="lobby-games-head">
        <h2 className="lobby-games-title">Open Games</h2>
        <span className="lobby-games-count">
          {games.length === 0 ? '' : `${games.length} open`}
        </span>
      </div>
      <div className="lobby-games-list">
        {games.length === 0 && (
          <p className="lobby-games-empty">The halls are empty.</p>
        )}
        {games.map((g) => {
          const isYours = g.createdBy === currentUserId;
          return (
            <button
              type="button"
              key={g.id}
              onClick={() => isYours ? navigate(`/lobby/g/${g.id}`) : onJoin(g)}
              className={`lobby-game ${g.invitedYou ? 'is-invited' : ''}`}
            >
              <div className="lobby-game-row-top">
                <span className="lobby-game-name">{g.name ?? '(unnamed)'}</span>
                <span className="lobby-game-badges">
                  {g.invitedYou && <span className="lobby-badge invited">Invited</span>}
                  {!g.isPublic && <span className="lobby-badge private">Private</span>}
                  <span className="lobby-game-count">{g.players.length} / 4</span>
                </span>
              </div>
              <div className="lobby-game-meta">
                <em>host</em> {g.createdByUsername}
                {g.players.length > 1 && (
                  <> · {g.players.slice(1).map((p) => p.username).join(', ')}</>
                )}
              </div>
            </button>
          );
        })}
      </div>
      <button
        className="lobby-create"
        onClick={() => {
          if (myCreatedGameId) navigate(`/lobby/g/${myCreatedGameId}`);
          else setShowCreate(true);
        }}
      >
        <span className="lobby-create-label">
          {myCreatedGameId ? 'Open Your Game' : 'Create Game'}
        </span>
      </button>
    </>
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
    <div className="glp">
      <div className="glp-head">
        <h2 className="glp-name">{lobby.game.name ?? 'Game'}</h2>
        <span className={`glp-badge ${lobby.game.isPublic ? 'public' : 'private'}`}>
          {lobby.game.isPublic ? 'Public' : 'Private'}
        </span>
        {isCreator ? (
          <button className="glp-head-btn is-danger" onClick={onCancel}>
            Cancel Game
          </button>
        ) : (
          <button className="glp-head-btn" onClick={onLeave}>
            Leave
          </button>
        )}
      </div>

      {isCreator && lobby.players.length < 4 && (
        <div className="glp-invite">
          <div className="glp-label">Invite</div>
          <div className="glp-invite-row">
            <input
              type="text"
              placeholder="username"
              value={inviteInput}
              onChange={(e) => setInviteInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onInvite())}
            />
            <button
              className="glp-invite-send"
              onClick={onInvite}
              disabled={!inviteInput.trim()}
            >
              Send
            </button>
          </div>
          {pendingInvites.length > 0 && (
            <div className="glp-pending">
              {pendingInvites.map((i) => (
                <div key={i.id} className="glp-pending-row">
                  <span>{i.label} <em>pending</em></span>
                  <button
                    className="glp-pending-revoke"
                    onClick={() => onRevoke(i.id)}
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div>
        <div className="glp-label">Power Assignment</div>

        <div className="glp-slots">
          {sortedPlayers.map((p) => {
            const isMe = p.userId === currentUserId;
            const canInteract = isCreator || (isMe && !p.locked);
            return (
              <SlotRow
                key={`h-${p.userId}`}
                label={
                  <>
                    {p.username}
                    {p.isCreator && <span className="glp-mark-creator">★</span>}
                    {p.locked && <span className="glp-mark-lock">🔒</span>}
                  </>
                }
                currentPower={p.power}
                takenPowers={takenPowers}
                disabled={!canInteract}
                allowTakeover={isCreator}
                onPick={(pw) => {
                  if (isCreator) onAssignPlayer(p.userId, pw);
                  else if (isMe) onPickPower(pw as Power | null);
                }}
                hintWhenDisabled={isMe && p.locked ? 'Host has locked your power' : null}
                rightAction={
                  isCreator && !p.isCreator ? (
                    <button className="glp-slot-kick" onClick={() => onKick(p.userId)}>
                      Kick
                    </button>
                  ) : null
                }
              />
            );
          })}

          {aiSlots.map((slot, i) => (
            <SlotRow
              key={`ai-${i}`}
              isAi
              label={
                <>
                  AI #{i + 1}
                  {slot.locked && <span className="glp-mark-lock">🔒</span>}
                </>
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
        </div>

        {isCreator ? (
          <button
            className="lobby-create"
            style={{ marginTop: '0.85rem' }}
            onClick={onStart}
            disabled={starting || !canStart}
            title={!canStart ? 'Every player needs a power and at least 2 powers must be active' : ''}
          >
            <span className="lobby-create-label">
              {starting ? 'Starting…' : 'Begin'}
            </span>
          </button>
        ) : (
          <p className="glp-hint">
            {myLocked
              ? 'The host has locked your power assignment.'
              : 'Pick a power. The host can override.'}
          </p>
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
  isAi = false,
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
  isAi?: boolean;
}) {
  return (
    <div className="glp-slot">
      <span className={`glp-slot-label ${isAi ? 'is-ai' : ''}`}>{label}</span>
      <div className="glp-slot-buttons">
        {ALL_POWERS.map((power) => {
          const isCurrent = currentPower === power;
          const isTakenElsewhere = !isCurrent && takenPowers.has(power);
          const btnDisabled = disabled || (isTakenElsewhere && !allowTakeover);
          const classes = [
            'glp-pwr',
            `pwr-${power}`,
            isCurrent && 'is-current',
            isTakenElsewhere && allowTakeover && !isCurrent && 'is-takeover',
          ].filter(Boolean).join(' ');
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
              className={classes}
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
              className={`glp-pwr pwr-off ${isOff ? 'is-current' : ''}`}
            >
              Off
            </button>
          );
        })()}
      </div>
      {rightAction}
    </div>
  );
}
