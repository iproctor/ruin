import React from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext.js';
import { SettingsProvider } from './contexts/SettingsContext.js';
import LandingPage from './pages/LandingPage.js';
import NewGamePage from './pages/NewGamePage.js';
import GamePage from './pages/GamePage.js';
import HomePage from './pages/HomePage.js';
import MultiplayerLobbyPage from './pages/MultiplayerLobbyPage.js';
import DevGalleryPage from './pages/DevGalleryPage.js';
import DevReplayPage from './pages/DevReplayPage.js';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function LobbyRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/lobby/g/${id}`} replace />;
}

function RootEntry() {
  const { token } = useAuth();
  return token ? <Navigate to="/home" replace /> : <LandingPage />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/home"
        element={
          <ProtectedRoute>
            <HomePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/games/new"
        element={
          <ProtectedRoute>
            <NewGamePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/lobby"
        element={
          <ProtectedRoute>
            <MultiplayerLobbyPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/lobby/g/:gameId"
        element={
          <ProtectedRoute>
            <MultiplayerLobbyPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/games/:id/lobby"
        element={
          <ProtectedRoute>
            <LobbyRedirect />
          </ProtectedRoute>
        }
      />
      <Route
        path="/games/:id"
        element={
          <ProtectedRoute>
            <GamePage />
          </ProtectedRoute>
        }
      />
      {import.meta.env.DEV && <Route path="/dev" element={<DevGalleryPage />} />}
      {import.meta.env.DEV && <Route path="/dev/replay" element={<DevReplayPage />} />}
      <Route path="/" element={<RootEntry />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <SettingsProvider>
        <AppRoutes />
      </SettingsProvider>
    </AuthProvider>
  );
}
