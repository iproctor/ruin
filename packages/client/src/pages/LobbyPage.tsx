import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import type { Power } from '@ruin/engine';
import { useAuth } from '../contexts/AuthContext.js';
import {
  getLobby,
  invitePlayer,
  leaveGame,
  kickPlayer,
  startGame,
  revokeInvitation,
  sendChat,
  type LobbyState,
  type LobbyPlayer,
  type LobbyInvitation,
  type PowerAssignment,
} from '../api/client.js';
import { connectGameStream, type StreamEvent } from '../api/sse.js';
import { POWER_COLORS, POWER_LABELS } from '../lib/display.js';

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

interface ChatMsg {
  id: string;
  username: string;
  message: string;
  power: string | null;
  createdAt: string;
}

export default function LobbyPage() {
  const { id } = useParams<{ id: string }>();
  const { userId } = useAuth();
  const navigate = useNavigate();

  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [error, setError] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);

  // Power assignments managed by creator
  const [assignments, setAssignments] = useState<Record<Power, { type: 'human' | 'ai' | 'none'; userId?: string }>>({
    xarm: { type: 'none' },
    gormen: { type: 'none' },
    tenzen: { type: 'none' },
    lasha: { type: 'none' },
  });

  const bottomRef = useRef<HTMLDivElement>(null);
  const isCreator = lobby?.game.createdBy === userId;

  // SSE connection
  useEffect(() => {
    if (!id) return;
    const cleanup = connectGameStream(id, (event: StreamEvent) => {
      if (event.type === 'lobby_state') {
        const e = event as any;
        if (e.lobby) setLobby(e.lobby);
        if (e.chat) setChat(e.chat);
      } else if (event.type === 'lobby_update') {
        const e = event as any;
        setLobby(prev => prev ? { ...prev, players: e.players, invitations: e.invitations } : prev);
      } else if (event.type === 'game_started') {
        navigate(`/games/${id}`, { replace: true });
      } else if (event.type === 'chat') {
        const e = event as any;
        setChat(prev => [...prev, e.message]);
      }
    });
    return cleanup;
  }, [id, navigate]);

  // Initial load fallback
  useEffect(() => {
    if (!id) return;
    getLobby(id).then(setLobby).catch(err => {
      setError(err instanceof Error ? err.message : 'Failed to load lobby');
    });
  }, [id]);

  // Auto-scroll chat
  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [chat.length]);

  // Sync assignments when lobby players change
  useEffect(() => {
    if (!lobby) return;
    setAssignments(prev => {
      const next = { ...prev };
      // If a player was assigned a power and left, reset it
      for (const p of ALL_POWERS) {
        if (next[p].type === 'human' && next[p].userId) {
          const still = lobby.players.find(lp => lp.userId === next[p].userId);
          if (!still) next[p] = { type: 'none' };
        }
      }
      return next;
    });
  }, [lobby?.players]);

  async function handleInvite() {
    if (!id || !inviteEmail.trim()) return;
    try {
      await invitePlayer(id, inviteEmail.trim());
      setInviteEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite');
    }
  }

  async function handleKick(targetUserId: string) {
    if (!id) return;
    try { await kickPlayer(id, targetUserId); } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to kick');
    }
  }

  async function handleLeave() {
    if (!id) return;
    try {
      await leaveGame(id);
      navigate('/games', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to leave');
    }
  }

  async function handleRevoke(invitationId: string) {
    if (!id) return;
    try { await revokeInvitation(id, invitationId); } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke');
    }
  }

  async function handleStart() {
    if (!id) return;
    const config: PowerAssignment[] = ALL_POWERS.map(p => ({
      power: p,
      type: assignments[p].type,
      userId: assignments[p].userId,
    }));
    const active = config.filter(c => c.type !== 'none');
    if (active.length < 2) { setError('Need at least 2 active powers.'); return; }

    setStarting(true);
    try {
      await startGame(id, config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start');
    } finally {
      setStarting(false);
    }
  }

  async function handleChat() {
    if (!id || !chatInput.trim() || sending) return;
    setSending(true);
    try {
      await sendChat(id, chatInput.trim());
      setChatInput('');
    } catch { /* ignore */ }
    finally { setSending(false); }
  }

  function setAssignment(power: Power, type: 'human' | 'ai' | 'none', userId?: string) {
    setAssignments(prev => ({ ...prev, [power]: { type, userId } }));
  }

  if (!lobby) {
    return (
      <div className="page" style={{ maxWidth: 600 }}>
        <p style={{ color: '#aaa' }}>{error || 'Loading lobby…'}</p>
      </div>
    );
  }

  const unassignedPlayers = lobby.players.filter(p =>
    !ALL_POWERS.some(pw => assignments[pw].type === 'human' && assignments[pw].userId === p.userId)
  );

  const pendingInvitations = lobby.invitations.filter(i => i.status === 'pending');

  return (
    <div className="page" style={{ maxWidth: 700 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
        <Link to="/games" style={{ color: '#aaa', fontSize: '0.9rem' }}>← Games</Link>
        <h1 style={{ margin: 0, flex: 1 }}>{lobby.game.name ?? 'Game Lobby'}</h1>
        {!isCreator && (
          <button className="secondary" onClick={handleLeave} style={{ fontSize: '0.8rem' }}>Leave</button>
        )}
      </div>

      {error && <p className="error-msg" style={{ marginBottom: '0.75rem' }}>{error}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        {/* Left column: players + powers */}
        <div>
          {/* Players in lobby */}
          <div className="card" style={{ marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1rem' }}>Players ({lobby.players.length}/4)</h2>
            {lobby.players.map(p => (
              <div key={p.userId} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0.4rem 0', borderBottom: '1px solid #2d2d5e',
              }}>
                <span style={{ fontWeight: p.isCreator ? 700 : 400 }}>
                  {p.username} {p.isCreator && <span style={{ fontSize: '0.7rem', color: '#facc15' }}>★</span>}
                </span>
                {isCreator && !p.isCreator && (
                  <button
                    className="secondary"
                    style={{ fontSize: '0.65rem', padding: '2px 6px' }}
                    onClick={() => handleKick(p.userId)}
                  >
                    Kick
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Invite (creator only) */}
          {isCreator && lobby.players.length < 4 && (
            <div className="card" style={{ marginBottom: '1rem' }}>
              <h2 style={{ fontSize: '1rem' }}>Invite</h2>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="email"
                  placeholder="email@example.com"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleInvite())}
                  style={{ flex: 1 }}
                />
                <button className="primary" onClick={handleInvite} disabled={!inviteEmail.trim()}>
                  Send
                </button>
              </div>
              {pendingInvitations.length > 0 && (
                <div style={{ marginTop: '0.5rem' }}>
                  {pendingInvitations.map(inv => (
                    <div key={inv.id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      fontSize: '0.75rem', color: '#888', padding: '2px 0',
                    }}>
                      <span>{inv.email}</span>
                      <button
                        className="secondary"
                        style={{ fontSize: '0.6rem', padding: '1px 4px' }}
                        onClick={() => handleRevoke(inv.id)}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Power assignments (creator only) */}
          {isCreator && (
            <div className="card" style={{ marginBottom: '1rem' }}>
              <h2 style={{ fontSize: '1rem' }}>Power Assignment</h2>
              {ALL_POWERS.map(power => {
                const a = assignments[power];
                return (
                  <div key={power} style={{ marginBottom: '0.75rem' }}>
                    <div style={{ fontWeight: 600, color: POWER_COLORS[power], marginBottom: '0.3rem' }}>
                      {POWER_LABELS[power]}
                    </div>
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                      <button
                        className={a.type === 'none' ? 'primary' : 'secondary'}
                        style={{ fontSize: '0.7rem', padding: '3px 8px' }}
                        onClick={() => setAssignment(power, 'none')}
                      >
                        Off
                      </button>
                      <button
                        className={a.type === 'ai' ? 'primary' : 'secondary'}
                        style={{ fontSize: '0.7rem', padding: '3px 8px' }}
                        onClick={() => setAssignment(power, 'ai')}
                      >
                        AI
                      </button>
                      {lobby.players.map(p => (
                        <button
                          key={p.userId}
                          className={a.type === 'human' && a.userId === p.userId ? 'primary' : 'secondary'}
                          style={{ fontSize: '0.7rem', padding: '3px 8px' }}
                          onClick={() => setAssignment(power, 'human', p.userId)}
                        >
                          {p.username}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}

              <button
                className="primary"
                onClick={handleStart}
                disabled={starting || ALL_POWERS.filter(p => assignments[p].type !== 'none').length < 2}
                style={{ width: '100%', marginTop: '0.5rem', padding: '0.5rem' }}
              >
                {starting ? 'Starting…' : 'Start Game'}
              </button>
            </div>
          )}

          {/* Non-creator view */}
          {!isCreator && (
            <div className="card">
              <p style={{ color: '#888', fontSize: '0.85rem' }}>
                Waiting for the host to assign powers and start the game.
              </p>
            </div>
          )}
        </div>

        {/* Right column: chat */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 300, maxHeight: 500 }}>
          <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Chat</h2>
          <div style={{ flex: 1, overflowY: 'auto', marginBottom: '0.5rem' }}>
            {chat.map(msg => (
              <div key={msg.id} style={{ fontSize: '0.8rem', marginBottom: '0.25rem' }}>
                <span style={{ fontWeight: 600, color: msg.power ? POWER_COLORS[msg.power as Power] : '#6366f1' }}>
                  {msg.username}:
                </span>{' '}
                <span style={{ color: '#cbd5e1' }}>{msg.message}</span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <input
              type="text"
              placeholder="Chat…"
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleChat()}
              style={{ flex: 1, fontSize: '0.8rem' }}
            />
            <button className="primary" onClick={handleChat} disabled={!chatInput.trim() || sending}
              style={{ fontSize: '0.8rem', padding: '4px 10px' }}>
              →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
