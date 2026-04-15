import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { login, requestMagicLink } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.js';

export default function LoginPage() {
  const { login: storeToken } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [magicEmail, setMagicEmail] = useState('');
  const [magicSent, setMagicSent] = useState(false);
  const [magicError, setMagicError] = useState('');
  const [magicLoading, setMagicLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await login(username, password);
      storeToken(res.token);
      navigate('/home');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setMagicError('');
    setMagicLoading(true);
    try {
      await requestMagicLink(magicEmail);
      setMagicSent(true);
    } catch (err) {
      setMagicError(err instanceof Error ? err.message : 'Failed to send link');
    } finally {
      setMagicLoading(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 420 }}>
      <h1>Ruin</h1>
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h2>Sign in</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error && <p className="error-msg">{error}</p>}
          <button type="submit" className="primary" disabled={loading} style={{ width: '100%' }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p style={{ marginTop: '1rem', fontSize: '0.85rem', color: '#aaa' }}>
          No account? <Link to="/register">Register</Link>
        </p>
      </div>

      <div className="card">
        <h2>Sign in with magic link</h2>
        {magicSent ? (
          <p style={{ color: '#86efac' }}>Check your email for a sign-in link.</p>
        ) : (
          <form onSubmit={handleMagicLink}>
            <div className="form-group">
              <label htmlFor="magic-email">Email address</label>
              <input
                id="magic-email"
                type="email"
                value={magicEmail}
                onChange={(e) => setMagicEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </div>
            {magicError && <p className="error-msg">{magicError}</p>}
            <button
              type="submit"
              className="secondary"
              disabled={magicLoading}
              style={{ width: '100%' }}
            >
              {magicLoading ? 'Sending…' : 'Send magic link'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
