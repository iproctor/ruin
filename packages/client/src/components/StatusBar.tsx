import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { GameState, Power } from '@ruin/engine';
import { WORLD_CARD_BY_ID, THREAT_DIALS, UPGRADE_BY_ID } from '@ruin/engine';
import { POWER_COLORS, POWER_LABELS, PHASE_LABELS } from '../lib/display.js';
import CardTooltip from './CardTooltip.js';

interface StatusBarProps {
  state: GameState;
  myPower: Power | null;
}

// ── World card mini chip ──────────────────────────────────────────────────────

function WorldCardChip({ cardId, slot }: { cardId: string; slot: 1 | 2 | 'D' }) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
  const def = WORLD_CARD_BY_ID[cardId];
  const isPersistent = def?.timing === 'persistent';
  const isDiscard = slot === 'D';

  return (
    <>
      <div
        onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY })}
        onMouseMove={(e) => setTooltip({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setTooltip(null)}
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: 48,
          height: 34,
          borderRadius: 4,
          overflow: 'hidden',
          border: isDiscard ? '1.5px dashed #64748b'
            : isPersistent ? '1.5px solid #a78bfa'
            : '1.5px solid #334155',
          background: isDiscard ? '#0d0d1a' : '#13121f',
          cursor: 'default',
          boxShadow: isPersistent ? '0 0 6px #a78bfa44' : 'none',
          opacity: isDiscard ? 0.7 : 1,
          position: 'relative',
          flexShrink: 0,
        }}
      >
        {/* Slot label */}
        <div style={{
          position: 'absolute',
          top: 2,
          left: 3,
          fontSize: '0.5rem',
          color: isDiscard ? '#64748b' : '#475569',
          lineHeight: 1,
          fontWeight: 700,
          letterSpacing: 1,
        }}>
          {isDiscard ? 'DISC' : `W${slot}`}
        </div>

        {/* Persistent indicator */}
        {isPersistent && (
          <div style={{
            position: 'absolute',
            top: 2,
            right: 3,
            fontSize: '0.5rem',
            color: '#a78bfa',
            lineHeight: 1,
          }}>⬡</div>
        )}

        {/* Card name */}
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '10px 3px 3px',
          textAlign: 'center',
          fontSize: '0.52rem',
          fontWeight: 700,
          color: isDiscard ? '#94a3b8' : '#c4b5fd',
          lineHeight: 1.15,
          wordBreak: 'break-word',
        }}>
          {def?.name ?? cardId}
        </div>
      </div>

      {tooltip && (
        <CardTooltip cardId={cardId} x={tooltip.x} y={tooltip.y} />
      )}
    </>
  );
}

// ── Per-power score chip with tooltip ─────────────────────────────────────────

import type { PowerState } from '@ruin/engine';

