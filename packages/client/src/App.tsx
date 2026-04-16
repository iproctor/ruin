import React from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext.js';
import LoginPage from './pages/LoginPage.js';
import RegisterPage from './pages/RegisterPage.js';
import NewGamePage from './pages/NewGamePage.js';
import GamePage from './pages/GamePage.js';
import HomePage from './pages/HomePage.js';
import MultiplayerLobbyPage from './pages/MultiplayerLobbyPage.js';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function LobbyRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/lobby/g/${id}`} replace />;
}

function RootRedirect() {
  const { token } = useAuth();
  return <Navigate to={token ? '/home' : '/login'} replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
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
      <Route path="/" element={<RootRedirect />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
