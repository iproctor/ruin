import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { GameState, Power, RegionId, GameEvent } from '@ruin/engine';
import { WORLD_CARD_BY_ID, THREAT_DIALS, UPGRADES, RUINATION_CARDS, REGIONS, REGION_ORDER } from '@ruin/engine';
import { POWER_COLORS, POWER_LABELS, PHASE_LABELS } from '../lib/display.js';
import CardTooltip from './CardTooltip.js';

import type { GamePlayerInfo } from '../api/client.js';

interface StatusBarProps {
  state: GameState;
  myPower: Power | null;
  players?: GamePlayerInfo[];
  events?: GameEvent[];
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
          width: 78,
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

        {/* Comet indicator */}
        {def?.hasCometIcon && (
          <div style={{
            position: 'absolute',
            top: 2,
            right: 3,
            fontSize: '0.6rem',
            color: '#fbbf24',
            lineHeight: 1,
          }}>☄</div>
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

function dialAdvancementCondition(power: Power): string {
  switch (power) {
    case 'xarm':   return 'Kill an enemy figure in battle.';
    case 'gormen': return 'Place ≥2 corruption tokens in a populous region.';
    case 'tenzen': return 'Place ≥2 corruption tokens in a region with ≥2 magic symbols + chaos stones combined.';
    case 'lasha':  return 'Place ≥2 corruption tokens in a region with a Noble or Hero token.';
  }
}

function PowerScore({ power, ps, isActing, isMe, color, ticksLeft, dimmed, controller }: {
  power: Power;
  ps: PowerState;
  isActing: boolean;
  isMe: boolean;
  color: string;
  ticksLeft: number;
  dimmed: boolean;
  controller?: GamePlayerInfo;
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
          <div style={{ fontWeight: 700, color: '#fff', marginBottom: 2, fontSize: '0.9rem' }}>
            {POWER_LABELS[power]}
          </div>
          <div style={{ color: '#94a3b8', fontSize: '0.7rem', marginBottom: 6 }}>
            {controller
              ? controller.playerType === 'ai'
                ? 'AI ✨'
                : (controller.username ?? 'Human')
              : '—'}
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {UPGRADES.filter(u => u.power === power).map(u => {
              const taken = ps.upgradesInPlay.includes(u.id);
              return (
                <div key={u.id} style={{ borderTop: '1px solid #1e1e3a', paddingTop: 4, opacity: taken ? 1 : 0.45 }}>
                  <div style={{ fontWeight: 600, color: taken ? color : '#6b7280', fontSize: '0.75rem' }}>
                    {u.name}{taken && ' ✓'}
                  </div>
                  <div style={{ color: taken ? '#d1d5db' : '#6b7280', fontSize: '0.7rem' }}>{u.effect}</div>
                </div>
              );
            })}
          </div>
          <div style={{ borderTop: '1px solid #1e1e3a', marginTop: 6, paddingTop: 6 }}>
            <div style={{ color: '#94a3b8', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 }}>
              Dial Advancement
            </div>
            <div style={{ color: '#cbd5e1', fontSize: '0.72rem' }}>
              {dialAdvancementCondition(power)}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── Ruination chip with tooltip ──────────────────────────────────────────────

function RuinChip({ state, events }: { state: GameState; events?: GameEvent[] }) {
  const [hovered, setHovered] = useState(false);
  const chipRef = useRef<HTMLDivElement>(null);

  // Build map of cardIndex -> regionId for ruined regions
  const ruinedMap = new Map<number, RegionId>();
  let ruinCount = 0;
  for (const rid of REGION_ORDER) {
    const region = state.regions[rid];
    if (region?.ruinationCardIndex != null) {
      ruinedMap.set(region.ruinationCardIndex, rid);
      ruinCount++;
    }
  }

  // Build map of cardIndex -> scoring event from the SSE event log
  const scoringMap = new Map<number, Extract<GameEvent, { type: 'ruination_scoring' }>>();
  if (events) {
    for (const evt of events) {
      if (evt.type === 'ruination_scoring') {
        scoringMap.set(evt.cardIndex, evt);
      }
    }
  }

  const chipBottom = chipRef.current?.getBoundingClientRect().bottom ?? 0;

  return (
    <>
      <div
        ref={chipRef}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 8px',
          borderRadius: 4,
          border: ruinCount > 0 ? '1.5px solid #991b1b' : '1.5px solid #334155',
          background: ruinCount > 0 ? '#1a0808' : '#13121f',
          cursor: 'default',
          flexShrink: 0,
          fontSize: '0.75rem',
          fontWeight: 700,
          color: ruinCount > 0 ? '#f87171' : '#64748b',
        }}
      >
        Ruined: {ruinCount}
      </div>

      {hovered && createPortal(
        <div
          style={{
            position: 'fixed',
            left: '50%',
            transform: 'translateX(-50%)',
            top: chipBottom + 8,
            background: '#0d0d1f',
            border: '1px solid #991b1b',
            borderRadius: 8,
            padding: '10px 12px',
            pointerEvents: 'none',
            zIndex: 9999,
            boxShadow: '0 0 14px #991b1b44',
            fontSize: '0.73rem',
            lineHeight: 1.5,
            color: '#e5e7eb',
          }}
        >
          <div style={{ fontWeight: 700, color: '#f87171', marginBottom: 6, fontSize: '0.85rem' }}>
            Ruination Cards
          </div>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr style={{ color: '#94a3b8', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: 1 }}>
                <th style={{ textAlign: 'left', padding: '2px 8px 4px 0' }}>Card</th>
                <th style={{ textAlign: 'center', padding: '2px 8px 4px' }}>Ruiner VP</th>
                {REGION_ORDER.map(rid => (
                  <th key={rid} style={{ textAlign: 'center', padding: '2px 4px 4px', whiteSpace: 'nowrap' }}>
                    {REGIONS[rid].name}
                  </th>
                ))}
                <th style={{ textAlign: 'center', padding: '2px 8px 4px' }}>1st</th>
                <th style={{ textAlign: 'center', padding: '2px 8px 4px' }}>2nd</th>
              </tr>
            </thead>
            <tbody>
              {RUINATION_CARDS.map(card => {
                const usedRegion = ruinedMap.get(card.index);
                const isUsed = usedRegion != null;
                const scoring = scoringMap.get(card.index);
                return (
                  <tr
                    key={card.index}
                    style={{
                      borderTop: '1px solid #1e1e3a',
                      opacity: isUsed ? 0.6 : 1,
                    }}
                  >
                    <td style={{ padding: '3px 8px 3px 0', fontWeight: 700, color: isUsed ? '#64748b' : '#e5e7eb' }}>
                      #{card.index}
                    </td>
                    <td style={{ textAlign: 'center', padding: '3px 8px', color: '#fbbf24', fontWeight: 600 }}>
                      {card.ruinersScore}
                    </td>
                    {REGION_ORDER.map(rid => {
                      const vp = card.endPhaseVP[rid as RegionId];
                      const isThisRegion = usedRegion === rid;
                      return (
                        <td
                          key={rid}
                          style={{
                            textAlign: 'center',
                            padding: '3px 4px',
                            background: isThisRegion ? '#7f1d1d33' : 'transparent',
                            borderRadius: isThisRegion ? 3 : 0,
                            fontWeight: isThisRegion ? 700 : 400,
                            color: isThisRegion ? '#f87171' : '#ccc',
                          }}
                        >
                          <span style={{ color: isThisRegion ? '#f87171' : '#e5e7eb' }}>{vp.first}</span>
                          <span style={{ color: '#64748b' }}>/</span>
                          <span style={{ color: isThisRegion ? '#fca5a5' : '#94a3b8' }}>{vp.second}</span>
                        </td>
                      );
                    })}
                    <td style={{ textAlign: 'center', padding: '3px 8px', whiteSpace: 'nowrap' }}>
                      {scoring
                        ? scoring.first.map(p => (
                            <span key={p} style={{ color: POWER_COLORS[p], fontWeight: 700 }}>{POWER_LABELS[p]}</span>
                          )).reduce<React.ReactNode[]>((acc, el, i) => i === 0 ? [el] : [...acc, <span key={`s${i}`} style={{ color: '#64748b' }}>/</span>, el], [])
                        : <span style={{ color: '#334155' }}>—</span>
                      }
                    </td>
                    <td style={{ textAlign: 'center', padding: '3px 8px', whiteSpace: 'nowrap' }}>
                      {scoring && scoring.second.length > 0
                        ? scoring.second.map(p => (
                            <span key={p} style={{ color: POWER_COLORS[p], fontWeight: 700 }}>{POWER_LABELS[p]}</span>
                          )).reduce<React.ReactNode[]>((acc, el, i) => i === 0 ? [el] : [...acc, <span key={`s${i}`} style={{ color: '#64748b' }}>/</span>, el], [])
                        : <span style={{ color: '#334155' }}>—</span>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 6, fontSize: '0.6rem', color: '#64748b' }}>
            Values show 1st/2nd place VP per region at end of game. Highlighted column = region ruined by that card.
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Dial chip with per-power threat track tooltip ───────────────────────────

function describeDialInstruction(instr: import('@ruin/engine').DialInstruction): string {
  switch (instr.type) {
    case 'start':                return '—';
    case 'victory':              return 'VICTORY';
    case 'score_vp':             return `+${instr.amount} VP`;
    case 'upgrade_card':         return 'Upgrade';
    case 'draw_chaos_cards':     return `Draw ${instr.amount}`;
    case 'place_nobles':         return `Place ${instr.amount} Noble`;
    case 'place_chaos_stone':    return `Place ${instr.amount} Chaos Stone`;
    case 'remove_corruption':    return `Remove ${instr.amount} corruption`;
    case 'remove_world_tokens':  return `Remove ${instr.amount} world token`;
    default:                     return '';
  }
}

function DialChip({ state }: { state: GameState }) {
  const [hovered, setHovered] = useState(false);
  const chipRef = useRef<HTMLDivElement>(null);
  const chipBottom = chipRef.current?.getBoundingClientRect().bottom ?? 0;

  // Highest dial position across all active powers (for compact summary on chip)
  let leadPower: Power | null = null;
  let leadThreat = -1;
  for (const p of state.activePowers) {
    const ps = state.powers[p];
    if (!ps) continue;
    const pos = THREAT_DIALS[p]?.[ps.dialPosition];
    if (!pos) continue;
    const threat = typeof pos.threat === 'number' ? pos.threat : 99;
    if (threat > leadThreat) { leadThreat = threat; leadPower = p; }
  }

  return (
    <>
      <div
        ref={chipRef}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 8px',
          borderRadius: 4,
          border: '1.5px solid #334155',
          background: '#13121f',
          cursor: 'default',
          flexShrink: 0,
          fontSize: '0.75rem',
          fontWeight: 700,
          color: leadPower ? POWER_COLORS[leadPower] : '#64748b',
        }}
      >
        Dial lead: {leadPower ? `${POWER_LABELS[leadPower]} (${leadThreat})` : '—'}
      </div>

      {hovered && createPortal(
        <div
          style={{
            position: 'fixed',
            left: '50%',
            transform: 'translateX(-50%)',
            top: chipBottom + 8,
            background: '#0d0d1f',
            border: '1px solid #3a3a6e',
            borderRadius: 8,
            padding: '10px 12px',
            pointerEvents: 'none',
            zIndex: 9999,
            boxShadow: '0 0 14px #3a3a6e44',
            fontSize: '0.73rem',
            lineHeight: 1.5,
            color: '#e5e7eb',
          }}
        >
          <div style={{ fontWeight: 700, color: '#e5e7eb', marginBottom: 6, fontSize: '0.85rem' }}>
            Threat Dials
          </div>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr style={{ color: '#94a3b8', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: 1 }}>
                <th style={{ textAlign: 'left', padding: '2px 10px 4px 0' }}>Power</th>
                <th style={{ textAlign: 'center', padding: '2px 6px 4px' }}>Pos</th>
                <th style={{ textAlign: 'left', padding: '2px 10px 4px' }}>Track (threat · reward)</th>
              </tr>
            </thead>
            <tbody>
              {state.activePowers.map(power => {
                const ps = state.powers[power]!;
                const track = THREAT_DIALS[power];
                const currentIdx = ps.dialPosition;
                return (
                  <tr key={power} style={{ borderTop: '1px solid #1e1e3a' }}>
                    <td style={{ padding: '4px 10px 4px 0', fontWeight: 700, color: POWER_COLORS[power] }}>
                      {POWER_LABELS[power]}
                    </td>
                    <td style={{ textAlign: 'center', padding: '4px 6px', color: '#fbbf24', fontWeight: 700 }}>
                      {currentIdx}/{track.length - 1}
                    </td>
                    <td style={{ padding: '4px 10px', whiteSpace: 'nowrap' }}>
                      {track.map((pos, i) => {
                        const isCurrent = i === currentIdx;
                        const isPast = i < currentIdx;
                        const threatLabel = typeof pos.threat === 'number' ? pos.threat : '★';
                        return (
                          <span
                            key={i}
                            style={{
                              display: 'inline-block',
                              padding: '1px 6px',
                              margin: '0 2px',
                              borderRadius: 4,
                              background: isCurrent ? POWER_COLORS[power] : 'transparent',
                              color: isCurrent ? '#0d0d1f' : isPast ? '#64748b' : '#cbd5e1',
                              border: isCurrent ? 'none' : '1px solid #2a2a4a',
                              fontWeight: isCurrent ? 700 : 500,
                              fontSize: '0.68rem',
                            }}
                          >
                            <span style={{ fontWeight: 700 }}>{threatLabel}</span>
                            <span style={{ margin: '0 3px', opacity: 0.5 }}>·</span>
                            <span>{describeDialInstruction(pos.instruction)}</span>
                          </span>
                        );
                      })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 6, fontSize: '0.6rem', color: '#64748b' }}>
            Highlighted cell = current position. Reach ★ (victory) to win by dial.
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Status bar ────────────────────────────────────────────────────────────────

export default function StatusBar({ state, myPower, players, events: eventLog }: StatusBarProps) {
  const playerByPower = new Map((players ?? []).map((p) => [p.power, p]));
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

      {/* Ruination tracker */}
      <span className="text-slate-600 shrink-0">|</span>
      <RuinChip state={state} events={eventLog} />

      {/* Dial tracker */}
      <DialChip state={state} />

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
              controller={playerByPower.get(power)}
            />
          );
        })}
      </div>
    </div>
  );
}
