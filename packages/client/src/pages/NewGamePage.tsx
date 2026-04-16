import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import type { Power } from '@ruin/engine';
import { createGame } from '../api/client.js';
import { PowerSigil } from '../components/PowerSigil.js';
import './NewGamePage.css';

const ALL_POWERS: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];

const POWER_NAMES: Record<Power, string> = {
  xarm: 'Xarm',
  gormen: 'Gormen',
  tenzen: 'Tenzen',
  lasha: 'Lasha',
};

const POWER_EPITHETS: Record<Power, string> = {
  xarm:   'blood for the blood throne',
  gormen: 'ripe with decay',
  tenzen: 'just as planned',
  lasha:  'you asked for this',
};

const POWER_DESCRIPTIONS: Record<Power, string> = {
  xarm:   'Typically wins by dial. Advancement is earned by killing in battle. War Cry blocks all enemy corruption in a region, working against opponents\' efforts to ruin regions.',
  gormen: 'Cheap warriors lead to easy dominations and secure positions. Dominate valuable regions repeatedly to win by VP.',
  tenzen: 'Avoid direct confrontation with cards while piling in cultists to rapidly ruin regions. Win by chaining ruinations and shutting opponents out.',
  lasha:  'Steal valuable dominations while advancing the dial, and sneak into ruinations when the hard work is done. Stay flexible and take advantage of opportunities.',
};

type PowerSetting = 'human' | 'ai' | 'none';

const SETTING_ORDER: PowerSetting[] = ['human', 'ai', 'none'];
const SETTING_LABEL: Record<PowerSetting, string> = { human: 'Human', ai: 'AI', none: 'Off' };

function defaultConfig(): Record<Power, PowerSetting> {
  return { xarm: 'human', gormen: 'ai', tenzen: 'ai', lasha: 'ai' };
}

export default function NewGamePage() {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<Record<Power, PowerSetting>>(defaultConfig);

  const activePowers = ALL_POWERS.filter((p) => config[p] !== 'none');

  function cycleSetting(power: Power) {
    setConfig((prev) => {
      const cur = prev[power];
      const next = SETTING_ORDER[(SETTING_ORDER.indexOf(cur) + 1) % SETTING_ORDER.length]!;
      return { ...prev, [power]: next };
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (activePowers.length < 2) {
      setError('At least two powers must answer the call.');
      return;
    }
    const playerTypes: Record<string, string> = {};
    for (const p of activePowers) playerTypes[p] = config[p];
    setLoading(true);
    try {
      const res = await createGame({
        mode: 'singleplayer',
        powers: activePowers,
        playerTypes,
      } as Parameters<typeof createGame>[0]);
      navigate(`/games/${res.gameId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the game.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="newgame">
      <div className="newgame-grain" aria-hidden="true" />
      <div className="newgame-vignette" aria-hidden="true" />

      <header className="newgame-head">
        <Link to="/home" className="newgame-back">← return</Link>
        <h1 className="newgame-title">Solo Game</h1>
        <span className="newgame-head-spacer" aria-hidden="true" />
      </header>

      <form onSubmit={handleSubmit} className="newgame-form">
        <div className="newgame-powers" role="group" aria-label="Powers">
          {ALL_POWERS.map((power) => {
            const setting = config[power];
            const active = setting !== 'none';
            return (
              <button
                key={power}
                type="button"
                onClick={() => cycleSetting(power)}
                className={`newgame-power newgame-power-${power} ${active ? 'is-active' : 'is-off'} is-${setting}`}
                aria-label={`${POWER_NAMES[power]} — ${SETTING_LABEL[setting]} (click to cycle)`}
              >
                <span className="newgame-power-bleed" aria-hidden="true" />
                <span className="newgame-power-sigil"><PowerSigil power={power} size={48} /></span>
                <span className="newgame-power-name">{POWER_NAMES[power]}</span>
                <span className="newgame-power-epithet">{POWER_EPITHETS[power]}</span>
                <span className="newgame-power-desc">{POWER_DESCRIPTIONS[power]}</span>
                <span className="newgame-power-setting" data-setting={setting}>
                  {SETTING_LABEL[setting]}
                </span>
              </button>
            );
          })}
        </div>
        <p className="newgame-hint">
          Click a power to cycle <em>Human → AI → Off</em>. At least two must answer.
        </p>

        <div className="newgame-footer">
          {error && <p className="newgame-error">{error}</p>}
          <button
            type="submit"
            className="newgame-submit"
            disabled={loading || activePowers.length < 2}
          >
            <span className="newgame-submit-label">
              {loading ? 'Summoning…' : 'Begin'}
            </span>
          </button>
        </div>
      </form>
    </main>
  );
}
