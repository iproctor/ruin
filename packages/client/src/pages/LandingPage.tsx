import { useState, useRef, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Power } from '@ruin/engine';
import { login, register, ApiError } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.js';
import { PowerSigil } from '../components/PowerSigil.js';
import './LandingPage.css';

interface PowerMeta {
  numeral: string;
  slug: Power;
  name: string;
  epithet: string;
}

const POWERS: PowerMeta[] = [
  { numeral: 'I',   slug: 'xarm',   name: 'Xarm',   epithet: 'skulls for the skulls god. blood for the blood throne' },
  { numeral: 'II',  slug: 'gormen', name: 'Gormen', epithet: 'ripe with decay' },
  { numeral: 'III', slug: 'tenzen', name: 'Tenzen', epithet: 'just as planned' },
  { numeral: 'IV',  slug: 'lasha',  name: 'Lasha',  epithet: 'you asked for this' },
];


type Mode = 'continue' | 'register';

export default function LandingPage() {
  const { login: storeToken } = useAuth();
  const navigate = useNavigate();
  const emailRef = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<Mode>('continue');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);

    try {
      if (mode === 'continue') {
        try {
          const res = await login(username, password);
          storeToken(res.token);
          navigate('/home');
          return;
        } catch (err) {
          if (err instanceof ApiError && err.code === 'no_user') {
            setMode('register');
            setError(null);
            setBusy(false);
            requestAnimationFrame(() => emailRef.current?.focus());
            return;
          }
          throw err;
        }
      } else {
        const res = await register(username, password, email || undefined);
        storeToken(res.token);
        navigate('/home');
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  // If the user edits the username after entering register mode, drop back
  // to continue — they might be trying a different existing account.
  function onUsernameChange(v: string) {
    setUsername(v);
    if (mode === 'register') {
      setMode('continue');
      setEmail('');
      setError(null);
    }
  }

  return (
    <main className="landing">
      <div className="landing-grain" aria-hidden="true" />
      <div className="landing-vignette" aria-hidden="true" />

      <section className="landing-hero">
        <h1 className="landing-wordmark" aria-label="Ruin">
          {'RUIN'.split('').map((ch, i) => (
            <span
              key={i}
              className="landing-wordmark-char"
              style={{ animationDelay: `${0.1 + i * 0.08}s` }}
            >
              {ch}
            </span>
          ))}
        </h1>
        <p className="landing-tagline">Four powers. A tired world. Chaos will reign.</p>
      </section>

      <section className="landing-powers" aria-label="The four powers">
        {POWERS.map((p, i) => (
          <div
            key={p.slug}
            className={`landing-power landing-power-${p.slug}`}
            style={{ animationDelay: `${0.55 + i * 0.08}s` }}
          >
            <div className="landing-power-sigil"><PowerSigil power={p.slug} /></div>
            <div className="landing-power-numeral">{p.numeral}</div>
            <div className="landing-power-name">{p.name}</div>
            <div className="landing-power-epithet">{p.epithet}</div>
          </div>
        ))}
      </section>

      <form className={`landing-auth landing-auth-${mode}`} onSubmit={onSubmit} noValidate>
        <div className="landing-auth-row">
          <label className="landing-field">
            <span className="landing-field-label">Username</span>
            <input
              className="landing-input"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => onUsernameChange(e.target.value)}
              minLength={2}
              maxLength={32}
              required
              disabled={busy}
            />
          </label>
          <label className="landing-field">
            <span className="landing-field-label">Pass</span>
            <input
              className="landing-input"
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={mode === 'register' ? 8 : 1}
              required
              disabled={busy}
            />
          </label>
          <label
            className={`landing-field landing-field-email ${mode === 'register' ? 'is-open' : ''}`}
            aria-hidden={mode !== 'register'}
          >
            <span className="landing-field-label">Email <em>· optional</em></span>
            <input
              ref={emailRef}
              className="landing-input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy || mode !== 'register'}
              tabIndex={mode === 'register' ? 0 : -1}
            />
          </label>
          <button
            className="landing-submit"
            type="submit"
            disabled={busy || !username || !password}
          >
            <span className="landing-submit-label">
              {busy ? '…' : mode === 'register' ? 'Register' : 'Continue'}
            </span>
            <span className="landing-submit-arrow" aria-hidden="true">→</span>
          </button>
        </div>
        <div className="landing-auth-status" role="status" aria-live="polite">
          {error ? (
            <span className="landing-auth-error">{error}</span>
          ) : mode === 'register' ? (
            <span className="landing-auth-hint">
              No such username — a new oath will be sworn.
            </span>
          ) : (
            <span className="landing-auth-hint landing-auth-hint-dim">
              If the username is unknown you will be asked to register.
            </span>
          )}
        </div>
      </form>
    </main>
  );
}
