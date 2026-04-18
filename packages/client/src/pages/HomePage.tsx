import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listGames, type GameSummary } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.js';
import { POWER_LABELS } from '../lib/display.js';
import './HomePage.css';

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return dateStr; }
}

function isMultiplayer(game: GameSummary): boolean {
  return game.name !== null;
}

function GameRow({ game, userId }: { game: GameSummary; userId: string | null }) {
  const isPending = game.status === 'pending';
  const link = isPending ? `/lobby/g/${game.id}` : `/games/${game.id}`;
  const myPowerEntry = game.powers.find((p) => p.userId === userId);
  const multiplayer = isMultiplayer(game);
  const humans = game.powers.filter((p) => p.playerType === 'human');

  // Left border strip colored by the player's own power (if any), else the
  // first human's power in multiplayer, else neutral.
  const accentPower =
    myPowerEntry?.power ??
    (multiplayer ? humans[0]?.power : game.powers[0]?.power) ??
    null;
  const accentClass = accentPower ? `home-game-${accentPower}` : '';

  return (
    <Link to={link} className={`home-game ${accentClass}`}>
      <div className="home-game-body">
        {game.name && <div className="home-game-name">{game.name}</div>}
        {isPending ? (
          <div className="home-game-meta">Waiting in lobby</div>
        ) : multiplayer ? (
          <>
            <div className="home-game-powers">
              {humans.map((p) => (
                <span
                  key={p.userId ?? p.power}
                  className={`home-game-power home-game-power-${p.power}`}
                >
                  {p.username ?? POWER_LABELS[p.power as keyof typeof POWER_LABELS] ?? p.power}
                </span>
              ))}
            </div>
            <div className="home-game-meta">
              Round {game.round} · {game.phase}
            </div>
          </>
        ) : (
          <>
            <div className="home-game-powers">
              {game.powers.map((p) => (
                <span
                  key={p.power}
                  className={`home-game-power home-game-power-${p.power}`}
                >
                  {POWER_LABELS[p.power as keyof typeof POWER_LABELS] ?? p.power}
                </span>
              ))}
            </div>
            <div className="home-game-meta">
              Round {game.round} · {game.phase}
              {myPowerEntry && (
                <span className="home-game-meta-you">
                  — you play {POWER_LABELS[myPowerEntry.power as keyof typeof POWER_LABELS] ?? myPowerEntry.power}
                </span>
              )}
            </div>
          </>
        )}
      </div>
      <div className="home-game-status">
        {isPending ? (
          <span className="home-game-status-label home-game-status-lobby">Lobby</span>
        ) : game.isComplete ? (
          <>
            <span className="home-game-status-label home-game-status-complete">Ruined</span>
            {game.winners && game.winners.length > 0 && (
              <div className="home-game-winner">
                {game.winners.map(w => (
                  <span key={w} className={`home-game-power home-game-power-${w}`}>
                    {POWER_LABELS[w as keyof typeof POWER_LABELS] ?? w}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : (
          <span className="home-game-status-label home-game-status-active">
            {multiplayer ? 'Rivals' : 'Solo'}
          </span>
        )}
        <div className="home-game-status-time">{formatDate(game.updatedAt)}</div>
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

  const sortedGames = [...games].sort((a, b) => {
    const bucket = (g: GameSummary) => (g.isComplete ? 2 : isMultiplayer(g) ? 0 : 1);
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return (
    <div className="home">
      <div className="home-grain" aria-hidden="true" />
      <div className="home-vignette" aria-hidden="true" />
      <div className="home-inner">
        <header className="home-header">
          <div>
            <h1 className="home-wordmark">Ruin</h1>
            <p className="home-tagline">a game of four powers</p>
          </div>
          <button className="home-signout" onClick={logout}>Sign out</button>
        </header>

        <div className="home-modes">
          <Link to="/games/new" className="home-mode">
            <div className="home-mode-label">Play Solo</div>
            <div className="home-mode-sub">play against AI opponents</div>
          </Link>
          <Link to="/lobby" className="home-mode">
            <div className="home-mode-label">Summon Rivals</div>
            <div className="home-mode-sub">lobby, chat, and find a game</div>
          </Link>
        </div>

        <h2 className="home-section-title">Your Games</h2>
        {loading && <div className="home-status">Loading…</div>}
        {error && <div className="home-status home-status-error">{error}</div>}
        {!loading && !error && sortedGames.length === 0 && (
          <div className="home-status">No games yet. Pick a mode above.</div>
        )}
        {sortedGames.length > 0 && (
          <div className="home-games">
            {sortedGames.map((g) => <GameRow key={g.id} game={g} userId={userId} />)}
          </div>
        )}
      </div>
    </div>
  );
}
