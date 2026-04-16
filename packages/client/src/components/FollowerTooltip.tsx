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
    <div
      className="gt"
      style={{
        left,
        top,
        width: 200,
        ['--tt-accent' as string]: color,
        ['--tt-glow' as string]: `${color}55`,
      }}
    >
      <div className="gt-title" style={{ margin: 0, marginBottom: 4 }}>{def.name}</div>
      <div style={{ display: 'flex', gap: 10, fontFamily: "'Cinzel', serif", fontSize: '0.68rem', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: activeUpgrade ? 6 : 0 }}>
        <span className="gt-fade">Cost <strong style={{ color: 'var(--game-paper)' }}>{stats.cost}</strong></span>
        <span className="gt-fade">Atk <strong style={{ color: 'var(--game-paper)' }}>{stats.attack}</strong></span>
        <span className="gt-fade">Def <strong style={{ color: 'var(--game-paper)' }}>{stats.defense}</strong></span>
      </div>
      {activeUpgrade && (
        <div className="gt-divider" style={{ paddingTop: 5, fontSize: '0.8rem', color: 'var(--game-brass-hot)' }}>
          ✦ {activeUpgrade.name}: {activeUpgrade.effect}
        </div>
      )}
    </div>,
    document.body,
  );
}
