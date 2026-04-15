import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import type { Power, PlayerType } from '@ruin/engine';
import { createGame, createMultiplayerGame } from '../api/client.js';
import { POWER_COLORS, POWER_LABELS } from '../lib/display.js';

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

const POWER_DESCRIPTIONS: Record<Power, string> = {
  xarm: 'Typically wins by dial. Advancement is earned by killing in battle. War Cry blocks all enemy corruption in a region, working against opponents\' efforts to ruin regions.',
  gormen: 'Cheap warriors lead to easy dominations and secure positions. Dominate valuable regions repeatedly to win by VP.',
  tenzen: 'Avoid direct confrontation with cards while piling in cultists to rapidly ruin regions. Win by chaining ruinations and shutting opponents out.',
  lasha: 'Steal valuable dominations while advancing the dial, and sneak into ruinations when the hard work is done. Stay flexible and take advantage of opportunities.',
};

type Mode = 'singleplayer' | 'multiplayer';
type PowerSetting = 'human' | 'ai' | 'none';

interface PowerConfig {
  setting: PowerSetting;
}

function defaultSPConfig(): Record<Power, PowerConfig> {
  return {
    xarm: { setting: 'human' },
    gormen: { setting: 'ai' },
    tenzen: { setting: 'ai' },
    lasha: { setting: 'ai' },
  };
}

export default function NewGamePage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('singleplayer');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Single player state
  const [spConfig, setSPConfig] = useState<Record<Power, PowerConfig>>(defaultSPConfig);

  // Multiplayer state
  const [gameName, setGameName] = useState('');
  const [isPublic, setIsPublic] = useState(false);

  const activePowers = ALL_POWERS.filter(p => spConfig[p].setting !== 'none');

  function cycleSetting(power: Power) {
    setSPConfig(prev => {
      const order: PowerSetting[] = ['human', 'ai', 'none'];
      const cur = prev[power].setting;
      const next = order[(order.indexOf(cur) + 1) % order.length]!;
      return { ...prev, [power]: { setting: next } };
    });
  }

  async function handleSingleplayer(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (activePowers.length < 2) { setError('Need at least 2 active powers.'); return; }

    const playerTypes: Record<string, string> = {};
    for (const p of activePowers) playerTypes[p] = spConfig[p].setting;

    setLoading(true);
    try {
      const res = await createGame({ mode: 'singleplayer', powers: activePowers, playerTypes } as any);
      navigate(`/games/${res.gameId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create game');
    } finally {
      setLoading(false);
    }
  }

  async function handleMultiplayer(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!gameName.trim()) { setError('Give your game a name.'); return; }

    setLoading(true);
    try {
      const res = await createMultiplayerGame(gameName.trim(), isPublic);
      navigate(`/lobby/g/${res.gameId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create game');
    } finally {
      setLoading(false);
    }
  }

  const settingLabel: Record<PowerSetting, string> = { human: 'Human', ai: 'AI', none: 'Off' };
  const settingColor: Record<PowerSetting, string> = { human: '#86efac', ai: '#93c5fd', none: '#64748b' };

  return (
    <div className="page" style={{ maxWidth: 560 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
        <Link to="/home" style={{ color: '#aaa', fontSize: '0.9rem' }}>← Back</Link>
        <h1 style={{ margin: 0 }}>New Game</h1>
      </div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
        {(['singleplayer', 'multiplayer'] as Mode[]).map(m => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={mode === m ? 'primary' : 'secondary'}
            style={{ flex: 1 }}
          >
            {m === 'singleplayer' ? 'Single Player' : 'Multiplayer'}
          </button>
        ))}
      </div>

      {mode === 'singleplayer' && (
        <form onSubmit={handleSingleplayer}>
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <h2>Powers</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              {ALL_POWERS.map(power => {
                const cfg = spConfig[power];
                const active = cfg.setting !== 'none';
                return (
                  <div
                    key={power}
                    onClick={() => cycleSetting(power)}
                    style={{
                      border: '2px solid',
                      borderColor: active ? POWER_COLORS[power] : '#2d2d5e',
                      borderRadius: 6,
                      padding: '0.75rem',
                      cursor: 'pointer',
                      opacity: active ? 1 : 0.5,
                      background: active ? '#1e1e3a' : '#16213e',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 700, color: active ? POWER_COLORS[power] : undefined }}>
                        {POWER_LABELS[power]}
                      </span>
                      <span style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 4,
                        background: settingColor[cfg.setting] + '22',
                        color: settingColor[cfg.setting],
                      }}>
                        {settingLabel[cfg.setting]}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.72rem', color: '#888', marginTop: '0.25rem', lineHeight: 1.4 }}>
                      {POWER_DESCRIPTIONS[power]}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '0.75rem' }}>
              Click a power to cycle: Human → AI → Off. At least 2 must be active.
            </div>
          </div>

          {error && <p className="error-msg" style={{ marginBottom: '0.75rem' }}>{error}</p>}

          <button
            type="submit"
            className="primary"
            disabled={loading || activePowers.length < 2}
            style={{ width: '100%', padding: '0.65rem' }}
          >
            {loading ? 'Creating…' : 'Start Game'}
          </button>
        </form>
      )}

      {mode === 'multiplayer' && (
        <form onSubmit={handleMultiplayer}>
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <h2>Game Settings</h2>
            <div className="form-group">
              <label htmlFor="game-name">Game Name</label>
              <input
                id="game-name"
                type="text"
                placeholder="e.g. Friday Night Ruin"
                value={gameName}
                onChange={e => setGameName(e.target.value)}
                maxLength={60}
              />
            </div>
            <div
              onClick={() => setIsPublic(!isPublic)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                marginTop: '0.75rem',
                padding: '0.6rem 0.75rem',
                borderRadius: 6,
                border: `2px solid ${isPublic ? '#6366f1' : '#2d2d5e'}`,
                background: isPublic ? '#1e1b4b' : '#16213e',
                cursor: 'pointer',
              }}
            >
              <div style={{
                width: 22,
                height: 22,
                borderRadius: 4,
                border: `2px solid ${isPublic ? '#818cf8' : '#4b5563'}`,
                background: isPublic ? '#6366f1' : 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                fontSize: '0.8rem',
                color: '#fff',
                fontWeight: 700,
              }}>
                {isPublic && '✓'}
              </div>
              <span style={{ fontSize: '0.85rem', color: isPublic ? '#c7d2fe' : '#888' }}>
                Public game (anyone can find and join)
              </span>
            </div>
          </div>

          {error && <p className="error-msg" style={{ marginBottom: '0.75rem' }}>{error}</p>}

          <button
            type="submit"
            className="primary"
            disabled={loading || !gameName.trim()}
            style={{ width: '100%', padding: '0.65rem' }}
          >
            {loading ? 'Creating…' : 'Create Lobby'}
          </button>
        </form>
      )}
    </div>
  );
}
