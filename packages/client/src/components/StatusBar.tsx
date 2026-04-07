import { Link } from 'react-router-dom';
import type { GameState, Power } from '@ruin/engine';
import { THREAT_DIALS } from '@ruin/engine';
import { POWER_COLORS, POWER_LABELS, PHASE_LABELS } from '../lib/display.js';

interface StatusBarProps {
  state: GameState;
  myPower: Power | null;
}

// Total dial positions per power (victory pos = last)
function dialTotal(power: Power): number {
  return (THREAT_DIALS[power]?.length ?? 1) - 1;
}

export default function StatusBar({ state, myPower }: StatusBarProps) {
  const waiting = state.pendingAction?.waitingFor ?? null;
  const phaseLabel = PHASE_LABELS[state.phase] ?? state.phase;

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-surface-1 border-b border-border text-sm shrink-0 overflow-x-auto">
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

      <div className="flex-1" />

      {/* Per-power scores */}
      <div className="flex gap-4 shrink-0">
        {state.activePowers.map((power) => {
          const ps = state.powers[power]!;
          const isActing = power === waiting;
          const dialPos = ps.dialPosition;
          const dialMax = dialTotal(power);
          const ticksLeft = dialMax - dialPos;
          const color = POWER_COLORS[power];

          return (
            <div
              key={power}
              className="flex flex-col items-center gap-0.5 min-w-[56px]"
              style={{ opacity: state.winners ? 0.7 : 1 }}
            >
              {/* Power name */}
              <span
                className="text-xs font-bold leading-none"
                style={{
                  color,
                  textShadow: isActing ? `0 0 8px ${color}` : 'none',
                }}
              >
                {POWER_LABELS[power]}
                {power === myPower && <span className="text-slate-500"> ★</span>}
              </span>

              {/* VP */}
              <span className="text-base font-black leading-none" style={{ color }}>
                {ps.victoryPoints}
                <span className="text-slate-500 text-xs font-normal"> VP</span>
              </span>

              {/* Threat dial pip strip */}
              <div className="flex gap-0.5 items-center">
                {Array.from({ length: Math.min(dialMax, 8) }).map((_, i) => (
                  <div
                    key={i}
                    className="w-1.5 h-1.5 rounded-full"
                    style={{
                      background: i < dialPos ? color : '#2d2d5e',
                      opacity: i < dialPos ? 0.9 : 0.5,
                    }}
                  />
                ))}
                {dialMax > 8 && (
                  <span className="text-slate-500 text-[9px] ml-0.5">+{dialMax - 8}</span>
                )}
              </div>
              <span className="text-[9px] text-slate-500 leading-none">{ticksLeft} to win</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
