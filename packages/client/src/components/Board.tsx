import { useState, useCallback } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { GameState, RegionId, Power, TokenType, FollowerInstance, Action } from '@ruin/engine';
import { CARD_BY_ID, WORLD_CARD_BY_ID } from '@ruin/engine';
import { POWER_COLORS, shortCardName } from '../lib/display.js';
import CardTooltip from './CardTooltip.js';

// ── Region layout ─────────────────────────────────────────────────────────────

// SVG viewBox: 800 × 615
const REGION_POSITIONS: Record<RegionId, { x: number; y: number; w: number; h: number; label: string }> = {
  norrsund:    { x: 20,  y: 20,  w: 170, h: 120, label: 'Norrsund' },
  talvimaa:    { x: 230, y: 20,  w: 170, h: 120, label: 'Talvimaa' },
  volensk:     { x: 440, y: 20,  w: 170, h: 120, label: 'Volensk' },
  mittelreich: { x: 335, y: 180, w: 170, h: 120, label: 'Mittelreich' },
  normagne:    { x: 125, y: 340, w: 170, h: 120, label: 'Normagne' },
  almerida:    { x: 20,  y: 490, w: 170, h: 120, label: 'Almerida' },
  toscavar:    { x: 390, y: 340, w: 170, h: 120, label: 'Toscavar' },
  pelascos:    { x: 545, y: 340, w: 170, h: 120, label: 'Pelascos' },
  the_barrens: { x: 590, y: 490, w: 170, h: 120, label: 'The Barrens' },
};

// ── Token display ─────────────────────────────────────────────────────────────

const TOKEN_COLORS: Record<TokenType, string> = {
  event:       '#6366f1',
  hero:        '#f59e0b',
  noble:       '#eab308',
  peasant:     '#78716c',
  ratmen:      '#10b981',
  chaos_stone: '#38bdf8',
};
const TOKEN_LABELS: Record<TokenType, string> = {
  event: 'Ev', hero: 'He', noble: 'No', peasant: 'Pe', ratmen: 'Ra', chaos_stone: 'CS',
};

// ── Follower shapes ───────────────────────────────────────────────────────────

function Triangle({ cx, cy, r, fill, opacity, stroke, strokeWidth }: {
  cx: number; cy: number; r: number;
  fill: string; opacity?: number; stroke?: string; strokeWidth?: number;
}) {
  const pts = `${cx},${cy - r} ${cx + r * 0.87},${cy + r * 0.5} ${cx - r * 0.87},${cy + r * 0.5}`;
  return <polygon points={pts} fill={fill} opacity={opacity ?? 1} stroke={stroke ?? 'none'} strokeWidth={strokeWidth ?? 0} />;
}

function Square({ cx, cy, r, fill, opacity, stroke, strokeWidth }: {
  cx: number; cy: number; r: number;
  fill: string; opacity?: number; stroke?: string; strokeWidth?: number;
}) {
  return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} fill={fill} opacity={opacity ?? 1} stroke={stroke ?? 'none'} strokeWidth={strokeWidth ?? 0} rx={1} />;
}

function CultistShape({ cx, cy, fill, opacity, stroke, strokeWidth }: {
  cx: number; cy: number;
  fill: string; opacity?: number; stroke?: string; strokeWidth?: number;
}) {
  return <rect x={cx - 3} y={cy - 7} width={6} height={14} fill={fill} opacity={opacity ?? 1} stroke={stroke ?? 'none'} strokeWidth={strokeWidth ?? 0} rx={1} />;
}

// ── Figure cluster ────────────────────────────────────────────────────────────

