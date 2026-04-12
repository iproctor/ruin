import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { GameState, Power } from '@ruin/engine';
import { UPGRADE_BY_ID } from '@ruin/engine';
import { POWER_COLORS, POWER_LABELS } from '../lib/display.js';

interface PowerPanelProps {
  power: Power;
  state: GameState;
  isMe: boolean;
}

export default function PowerPanel({ power, state, isMe }: PowerPanelProps) {
  const ps = state.powers[power];
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
  if (!ps) return null;

  const isWaiting =
    state.pendingAction !== null && state.pendingAction.waitingFor === power;

  const reserveCount = ps.followers.filter((f) => f.regionId === null).length;
  const boardCount = ps.followers.filter((f) => f.regionId !== null).length;
  const handSize = ps.hand.length;
  const color = POWER_COLORS[power];

  return (
    <div
      style={{
        background: '#16213e',
        border: `2px solid`,
        borderColor: isWaiting ? '#facc15' : isMe ? '#818cf8' : '#2d2d5e',
        borderRadius: 6,
        padding: '0.5rem 0.6rem',
        fontSize: '0.8rem',
        cursor: 'default',
      }}
      className={`power-border-${power}`}
      onMouseEnter={e => setTooltip({ x: e.clientX, y: e.clientY })}
      onMouseMove={e => setTooltip({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setTooltip(null)}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '0.3rem',
        }}
      >
        <span className={`power-${power}`} style={{ fontWeight: 700, fontSize: '0.9rem' }}>
          {POWER_LABELS[power]}
          {isMe && <span style={{ color: '#818cf8', marginLeft: '0.4rem', fontWeight: 400 }}>(you)</span>}
        </span>
        {isWaiting && (
          <span style={{ color: '#facc15', fontSize: '0.75rem', fontWeight: 600 }}>ACTING</span>
        )}
        {ps.passedSummoning && !isWaiting && (
          <span style={{ color: '#555', fontSize: '0.75rem' }}>passed</span>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '0.2rem 0.75rem',
          color: '#ccc',
        }}
      >
        <div><span style={{ color: '#888' }}>VP:</span> {ps.victoryPoints}</div>
        <div><span style={{ color: '#888' }}>PP:</span> {ps.powerPoints}/{ps.basePowerPoints}</div>
        <div><span style={{ color: '#888' }}>Threat:</span> {ps.threatValue}</div>
        <div><span style={{ color: '#888' }}>Dial:</span> {ps.dialPosition}</div>
        <div><span style={{ color: '#888' }}>Board:</span> {boardCount}</div>
        <div><span style={{ color: '#888' }}>Reserve:</span> {reserveCount}</div>
        <div><span style={{ color: '#888' }}>Hand:</span> {handSize}</div>
        <div><span style={{ color: '#888' }}>Disc:</span> {ps.discardIds.length}</div>
      </div>

      {ps.upgradesInPlay.length > 0 && (
        <div style={{ marginTop: '0.3rem', fontSize: '0.73rem', color: '#818cf8' }}>
          {ps.upgradesInPlay.length} upgrade{ps.upgradesInPlay.length !== 1 ? 's' : ''}
        </div>
      )}

      {tooltip && createPortal(
        <div style={{
          position: 'fixed',
          left: Math.min(tooltip.x + 14, window.innerWidth - 260),
          top: Math.min(tooltip.y + 14, window.innerHeight - 200),
          width: 245,
          background: '#0d0d1f',
          border: `1px solid ${color}`,
          borderRadius: 8,
          padding: '10px 12px',
          pointerEvents: 'none',
          zIndex: 9999,
          boxShadow: `0 0 14px ${color}44`,
          fontSize: '0.78rem',
          lineHeight: 1.5,
          color: '#e5e7eb',
        }}>
          <div style={{ fontWeight: 700, color: '#fff', marginBottom: 6, fontSize: '0.9rem' }}>
            {POWER_LABELS[power]}
          </div>

          {ps.claimedPeasants > 0 && (
            <div style={{ marginBottom: 6, color: '#fbbf24' }}>
              Peasant tokens: <strong>{ps.claimedPeasants}</strong>
            </div>
          )}

          {ps.upgradesInPlay.length === 0 ? (
            <div style={{ color: '#4b5563', fontSize: '0.73rem' }}>No upgrades</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ps.upgradesInPlay.map(uid => {
                const u = UPGRADE_BY_ID[uid];
                if (!u) return null;
                return (
                  <div key={uid} style={{ borderTop: '1px solid #1e1e3a', paddingTop: 5 }}>
                    <div style={{ fontWeight: 600, color, marginBottom: 2 }}>{u.name}</div>
                    <div style={{ color: '#d1d5db', fontSize: '0.72rem' }}>{u.effect}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
