import { useState, useRef, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Power } from '@ruin/engine';
import { login, register, ApiError } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.js';
import { PowerSigil } from '../components/PowerSigil.js';
import { godArt } from '../lib/art.js';
import './LandingPage.css';

interface PowerMeta {
  numeral: string;
  slug: Power;
  name: string;
  epithet: string;
}

const POWERS: PowerMeta[] = [
  { numeral: 'I',   slug: 'xarm',   name: 'Xarm',   epithet: 'war is a force that gives us meaning' },
  { numeral: 'II',  slug: 'gormen', name: 'Gormen', epithet: 'ripe with decay' },
  { numeral: 'III', slug: 'tenzen', name: 'Tenzen', epithet: 'just as planned' },
  { numeral: 'IV',  slug: 'lasha',  name: 'Lasha',  epithet: 'pain and pleasure, indivisible' },
];


type Mode = 'continue' | 'register';

// Ruin emblem — a 4-way yin-yang ("taegeuk" / pinwheel) rendered as a
// polished jewel. Darker muted god-colours fill the four comma sections;
// a specular sheen + tight glint on the upper-left and an edge vignette
// give the circle a gemstone convex feel, framed by a polished brass ring.
function RuinEmblem() {
  const comma = 'M 0 -40 A 40 40 0 0 1 40 0 A 20 20 0 0 0 0 0 A 20 20 0 0 1 0 -40 Z';
  // Each boundary arc: a semicircle from a rim point to centre, radius 20.
  // Four of them (rotated 90° each) trace all the borders between commas.
  return (
    <svg
      className="landing-emblem"
      viewBox="-50 -50 100 100"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        {/* Broad upper-left sheen — the jewel's lit side */}
        <radialGradient id="ruin-sheen" cx="-10" cy="-18" r="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.4" />
          <stop offset="55%" stopColor="#ffffff" stopOpacity="0.05" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        {/* Tight specular glint */}
        <radialGradient id="ruin-glint" cx="-15" cy="-24" r="8" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        {/* Inner edge shadow — pulls the rim darker so the gem feels convex */}
        <radialGradient id="ruin-shade" cx="0" cy="0" r="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#000000" stopOpacity="0.2" />
          <stop offset="20%" stopColor="#000000" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.95" />
        </radialGradient>
        {/* Polished brass ring — bright at upper-left, dark at lower-right */}
        <linearGradient id="ruin-brass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e8c177" />
          <stop offset="45%" stopColor="#a97140" />
          <stop offset="100%" stopColor="#4a2e14" />
        </linearGradient>
      </defs>

      {/* Base disk */}
      <circle cx="0" cy="0" r="40" fill="#0a0806" />

      {/* Four commas in vivid gem-like god-colours */}
      <path d={comma} fill="#d01020" />
      <path d={comma} fill="#78b820" transform="rotate(90)" />
      <path d={comma} fill="#1870b8" transform="rotate(180)" />
      <path d={comma} fill="#9428c0" transform="rotate(270)" />

      {/* Rim darken + sheen + glint for the jewel effect */}
      <circle cx="0" cy="0" r="40" fill="url(#ruin-shade)" />
      <circle cx="0" cy="0" r="40" fill="url(#ruin-sheen)" />
      <circle cx="0" cy="0" r="40" fill="url(#ruin-glint)" />

      {/* Brass bezel */}
      <circle cx="0" cy="0" r="40" fill="none" stroke="url(#ruin-brass)" strokeWidth="2.5" />
    </svg>
  );
}

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
        <RuinEmblem />
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
        <p className="landing-tagline">An online implementation of CitOW with AI and multiplayer</p>
      </section>

      <section className="landing-powers" aria-label="The four powers">
        {POWERS.map((p, i) => (
          <div
            key={p.slug}
            className={`landing-power landing-power-${p.slug}`}
            style={{ animationDelay: `${0.55 + i * 0.08}s` }}
          >
            <div className="landing-power-art" aria-hidden="true" style={godArt(p.slug) ? { backgroundImage: `url(${godArt(p.slug)})` } : undefined} />
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
