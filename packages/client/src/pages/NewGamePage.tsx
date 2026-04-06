import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import type { Power, PlayerType } from '@ruin/engine';
import { createGame } from '../api/client.js';

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
const POWER_LABELS: Record<Power, string> = {
  xarm: 'Xarm',
  gormen: 'Gormen',
  tenzen: 'Tenzen',
  lasha: 'Lasha',
};
const POWER_DESCRIPTIONS: Record<Power, string> = {
  xarm: 'Masters of war and conquest',
  gormen: 'Lords of pestilence and growth',
  tenzen: 'Weavers of sorcery and change',
  lasha: 'Princes of excess and pleasure',
};

type PlayerTypeChoice = PlayerType;

interface PowerConfig {
  enabled: boolean;
  playerType: PlayerTypeChoice;
  inviteEmail: string;
}

function defaultConfig(): Record<Power, PowerConfig> {
  return {
    xarm: { enabled: true, playerType: 'human', inviteEmail: '' },
    gormen: { enabled: true, playerType: 'ai', inviteEmail: '' },
    tenzen: { enabled: false, playerType: 'ai', inviteEmail: '' },
    lasha: { enabled: false, playerType: 'ai', inviteEmail: '' },
  };
}

export default function NewGamePage() {
  const navigate = useNavigate();
  const [config, setConfig] = useState<Record<Power, PowerConfig>>(defaultConfig);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const enabledPowers = ALL_POWERS.filter((p) => config[p].enabled);

  function togglePower(power: Power) {
    const next = enabledPowers.length;
    const isEnabled = config[power].enabled;
    // Can't have fewer than 2 or more than 4
    if (!isEnabled && next >= 4) return;
    if (isEnabled && next <= 2) return;
    setConfig((prev) => ({
      ...prev,
      [power]: { ...prev[power]!, enabled: !isEnabled },
    }));
  }

  function setPlayerType(power: Power, playerType: PlayerTypeChoice) {
    setConfig((prev) => ({
      ...prev,
      [power]: { ...prev[power]!, playerType, inviteEmail: '' },
    }));
  }

  function setInviteEmail(power: Power, email: string) {
    setConfig((prev) => ({
      ...prev,
      [power]: { ...prev[power]!, inviteEmail: email },
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (enabledPowers.length < 2) {
      setError('Select at least 2 powers.');
      return;
    }

    const playerTypes: Record<string, string> = {};
    const inviteEmails: Array<{ power: string; email: string }> = [];

    for (const power of enabledPowers) {
      const cfg = config[power];
      if (!cfg) continue;
      playerTypes[power] = cfg.playerType;
      if (cfg.playerType === 'guest' && cfg.inviteEmail) {
        inviteEmails.push({ power, email: cfg.inviteEmail });
      }
    }

    setLoading(true);
    try {
      const res = await createGame({
        powers: enabledPowers,
        playerTypes,
        inviteEmails,
      });
      navigate(`/games/${res.gameId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create game');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 560 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
        <Link to="/games" style={{ color: '#aaa', fontSize: '0.9rem' }}>← Back</Link>
        <h1 style={{ margin: 0 }}>New Game</h1>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <h2>Select Powers (2–4)</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            {ALL_POWERS.map((power) => {
              const cfg = config[power]!;
              const canDisable = enabledPowers.length > 2;
              const canEnable = enabledPowers.length < 4;
              return (
                <div
                  key={power}
                  onClick={() => togglePower(power)}
                  style={{
                    border: `2px solid`,
                    borderColor: cfg.enabled
                      ? `var(--power-${power}-color, #7c3aed)`
                      : '#2d2d5e',
                    borderRadius: 6,
                    padding: '0.75rem',
                    cursor: (cfg.enabled ? canDisable : canEnable) ? 'pointer' : 'not-allowed',
                    opacity: (!cfg.enabled && !canEnable) ? 0.4 : 1,
                    background: cfg.enabled ? '#1e1e3a' : '#16213e',
                  }}
                  className={cfg.enabled ? `power-border-${power}` : ''}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className={cfg.enabled ? `power-${power}` : ''} style={{ fontWeight: 700 }}>
                      {POWER_LABELS[power]}
                    </span>
                    <span style={{ fontSize: '1rem' }}>{cfg.enabled ? '✓' : ''}</span>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#888', marginTop: '0.25rem' }}>
                    {POWER_DESCRIPTIONS[power]}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {enabledPowers.length >= 2 && (
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <h2>Player Assignment</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {enabledPowers.map((power) => {
                const cfg = config[power]!;
                return (
                  <div key={power}>
                    <div style={{ fontWeight: 600, marginBottom: '0.4rem' }} className={`power-${power}`}>
                      {POWER_LABELS[power]}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                      {(['human', 'ai', 'guest'] as PlayerTypeChoice[]).map((pt) => (
                        <button
                          key={pt}
                          type="button"
                          onClick={() => setPlayerType(power, pt)}
                          className={cfg.playerType === pt ? 'primary' : 'secondary'}
                          style={{ flex: '1', minWidth: 70 }}
                        >
                          {pt === 'human' ? 'Human (you)' : pt === 'ai' ? 'AI' : 'Guest (invite)'}
                        </button>
                      ))}
                    </div>
                    {cfg.playerType === 'guest' && (
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label htmlFor={`email-${power}`}>Invite email</label>
                        <input
                          id={`email-${power}`}
                          type="email"
                          placeholder="guest@example.com"
                          value={cfg.inviteEmail}
                          onChange={(e) => setInviteEmail(power, e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {error && <p className="error-msg" style={{ marginBottom: '0.75rem' }}>{error}</p>}

        <button
          type="submit"
          className="primary"
          disabled={loading || enabledPowers.length < 2}
          style={{ width: '100%', padding: '0.65rem' }}
        >
          {loading ? 'Creating game…' : 'Create Game'}
        </button>
      </form>
    </div>
  );
}
