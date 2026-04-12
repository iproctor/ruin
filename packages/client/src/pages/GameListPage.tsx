import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listGames, type GameSummary } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.js';
import { POWER_COLORS, POWER_LABELS } from '../lib/display.js';

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function GameRow({ game, userId }: { game: GameSummary; userId: string | null }) {
  const myPowerEntry = game.powers.find((p) => p.userId === userId);
  const powers = game.powers.map((p) => p.power);

  return (
    <Link
      to={`/games/${game.id}`}
      style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}
    >
      <div
        className="card"
        style={{
          marginBottom: '0.75rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          cursor: 'pointer',
          borderColor: '#3a3a6e',
        }}
      >
        <div>
          <div className="flex-row" style={{ flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.25rem' }}>
            {powers.map((p) => (
              <span
                key={p}
                style={{ fontWeight: 600, fontSize: '0.9rem', color: POWER_COLORS[p as keyof typeof POWER_COLORS] }}
              >
                {POWER_LABELS[p as keyof typeof POWER_LABELS] ?? p}
              </span>
            ))}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#888' }}>
            Round {game.round} &bull; Phase: {game.phase}
            {myPowerEntry && (
              <span style={{ marginLeft: '0.5rem', fontWeight: 600, color: POWER_COLORS[myPowerEntry.power as keyof typeof POWER_COLORS] }}>
                (You: {POWER_LABELS[myPowerEntry.power as keyof typeof POWER_LABELS] ?? myPowerEntry.power})
              </span>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          {game.isComplete ? (
            <span style={{ color: '#facc15', fontSize: '0.8rem' }}>Completed</span>
          ) : (
            <span style={{ color: '#86efac', fontSize: '0.8rem' }}>Active</span>
          )}
          <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '0.2rem' }}>
            {formatDate(game.updatedAt)}
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function GameListPage() {
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
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1>Your Games</h1>
        <div className="flex-row">
          <Link to="/games/new">
            <button className="primary">New Game</button>
          </Link>
          <button className="secondary" onClick={logout}>Sign out</button>
        </div>
      </div>

      {loading && <p style={{ color: '#aaa' }}>Loading…</p>}
      {error && <p className="error-msg">{error}</p>}
      {!loading && !error && games.length === 0 && (
        <div className="card" style={{ textAlign: 'center', color: '#aaa' }}>
          <p>No games yet.</p>
          <p style={{ marginTop: '0.5rem' }}>
            <Link to="/games/new">Create your first game</Link>
          </p>
        </div>
      )}
      {[...games]
        .sort((a, b) => {
          if (a.isComplete !== b.isComplete) return a.isComplete ? 1 : -1;
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        })
        .map((g) => (
          <GameRow key={g.id} game={g} userId={userId} />
        ))}
    </div>
  );
}