function FigureCluster({ figures, x, y }: { figures: FollowerInstance[]; x: number; y: number }) {
  const sorted = [...figures].sort((a, b) => {
    const r = { incarnation: 0, warrior: 1, cultist: 2 };
    return r[a.class] - r[b.class];
  });
  const MAX = 9;
  const visible = sorted.slice(0, MAX);
  const overflow = sorted.length - MAX;

  return (
    <g>
      {visible.map((fig, i) => {
        const col = i % 5;
        const row = Math.floor(i / 5);
        const fx = x + col * 18 + 9;
        const fy = y + row * 18 + 9;
        const color = POWER_COLORS[fig.controlledBy ?? fig.power];
        const op = fig.tipped ? 0.35 : 0.9;
        const glowStroke = fig.protected ? '#facc15' : undefined;
        const sp = { fill: color, opacity: op, stroke: glowStroke ?? '#111', strokeWidth: glowStroke ? 1.5 : 0.5 };
        return (
          <g key={fig.id}>
            {fig.class === 'incarnation' && <Triangle cx={fx} cy={fy} r={8} {...sp} />}
            {fig.class === 'warrior'     && <Square   cx={fx} cy={fy} r={6} {...sp} />}
            {fig.class === 'cultist'     && <CultistShape cx={fx} cy={fy} {...sp} />}
          </g>
        );
      })}
      {overflow > 0 && (
        <text x={x + 95} y={y + 11} fill="#9ca3af" fontSize="8" fontStyle="italic">+{overflow}</text>
      )}
    </g>
  );
}

// ── Mini card ─────────────────────────────────────────────────────────────────

function MiniCard({ cardId, width, height, onHover, isPending }: {
  cardId: string; width: number; height: number;
  onHover: (id: string | null, x: number, y: number) => void;
  isPending?: boolean;
}) {
  const def = CARD_BY_ID[cardId] ?? WORLD_CARD_BY_ID[cardId];
  if (!def) return null;
  const isChaos = 'power' in def;
  const isPersistent = def.timing === 'persistent' || def.timing === 'constant';
  const accentColor = isChaos ? POWER_COLORS[(def as { power: Power }).power] : '#6366f1';
  const name = shortCardName(def.name);
  const cost = isChaos ? (def as { cost: number }).cost : null;
  const hasMagic = isChaos ? (def as { hasMagicSymbol: boolean }).hasMagicSymbol : false;

  return (
    <g
      onMouseEnter={(e) => onHover(cardId, e.clientX, e.clientY)}
      onMouseMove={(e)  => onHover(cardId, e.clientX, e.clientY)}
      onMouseLeave={()  => onHover(null, 0, 0)}
      style={{ cursor: 'default' }}
    >
      <rect width={width} height={height} rx={3}
        fill={isPending ? '#1a2a1a' : '#1a1433'}
        stroke={isPending ? '#22c55e' : isPersistent ? accentColor : '#3a3a6e'}
        strokeWidth={isPending ? 2 : isPersistent ? 1.5 : 0.75}
        strokeDasharray={isPending ? '3 2' : undefined}
      />
      <rect width={width} height={3} rx={1} fill={accentColor} opacity={0.85} />
      <text x={3} y={12} fill="#e5e7eb" fontSize="8" fontWeight="700" style={{ userSelect: 'none' }}>
        {name.slice(0, 10)}
      </text>
      {cost !== null && (
        <g transform={`translate(${width - 13}, ${height - 13})`}>
          <circle cx={6} cy={6} r={6} fill={accentColor} opacity={0.9} />
          <text x={6} y={10} textAnchor="middle" fill="#fff" fontSize="8" fontWeight="700">{cost}</text>
        </g>
      )}
      {hasMagic && <text x={3} y={height - 3} fill="#a78bfa" fontSize="8">✦</text>}
    </g>
  );
}

// ── Drop zone overlay (HTML div, invisible, DnD droppable) ────────────────────

function RegionDropZone({ regionId, pos }: {
  regionId: RegionId;
  pos: typeof REGION_POSITIONS[RegionId];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: regionId, data: { kind: 'region', regionId } });
  // 800×615 viewBox — positions as percentages of the SVG container
  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'absolute',
        left:   `${(pos.x / 800) * 100}%`,
        top:    `${(pos.y / 615) * 100}%`,
        width:  `${(pos.w / 800) * 100}%`,
        height: `${(pos.h / 615) * 100}%`,
        borderRadius: 6,
        background: isOver ? 'rgba(250,204,21,0.12)' : 'transparent',
        border:    isOver ? '2px solid #facc15' : '2px solid transparent',
        boxSizing: 'border-box',
        transition: 'background 0.1s, border-color 0.1s',
        pointerEvents: 'all',
      }}
    />
  );
}

