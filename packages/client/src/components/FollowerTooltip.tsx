import { createPortal } from 'react-dom';
import type { Power, FollowerClass } from '@ruin/engine';
import { FOLLOWERS, UPGRADE_BY_ID } from '@ruin/engine';
import { POWER_COLORS } from '../lib/display.js';

interface FollowerTooltipProps {
  power: Power;
  followerClass: FollowerClass;
  upgradesInPlay: string[];
  x: number;
  y: number;
}

export default function FollowerTooltip({ power, followerClass, upgradesInPlay, x, y }: FollowerTooltipProps) {
  const def = FOLLOWERS[power]?.[followerClass];
  if (!def) return null;

  const activeUpgrade = upgradesInPlay
    .map(u => UPGRADE_BY_ID[u])
    .find(u => u?.upgradeType === followerClass);

  const stats = activeUpgrade?.newStats
    ? { ...def.base, ...activeUpgrade.newStats }
    : def.base;

  const color = POWER_COLORS[power];
  const left = Math.min(x + 14, window.innerWidth - 200);
  const top  = Math.min(y + 14, window.innerHeight - 120);

  return createPortal(
    <div style={{
      position: 'fixed', left, top, width: 190,
      background: '#0d0d1f', border: `1px solid ${color}`,
      borderRadius: 8, padding: '8px 10px',
      pointerEvents: 'none', zIndex: 9999,
      boxShadow: `0 0 12px ${color}44`,
      fontSize: '0.78rem', lineHeight: 1.5, color: '#e5e7eb',
    }}>
      <div style={{ fontWeight: 700, color: '#fff', marginBottom: 4 }}>{def.name}</div>
      <div style={{ display: 'flex', gap: 10, color: '#94a3b8', fontSize: '0.72rem', marginBottom: activeUpgrade ? 6 : 0 }}>
        <span>Cost <strong style={{ color: '#fff' }}>{stats.cost}</strong></span>
        <span>Atk <strong style={{ color: '#fff' }}>{stats.attack}</strong></span>
        <span>Def <strong style={{ color: '#fff' }}>{stats.defense}</strong></span>
      </div>
      {activeUpgrade && (
        <div style={{ fontSize: '0.7rem', color: '#a78bfa', borderTop: '1px solid #1e1e3a', paddingTop: 4 }}>
          ✦ {activeUpgrade.name}: {activeUpgrade.effect}
        </div>
      )}
    </div>,
    document.body,
  );
}
