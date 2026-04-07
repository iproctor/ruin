import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

const TOKEN_KEY = 'ruin_token';

interface AuthContextValue {
  userId: string | null;
  token: string | null;
  login(token: string): void;
  logout(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function decodeUserId(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    // Pad base64 to a multiple of 4
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return typeof parsed['userId'] === 'string' ? parsed['userId'] : typeof parsed['sub'] === 'string' ? parsed['sub'] : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [userId, setUserId] = useState<string | null>(() => {
    const t = localStorage.getItem(TOKEN_KEY);
    return t ? decodeUserId(t) : null;
  });

  const login = useCallback((newToken: string) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
    setUserId(decodeUserId(newToken));
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUserId(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ userId, token, login, logout }),
    [userId, token, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
