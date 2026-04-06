import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { consumeMagicLink } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.js';

export default function JoinPage() {
  const { token } = useParams<{ token: string }>();
  const { login: storeToken } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) {
      setError('Missing token');
      return;
    }
    let cancelled = false;
    consumeMagicLink(token)
      .then((res) => {
        if (cancelled) return;
        storeToken(res.token);
        navigate(res.gameId ? `/games/${res.gameId}` : '/games', { replace: true });
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Invalid or expired link');
        }
      });
    return () => { cancelled = true; };
  }, [token, storeToken, navigate]);

  if (error) {
    return (
      <div className="page">
        <p className="error-msg">{error}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <p>Signing you in…</p>
    </div>
  );
}