// ── Region SVG content ────────────────────────────────────────────────────────

function RegionContent({ regionId, pos, state, isHighlighted, isDimmed, pendingCardSlot, onCardHover }: {
  regionId: RegionId;
  pos: typeof REGION_POSITIONS[RegionId];
  state: GameState;
  isHighlighted: boolean;
  isDimmed: boolean;
  pendingCardSlot: { slotIndex: number; cardId: string } | null;
  onCardHover: (id: string | null, x: number, y: number) => void;
}) {
  const region = state.regions[regionId];
  if (!region) return null;
  const isRuined = region.ruinationCardIndex !== null;

  const persistentPowers: Power[] = [];
  for (const slot of region.chaosCards) {
    if (!slot) continue;
    const def = CARD_BY_ID[slot.cardId];
    if (def?.timing === 'persistent') persistentPowers.push(def.power as Power);
  }

  const tokenCounts = new Map<TokenType, number>();
  for (const t of region.tokens) tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);

  const corruptionEntries = (Object.entries(region.corruptionTokens) as [Power, number][]).filter(([, n]) => n > 0);

  const { x, y, w, h } = pos;
  const cardSlotH = 26;
  const cardSlotW = (w - 8) / 2;
  const cardSlotY = y + h - cardSlotH - 4;

  // Merge pending card slot into display
  const displayCards = [...region.chaosCards] as typeof region.chaosCards;
  if (pendingCardSlot) {
    displayCards[pendingCardSlot.slotIndex] = { cardId: pendingCardSlot.cardId, playedBy: 'xarm' as Power, slotIndex: pendingCardSlot.slotIndex as 0 | 1, persistNextRound: false };
  }

  return (
    <g style={{ opacity: isDimmed ? 0.35 : 1, transition: 'opacity 0.15s' }}>
      {/* Persistent card glow rings */}
      {persistentPowers.map((pw, i) => (
        <rect key={`glow-${pw}-${i}`}
          x={x - (i + 1) * 3} y={y - (i + 1) * 3}
          width={w + (i + 1) * 6} height={h + (i + 1) * 6}
          rx={8 + (i + 1) * 2} fill="none"
          stroke={POWER_COLORS[pw]} strokeWidth={2} opacity={0.55 - i * 0.1}
        />
      ))}

      {/* Background */}
      <rect x={x} y={y} width={w} height={h} rx={6}
        fill={isRuined ? '#1a0808' : '#1e1e3a'}
        stroke={isHighlighted ? '#facc15' : isRuined ? '#7f1d1d' : '#3a3a6e'}
        strokeWidth={isHighlighted ? 2.5 : 1}
      />

      {/* Name */}
      <text x={x + w / 2} y={y + 14} textAnchor="middle"
        fill={isRuined ? '#f87171' : '#e5e7eb'} fontSize="10" fontWeight="700"
        style={{ userSelect: 'none' }}>
        {pos.label}
      </text>

      {/* Stats */}
      <text x={x + 5}     y={y + 25} fill="#64748b" fontSize="8">{`R${region.resistance}`}</text>
      <text x={x + 30}    y={y + 25} fill="#64748b" fontSize="8">{`C${region.conquestValue}`}</text>
      {region.populous && (
        <text x={x + w - 5} y={y + 25} textAnchor="end" fill="#facc15" fontSize="8" fontWeight="700">POP</text>
      )}

      {/* Tokens */}
      {tokenCounts.size > 0 && (
        <g transform={`translate(${x + 4}, ${y + 30})`}>
          {Array.from(tokenCounts.entries()).map(([token, count], i) => (
            <g key={token} transform={`translate(${i * 22}, 0)`}>
              <rect width={20} height={13} rx={2} fill={TOKEN_COLORS[token]} opacity={0.85} />
              <text x={10} y={10} textAnchor="middle" fill="#fff" fontSize="7" fontWeight="700">
                {TOKEN_LABELS[token]}{count > 1 ? `×${count}` : ''}
              </text>
            </g>
          ))}
        </g>
      )}

      {/* Corruption */}
      {corruptionEntries.length > 0 && (
        <g transform={`translate(${x + 4}, ${y + 46})`}>
          {corruptionEntries.map(([pw, count], i) => (
            <g key={pw} transform={`translate(${i * 22}, 0)`}>
              <circle cx={10} cy={6} r={7} fill={POWER_COLORS[pw]} opacity={0.75} />
              <text x={10} y={10} textAnchor="middle" fill="#fff" fontSize="7" fontWeight="700">{count}</text>
            </g>
          ))}
        </g>
      )}

      {/* Followers */}
      {region.placements.length > 0 && (
        <FigureCluster figures={region.placements} x={x + 4} y={y + 58} />
      )}

      {/* Card slots */}
      <g transform={`translate(${x + 4}, ${cardSlotY})`}>
        {[0, 1].map((si) => {
          const card = displayCards[si];
          const isPending = pendingCardSlot?.slotIndex === si;
          return (
            <g key={si} transform={`translate(${si * (cardSlotW + 4)}, 0)`}>
              {card ? (
                <MiniCard cardId={card.cardId} width={cardSlotW} height={cardSlotH} onHover={onCardHover} isPending={isPending} />
              ) : (
                <rect width={cardSlotW} height={cardSlotH} rx={3}
                  fill="none" stroke="#2a2a4e" strokeWidth={0.75} strokeDasharray="3 2" />
              )}
            </g>
          );
        })}
      </g>
    </g>
  );
}

