import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listGames, type GameSummary } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.js';
import { POWER_COLORS, POWER_LABELS } from '../lib/display.js';

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return dateStr; }
}

function isMultiplayer(game: GameSummary): boolean {
  // Multiplayer games always have a name (set by createMultiplayerGame);
  // singleplayer games leave it null.
  return game.name !== null;
}

function GameRow({ game, userId }: { game: GameSummary; userId: string | null }) {
  const isPending = game.status === 'pending';
  const link = isPending ? `/lobby/g/${game.id}` : `/games/${game.id}`;
  const myPowerEntry = game.powers.find((p) => p.userId === userId);
  const multiplayer = isMultiplayer(game);
  const humans = game.powers.filter((p) => p.playerType === 'human');

  return (
    <Link to={link} style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
      <div className="card" style={{
        marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', gap: '1rem', cursor: 'pointer', borderColor: '#3a3a6e',
      }}>
        <div>
          {game.name && (
            <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.2rem' }}>
              {game.name}
            </div>
          )}
          {isPending ? (
            <div style={{ fontSize: '0.8rem', color: '#888' }}>Waiting in lobby</div>
          ) : multiplayer ? (
            <>
              <div className="flex-row" style={{ flexWrap: 'wrap', gap: '0.6rem', marginBottom: '0.25rem' }}>
                {humans.map((p) => (
                  <span key={p.userId ?? p.power} style={{
                    fontWeight: 600, fontSize: '0.9rem',
                    color: POWER_COLORS[p.power as keyof typeof POWER_COLORS],
                  }}>
                    {p.username ?? POWER_LABELS[p.power as keyof typeof POWER_LABELS] ?? p.power}
                  </span>
                ))}
              </div>
              <div style={{ fontSize: '0.8rem', color: '#888' }}>
                Round {game.round} &bull; Phase: {game.phase}
              </div>
            </>
          ) : (
            <>
              <div className="flex-row" style={{ flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.25rem' }}>
                {game.powers.map((p) => (
                  <span key={p.power} style={{
                    fontWeight: 600, fontSize: '0.9rem',
                    color: POWER_COLORS[p.power as keyof typeof POWER_COLORS],
                  }}>
                    {POWER_LABELS[p.power as keyof typeof POWER_LABELS] ?? p.power}
                  </span>
                ))}
              </div>
              <div style={{ fontSize: '0.8rem', color: '#888' }}>
                Round {game.round} &bull; Phase: {game.phase}
                {myPowerEntry && (
                  <span style={{
                    marginLeft: '0.5rem', fontWeight: 600,
                    color: POWER_COLORS[myPowerEntry.power as keyof typeof POWER_COLORS],
                  }}>
                    (You: {POWER_LABELS[myPowerEntry.power as keyof typeof POWER_LABELS] ?? myPowerEntry.power})
                  </span>
                )}
              </div>
            </>
          )}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          {isPending ? (
            <span style={{ color: '#fbbf24', fontSize: '0.8rem', fontWeight: 600 }}>Lobby</span>
          ) : game.isComplete ? (
            <span style={{ color: '#facc15', fontSize: '0.8rem' }}>Completed</span>
          ) : (
            <span style={{
              color: multiplayer ? '#7dd3fc' : '#86efac',
              fontSize: '0.8rem', fontWeight: 600,
            }}>
              {multiplayer ? 'Multiplayer' : 'Singleplayer'}
            </span>
          )}
          <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '0.2rem' }}>
            {formatDate(game.updatedAt)}
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function HomePage() {
  const { userId, logout } = useAuth();
  const [games, setGames] = useState<GameSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    listGames()
      .then(setGames)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load games'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '1.5rem',
      }}>
        <h1 style={{ margin: 0 }}>Ruin</h1>
        <button className="secondary" onClick={logout}>Sign out</button>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem',
        marginBottom: '2rem',
      }}>
        <Link to="/games/new" style={{ textDecoration: 'none' }}>
          <div className="card" style={{
            padding: '2rem 1rem', textAlign: 'center', cursor: 'pointer',
            border: '2px solid #7c3aed', background: '#1e1e3a',
          }}>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#a78bfa' }}>
              Single Player
            </div>
            <div style={{ fontSize: '0.85rem', color: '#888', marginTop: '0.5rem' }}>
              Play against AI opponents
            </div>
          </div>
        </Link>
        <Link to="/lobby" style={{ textDecoration: 'none' }}>
          <div className="card" style={{
            padding: '2rem 1rem', textAlign: 'center', cursor: 'pointer',
            border: '2px solid #2daade', background: '#16213e',
          }}>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#7dd3fc' }}>
              Online Multiplayer
            </div>
            <div style={{ fontSize: '0.85rem', color: '#888', marginTop: '0.5rem' }}>
              Lobby, chat, and find a game
            </div>
          </div>
        </Link>
      </div>

      <h2 style={{ fontSize: '1.05rem', marginBottom: '0.75rem', color: '#cbd5e1' }}>
        Your Games
      </h2>
      {loading && <p style={{ color: '#aaa' }}>Loading…</p>}
      {error && <p className="error-msg">{error}</p>}
      {!loading && !error && games.length === 0 && (
        <div className="card" style={{ textAlign: 'center', color: '#aaa' }}>
          <p>No games yet. Pick a mode above.</p>
        </div>
      )}
      {[...games]
        .sort((a, b) => {
          // Bucket: active multiplayer (0), active singleplayer (1), completed (2)
          const bucket = (g: GameSummary) =>
            g.isComplete ? 2 : isMultiplayer(g) ? 0 : 1;
          const ba = bucket(a);
          const bb = bucket(b);
          if (ba !== bb) return ba - bb;
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        })
        .map((g) => <GameRow key={g.id} game={g} userId={userId} />)}
    </div>
  );
}
