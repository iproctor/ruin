import { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { GameState, Power, RegionId, GameEvent } from '@ruin/engine';
import { WORLD_CARD_BY_ID, THREAT_DIALS, UPGRADES, RUINATION_CARDS, REGIONS, REGION_ORDER } from '@ruin/engine';
import { POWER_COLORS, POWER_LABELS, PHASE_LABELS } from '../lib/display.js';
import { RUINED_TEXT } from '../lib/gameColors.js';
import { godArt, worldCardArt } from '../lib/art.js';
import CardTooltip from './CardTooltip.js';
import SettingsMenu from './SettingsMenu.js';

import type { GamePlayerInfo } from '../api/client.js';

interface StatusBarProps {
  state: GameState;
  myPower: Power | null;
  players?: GamePlayerInfo[];
  events?: GameEvent[];
  onLeave?: () => void;
  leaveLabel?: string;
}

// ── Nav menu (Back / Leave) ──────────────────────────────────────────────────

function NavMenu({ onLeave, leaveLabel = 'Leave Game' }: { onLeave?: () => void; leaveLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const navigate = useNavigate();
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        (menuRef.current && menuRef.current.contains(e.target as Node)) ||
        (btnRef.current && btnRef.current.contains(e.target as Node))
      ) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function toggle() {
    if (open) { setOpen(false); return; }
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setAnchor({ top: r.bottom + 2, left: r.left });
    }
    setOpen(true);
  }

  return (
    <div className="shrink-0">
      <button
        ref={btnRef}
        onClick={toggle}
        aria-label="Menu"
        className="gsb-menu-btn"
      >
        <svg width="16" height="14" viewBox="0 0 16 14" fill="none" aria-hidden="true">
          <path d="M1 2h14M1 7h14M1 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
      {open && anchor && createPortal(
        <div ref={menuRef} className="gsb-menu" style={{ top: anchor.top, left: anchor.left }}>
          <button
            className="gsb-menu-item"
            onClick={() => { setOpen(false); navigate('/home'); }}
          >
            Back to Home
          </button>
          {onLeave && (
            <button
              className="gsb-menu-item is-danger"
              onClick={() => { setOpen(false); onLeave(); }}
            >
              {leaveLabel}
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── World card mini chip ──────────────────────────────────────────────────────

function WorldCardChip({ cardId, slot }: { cardId: string; slot: 1 | 2 | 'D' }) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
  const def = WORLD_CARD_BY_ID[cardId];
  const isPersistent = def?.timing === 'persistent';
  const isDiscard = slot === 'D';

  const classes = [
    'gsb-wc',
    isPersistent && 'is-persistent',
    isDiscard && 'is-discard',
  ].filter(Boolean).join(' ');

  return (
    <>
      <div
        onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY })}
        onMouseMove={(e) => setTooltip({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setTooltip(null)}
        className={classes}
        data-anchor={`world-${slot}`}
        style={worldCardArt(cardId) ? { backgroundImage: `linear-gradient(180deg, rgba(8,5,3,0.15), rgba(8,5,3,0.85)), url(${worldCardArt(cardId)})` } : undefined}
      >
        <div className="gsb-wc-slot">{isDiscard ? 'DISC' : `W${slot}`}</div>
        {def?.hasCometIcon && <div className="gsb-wc-comet">☄</div>}
        <div className="gsb-wc-name">{def?.name ?? cardId}</div>
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

/** God portrait whose ring doubles as a threat-dial progress arc. */
function GodMedallion({ power, progress, acting }: { power: Power; progress: number; acting: boolean }) {
  const art = godArt(power);
  const color = POWER_COLORS[power];
  const r = 21;
  const c = 2 * Math.PI * r;
  return (
    <div className={`gsb-medal ${acting ? 'is-acting' : ''}`} style={{ ['--accent' as string]: color }}>
      <div className="gsb-medal-art" style={art ? { backgroundImage: `url(${art})` } : undefined} />
      <svg className="gsb-medal-ring" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r={r} stroke="rgba(0,0,0,0.7)" strokeWidth="4" fill="none" />
        <circle
          cx="24" cy="24" r={r}
          stroke={color}
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * progress} ${c}`}
          transform="rotate(-90 24 24)"
        />
      </svg>
    </div>
  );
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
  const dialMax = (THREAT_DIALS[power]?.length ?? 1) - 1;
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);

  const classes = [
    'gsb-pow',
    isActing && 'is-acting',
    dimmed && 'is-dimmed',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      data-anchor={`power-${power}`}
      style={{ ['--accent' as string]: color }}
      onMouseEnter={e => setTooltip({ x: e.clientX, y: e.clientY })}
      onMouseMove={e => setTooltip({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setTooltip(null)}
    >
      <GodMedallion power={power} progress={dialMax > 0 ? ps.dialPosition / dialMax : 0} acting={isActing} />
      <div className="gsb-pow-body">
        <span className="gsb-pow-name">
          {POWER_LABELS[power]}{isMe && <span className="gsb-pow-you">★</span>}
        </span>
        <span className="gsb-pow-vp">
          <span key={ps.victoryPoints} className="gsb-vp-pop">{ps.victoryPoints}</span><span className="gsb-pow-vp-label">vp</span>
        </span>
        <div className="gsb-pow-stats">
          <span>{ps.powerPoints}<em>pp</em></span>
          <span>{ps.hand.length}<em>cards</em></span>
          <span title="Threat · dial ticks to victory">{ps.threatValue}<em>thr</em> {ticksLeft}<em>▸</em></span>
        </div>
      </div>

      {tooltip && createPortal(
        <div
          className="gt"
          style={{
            left: Math.max(tooltip.x - 255, 4),
            top: tooltip.y + 14,
            width: 260,
            ['--tt-accent' as string]: color,
            ['--tt-glow' as string]: `${color}55`,
          }}
        >
          <div className="gt-title" style={{ color }}>{POWER_LABELS[power]}</div>
          <div className="gt-meta" style={{ marginBottom: 6 }}>
            {controller
              ? controller.playerType === 'ai'
                ? 'AI ✨'
                : (controller.username ?? 'Human')
              : '—'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px', fontSize: '0.78rem', marginBottom: 6 }}>
            <span><span className="gt-fade">Threat </span>{ps.threatValue}</span>
            <span><span className="gt-fade">Dial </span>{ps.dialPosition}</span>
            <span><span className="gt-fade">Board </span>{ps.followers.filter(f => f.regionId !== null).length}</span>
            <span><span className="gt-fade">Reserve </span>{ps.followers.filter(f => f.regionId === null).length}</span>
            <span><span className="gt-fade">Discard </span>{ps.discardIds.length}</span>
            {ps.claimedPeasants > 0 && (
              <span><span className="gt-fade">Peasants </span><strong style={{ color: 'var(--game-brass-hot)' }}>{ps.claimedPeasants}</strong></span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {UPGRADES.filter(u => u.power === power).map(u => {
              const taken = ps.upgradesInPlay.includes(u.id);
              return (
                <div key={u.id} className="gt-divider" style={{ paddingTop: 5, marginTop: 0, opacity: taken ? 1 : 0.5 }}>
                  <div style={{ fontFamily: "'Cinzel', serif", fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: taken ? color : 'var(--game-paper-fade)' }}>
                    {u.name}{taken && ' ✓'}
                  </div>
                  <div className={taken ? 'gt-body' : 'gt-fade'} style={{ fontSize: '0.78rem' }}>{u.effect}</div>
                </div>
              );
            })}
          </div>
          <div className="gt-divider" style={{ paddingTop: 6, marginTop: 2 }}>
            <div className="gt-sublabel" style={{ marginBottom: 2 }}>Dial advancement</div>
            <div className="gt-body" style={{ fontSize: '0.8rem' }}>{dialAdvancementCondition(power)}</div>
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
        className={`gsb-chip ${ruinCount > 0 ? 'is-danger' : ''}`}
      >
        <span>Ruined</span>
        <span className="gsb-chip-value">{ruinCount}</span>
      </div>

      {hovered && createPortal(
        <div
          className="gt"
          style={{
            left: '50%',
            transform: 'translateX(-50%)',
            top: chipBottom + 8,
            ['--tt-accent' as string]: 'var(--game-blood)',
            ['--tt-glow' as string]: 'rgba(194, 24, 24, 0.3)',
            fontSize: '0.92rem',
          }}
        >
          <div className="gt-title" style={{ color: RUINED_TEXT }}>Ruination Cards</div>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr className="gt-fade" style={{ fontFamily: "'Cinzel', serif", fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.18em' }}>
                <th style={{ textAlign: 'left', padding: '4px 10px 6px 0' }}>Card</th>
                <th style={{ textAlign: 'center', padding: '4px 10px 6px' }}>Ruiner VP</th>
                {REGION_ORDER.map(rid => (
                  <th key={rid} style={{ textAlign: 'center', padding: '4px 6px 6px', whiteSpace: 'nowrap' }}>
                    {REGIONS[rid].name}
                  </th>
                ))}
                <th style={{ textAlign: 'center', padding: '4px 10px 6px' }}>1st</th>
                <th style={{ textAlign: 'center', padding: '4px 10px 6px' }}>2nd</th>
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
                      borderTop: '1px solid var(--game-slate-line)',
                      opacity: isUsed ? 0.55 : 1,
                    }}
                  >
                    <td style={{ padding: '5px 10px 5px 0', fontWeight: 700, color: isUsed ? 'var(--game-paper-fade)' : 'var(--game-paper)' }}>
                      #{card.index}
                    </td>
                    <td style={{ textAlign: 'center', padding: '5px 10px', color: 'var(--game-brass-hot)', fontWeight: 600 }}>
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
                            padding: '5px 6px',
                            background: isThisRegion ? 'rgba(194, 24, 24, 0.18)' : 'transparent',
                            fontWeight: isThisRegion ? 700 : 400,
                          }}
                        >
                          <span style={{ color: isThisRegion ? RUINED_TEXT : 'var(--game-paper)' }}>{vp.first}</span>
                          <span className="gt-fade">/</span>
                          <span style={{ color: isThisRegion ? '#ff9a9a' : 'var(--game-paper-dim)' }}>{vp.second}</span>
                        </td>
                      );
                    })}
                    <td style={{ textAlign: 'center', padding: '5px 10px', whiteSpace: 'nowrap' }}>
                      {scoring
                        ? scoring.first.map(p => (
                            <span key={p} style={{ color: POWER_COLORS[p], fontWeight: 700 }}>{POWER_LABELS[p]}</span>
                          )).reduce<React.ReactNode[]>((acc, el, i) => i === 0 ? [el] : [...acc, <span key={`s${i}`} className="gt-fade">/</span>, el], [])
                        : <span className="gt-fade">—</span>
                      }
                    </td>
                    <td style={{ textAlign: 'center', padding: '5px 10px', whiteSpace: 'nowrap' }}>
                      {scoring && scoring.second.length > 0
                        ? scoring.second.map(p => (
                            <span key={p} style={{ color: POWER_COLORS[p], fontWeight: 700 }}>{POWER_LABELS[p]}</span>
                          )).reduce<React.ReactNode[]>((acc, el, i) => i === 0 ? [el] : [...acc, <span key={`s${i}`} className="gt-fade">/</span>, el], [])
                        : <span className="gt-fade">—</span>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="gt-fade" style={{ marginTop: 8, fontSize: '0.78rem' }}>
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

  // Leader = whoever is furthest along their dial (ticks closest to victory).
  let leadPower: Power | null = null;
  let leadPos = -1;
  let leadMax = 0;
  for (const p of state.activePowers) {
    const ps = state.powers[p];
    if (!ps) continue;
    const track = THREAT_DIALS[p];
    if (!track) continue;
    const pos = ps.dialPosition;
    const max = track.length - 1;
    // Compare by remaining ticks so a closer-to-win power wins the tie.
    const score = pos - 0.001 * max; // prefer larger pos, break ties by smaller max
    const leadScore = leadPos - 0.001 * leadMax;
    if (score > leadScore) {
      leadPower = p;
      leadPos = pos;
      leadMax = max;
    }
  }

  return (
    <>
      <div
        ref={chipRef}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`gsb-chip is-stacked ${leadPower ? 'is-active' : ''}`}
        style={leadPower ? { ['--accent' as string]: POWER_COLORS[leadPower], borderColor: POWER_COLORS[leadPower], color: POWER_COLORS[leadPower] } : undefined}
      >
        <span>Dial lead</span>
        <span className="gsb-chip-value" style={leadPower ? { color: POWER_COLORS[leadPower] } : undefined}>
          {leadPower ? (<>{POWER_LABELS[leadPower]} {leadPos}<em>/</em>{leadMax}</>) : '—'}
        </span>
      </div>

      {hovered && createPortal(
        <div
          className="gt"
          style={{
            left: '50%',
            transform: 'translateX(-50%)',
            top: chipBottom + 8,
            fontSize: '0.92rem',
          }}
        >
          <div className="gt-title">Threat Dials</div>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr className="gt-fade" style={{ fontFamily: "'Cinzel', serif", fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.18em' }}>
                <th style={{ textAlign: 'left', padding: '4px 12px 6px 0' }}>Power</th>
                <th style={{ textAlign: 'center', padding: '4px 8px 6px' }}>Pos</th>
                <th style={{ textAlign: 'left', padding: '4px 12px 6px' }}>Track (threat · reward)</th>
              </tr>
            </thead>
            <tbody>
              {state.activePowers.map(power => {
                const ps = state.powers[power]!;
                const track = THREAT_DIALS[power];
                const currentIdx = ps.dialPosition;
                return (
                  <tr key={power} style={{ borderTop: '1px solid var(--game-slate-line)' }}>
                    <td style={{ padding: '6px 12px 6px 0', fontWeight: 700, color: POWER_COLORS[power] }}>
                      {POWER_LABELS[power]}
                    </td>
                    <td style={{ textAlign: 'center', padding: '6px 8px', color: 'var(--game-brass-hot)', fontWeight: 700 }}>
                      {currentIdx}/{track.length - 1}
                    </td>
                    <td style={{ padding: '6px 12px', whiteSpace: 'nowrap' }}>
                      {track.map((pos, i) => {
                        const isCurrent = i === currentIdx;
                        const isPast = i < currentIdx;
                        const threatLabel = typeof pos.threat === 'number' ? pos.threat : '★';
                        return (
                          <span
                            key={i}
                            style={{
                              display: 'inline-block',
                              padding: '2px 8px',
                              margin: '0 2px',
                              borderRadius: 1,
                              background: isCurrent ? POWER_COLORS[power] : 'transparent',
                              color: isCurrent ? 'var(--game-ink)' : isPast ? 'var(--game-paper-fade)' : 'var(--game-paper)',
                              border: isCurrent ? 'none' : '1px solid var(--game-slate-line)',
                              fontWeight: isCurrent ? 700 : 500,
                              fontSize: '0.82rem',
                            }}
                          >
                            <span style={{ fontWeight: 700 }}>{threatLabel}</span>
                            <span style={{ margin: '0 4px', opacity: 0.5 }}>·</span>
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
          <div className="gt-fade" style={{ marginTop: 8, fontSize: '0.78rem' }}>
            Highlighted cell = current position. Reach ★ (victory) to win by dial.
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Status bar ────────────────────────────────────────────────────────────────

export default function StatusBar({ state, myPower, players, events: eventLog, onLeave, leaveLabel }: StatusBarProps) {
  const playerByPower = new Map((players ?? []).map((p) => [p.power, p]));
  const waiting = state.pendingAction?.waitingFor ?? null;
  const phaseLabel = PHASE_LABELS[state.phase] ?? state.phase;
  const { slot1, slot2, discardCard } = state.worldTrack;

  return (
    <div className="gsb">
      <NavMenu onLeave={onLeave} leaveLabel={leaveLabel ?? 'Leave Game'} />
      <span className="gsb-sep">|</span>

      <span className="gsb-round">Round {state.round}</span>
      <span className={`gsb-phase phase-${state.phase}`}>{phaseLabel}</span>

      {waiting && !state.winners && (
        <span className="gsb-acting">
          <span className="gsb-acting-label">acting </span>
          <span className="gsb-acting-name" style={{ color: POWER_COLORS[waiting] }}>
            {POWER_LABELS[waiting]}
          </span>
          {waiting === myPower && <span className="gsb-acting-you">· you</span>}
        </span>
      )}

      {state.winners && (
        <span className="gsb-winner">
          {state.winners.length > 0
            ? <>♛ {state.winners.map((w) => POWER_LABELS[w]).join(' & ')} prevails</>
            : <>☩ the mortal world endures — all players lose</>}
        </span>
      )}

      {(slot1 || slot2 || discardCard) && (
        <>
          <span className="gsb-sep">|</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {slot1 && <WorldCardChip cardId={slot1} slot={1} />}
            {slot2 && <WorldCardChip cardId={slot2} slot={2} />}
            {discardCard && <WorldCardChip cardId={discardCard} slot={'D'} />}
          </div>
        </>
      )}

      <span className="gsb-sep">|</span>
      <RuinChip state={state} events={eventLog} />
      <DialChip state={state} />

      <div className="gsb-spacer" />

      <SettingsMenu />

      <div className="gsb-powers">
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