// ── Board ─────────────────────────────────────────────────────────────────────

interface BoardProps {
  state: GameState;
  highlightRegions?: RegionId[];
  dimmedRegions?: RegionId[];
  pendingAction?: Action | null;
  onRegionClick?: (regionId: RegionId) => void;
}

export default function Board({ state, highlightRegions, dimmedRegions, pendingAction }: BoardProps) {
  const [tooltip, setTooltip] = useState<{ cardId: string; x: number; y: number } | null>(null);

  const handleCardHover = useCallback((cardId: string | null, x: number, y: number) => {
    setTooltip(cardId ? { cardId, x, y } : null);
  }, []);

  // Extract pending card placement for visual preview
  function getPendingCard(regionId: RegionId) {
    if (!pendingAction || pendingAction.kind !== 'summoning_play_card') return null;
    if ((pendingAction as { toRegion: RegionId }).toRegion !== regionId) return null;
    return {
      slotIndex: (pendingAction as { slotIndex: number }).slotIndex,
      cardId: (pendingAction as { cardId: string }).cardId,
    };
  }

  const isDragging = (highlightRegions !== undefined || dimmedRegions !== undefined);

  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '800 / 615' }}>
      {/* SVG board */}
      <svg
        viewBox="0 0 800 615"
        style={{ width: '100%', height: '100%', display: 'block', borderRadius: 8, background: '#0d0d1f' }}
      >
        <text x={10} y={606} fill="#334155" fontSize="10">
          World: {state.worldTrack.slot1 ?? '—'} / {state.worldTrack.slot2 ?? '—'}
          {'   '}Ruination: {state.ruinationCardsUsed} / 5
        </text>

        {(Object.entries(REGION_POSITIONS) as [RegionId, typeof REGION_POSITIONS[RegionId]][]).map(
          ([regionId, pos]) => (
            <RegionContent
              key={regionId}
              regionId={regionId}
              pos={pos}
              state={state}
              isHighlighted={highlightRegions?.includes(regionId) ?? false}
              isDimmed={isDragging && !(highlightRegions?.includes(regionId) ?? false)}
              pendingCardSlot={getPendingCard(regionId)}
              onCardHover={handleCardHover}
            />
          ),
        )}
      </svg>

      {/* Invisible HTML drop-zone overlays (sits on top of SVG, pointer-events during drag) */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: isDragging ? 'all' : 'none' }}>
        {(Object.entries(REGION_POSITIONS) as [RegionId, typeof REGION_POSITIONS[RegionId]][]).map(
          ([regionId, pos]) => (
            <RegionDropZone key={regionId} regionId={regionId} pos={pos} />
          ),
        )}
      </div>

      {tooltip && <CardTooltip cardId={tooltip.cardId} x={tooltip.x} y={tooltip.y} />}
    </div>
  );
}