function PowerScore({ power, ps, isActing, isMe, color, ticksLeft, dimmed }: {
  power: Power;
  ps: PowerState;
  isActing: boolean;
  isMe: boolean;
  color: string;
  ticksLeft: number;
  dimmed: boolean;
}) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);

  return (
    <div
      className="flex flex-col items-center gap-0.5 min-w-[56px]"
      style={{ opacity: dimmed ? 0.7 : 1, cursor: 'default' }}
      onMouseEnter={e => setTooltip({ x: e.clientX, y: e.clientY })}
      onMouseMove={e => setTooltip({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setTooltip(null)}
    >
      <span className="text-xs font-bold leading-none" style={{ color, textShadow: isActing ? `0 0 8px ${color}` : 'none' }}>
        {POWER_LABELS[power]}{isMe && <span className="text-slate-500"> ★</span>}
      </span>
      <span className="text-base font-black leading-none" style={{ color }}>
        {ps.victoryPoints}<span className="text-slate-500 text-xs font-normal"> VP</span>
      </span>
      <div className="flex gap-2 text-[10px]">
        <span style={{ color: '#64748b' }}>{ps.powerPoints}<span className="text-slate-600"> pp</span></span>
        <span style={{ color: '#64748b' }}>{ps.hand.filter(c => c !== '?').length}<span className="text-slate-600"> cards</span></span>
      </div>
      <span className="text-[9px] text-slate-500 leading-none">{ps.threatValue} • {ticksLeft} ticks to win</span>

      {tooltip && createPortal(
        <div style={{
          position: 'fixed',
          left: Math.max(tooltip.x - 245, 4),
          top: tooltip.y + 14,
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px', color: '#ccc', fontSize: '0.73rem', marginBottom: 6 }}>
            <span><span style={{ color: '#64748b' }}>Threat: </span>{ps.threatValue}</span>
            <span><span style={{ color: '#64748b' }}>Dial: </span>{ps.dialPosition}</span>
            <span><span style={{ color: '#64748b' }}>Board: </span>{ps.followers.filter(f => f.regionId !== null).length}</span>
            <span><span style={{ color: '#64748b' }}>Reserve: </span>{ps.followers.filter(f => f.regionId === null).length}</span>
            <span><span style={{ color: '#64748b' }}>Discard: </span>{ps.discardIds.length}</span>
            {ps.claimedPeasants > 0 && (
              <span><span style={{ color: '#64748b' }}>Peasants: </span><strong style={{ color: '#fbbf24' }}>{ps.claimedPeasants}</strong></span>
            )}
          </div>
          {ps.upgradesInPlay.length === 0 ? (
            <div style={{ color: '#4b5563', fontSize: '0.73rem' }}>No upgrades</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {ps.upgradesInPlay.map(uid => {
                const u = UPGRADE_BY_ID[uid];
                if (!u) return null;
                return (
                  <div key={uid} style={{ borderTop: '1px solid #1e1e3a', paddingTop: 4 }}>
                    <div style={{ fontWeight: 600, color, fontSize: '0.75rem' }}>{u.name}</div>
                    <div style={{ color: '#d1d5db', fontSize: '0.7rem' }}>{u.effect}</div>
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

// ── Status bar ────────────────────────────────────────────────────────────────

export default function StatusBar({ state, myPower }: StatusBarProps) {
  const waiting = state.pendingAction?.waitingFor ?? null;
  const phaseLabel = PHASE_LABELS[state.phase] ?? state.phase;
  const { slot1, slot2, discardCard } = state.worldTrack;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 8px', background: '#16213e', borderBottom: '1px solid #3a3a6e', fontSize: '0.875rem', flexShrink: 0, overflowX: 'auto' }}>
      {/* Nav */}
      <Link to="/games" className="text-slate-400 hover:text-white shrink-0 text-xs">
        ← Games
      </Link>
      <span className="text-slate-600 shrink-0">|</span>

      {/* Round + Phase */}
      <span className="shrink-0 font-semibold text-slate-200">
        Round {state.round}
      </span>
      <span
        className="shrink-0 px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wide"
        style={{
          background: state.phase === 'summoning' ? '#312e81'
            : state.phase === 'battle'    ? '#7f1d1d'
            : state.phase === 'completed' ? '#14532d'
            : '#1e1e3a',
          color: state.phase === 'completed' ? '#86efac' : '#c7d2fe',
        }}
      >
        {phaseLabel}
      </span>

      {/* Active player */}
      {waiting && !state.winners && (
        <span className="shrink-0 text-xs">
          <span className="text-slate-400">Acting: </span>
          <span style={{ color: POWER_COLORS[waiting], fontWeight: 700 }}>
            {POWER_LABELS[waiting]}
            {waiting === myPower && ' (you)'}
          </span>
        </span>
      )}

      {/* Game over */}
      {state.winners && (
        <span className="shrink-0 font-bold text-yellow-400">
          🏆 {state.winners.map((w) => POWER_LABELS[w]).join(' & ')} win!
        </span>
      )}

      {/* World cards */}
      {(slot1 || slot2 || discardCard) && (
        <>
          <span className="text-slate-600 shrink-0">|</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {slot1 && <WorldCardChip cardId={slot1} slot={1} />}
            {slot2 && <WorldCardChip cardId={slot2} slot={2} />}
            {discardCard && <WorldCardChip cardId={discardCard} slot={'D'} />}
          </div>
        </>
      )}

      <div className="flex-1" />

      {/* Per-power scores */}
      <div className="flex gap-4 shrink-0">
        {state.activePowers.map((power) => {
          const ps = state.powers[power]!;
          const isActing = power === waiting;
          const dialMax = (THREAT_DIALS[power]?.length ?? 1) - 1;
          const ticksLeft = dialMax - ps.dialPosition;
          const color = POWER_COLORS[power];

          return (
            <PowerScore
              key={power}
              power={power}
              ps={ps}
              isActing={isActing}
              isMe={power === myPower}
              color={color}
              ticksLeft={ticksLeft}
              dimmed={!!state.winners}
            />
          );
        })}
      </div>
    </div>
  );
}
