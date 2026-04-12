import { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import type { GameState, RegionId, Power, TokenType, FollowerInstance, Action } from '@ruin/engine';
import { CARD_BY_ID, WORLD_CARD_BY_ID, REGIONS, getRegionDomination, getRegionResistance, getPowerDomination, ADJACENCY, followersInRegion } from '@ruin/engine';
import { POWER_COLORS, shortCardName } from '../lib/display.js';
import CardTooltip from './CardTooltip.js';
import FollowerTooltip from './FollowerTooltip.js';
import BattlePane from './BattlePane.js';
import type { DragItem } from '../types/drag.js';

// ── Region layout ─────────────────────────────────────────────────────────────

// SVG viewBox: 800 × 615
export const BOARD_VIEWBOX_W = 800;
export const BOARD_VIEWBOX_H = 615;
export const REGION_POSITIONS: Record<RegionId, { x: number; y: number; w: number; h: number; label: string }> = {
  norrsund:    { x: 20,  y: 20,  w: 170, h: 120, label: 'Norrsund' },
  talvimaa:    { x: 230, y: 20,  w: 170, h: 120, label: 'Talvimaa' },
  volensk:     { x: 440, y: 20,  w: 170, h: 120, label: 'Volensk' },
  mittelreich: { x: 335, y: 180, w: 170, h: 120, label: 'Mittelreich' },
  normagne:    { x: 125, y: 340, w: 170, h: 120, label: 'Normagne' },
  almerida:    { x: 20,  y: 490, w: 170, h: 120, label: 'Almerida' },
  toscavar:    { x: 335, y: 415, w: 170, h: 120, label: 'Toscavar' },
  pelascos:    { x: 570, y: 340, w: 170, h: 120, label: 'Pelascos' },
  the_barrens: { x: 590, y: 490, w: 170, h: 120, label: 'The Barrens' },
};

// ── Token display ─────────────────────────────────────────────────────────────

const TOKEN_COLORS: Record<TokenType, string> = {
  event:       '#6366f1',
  hero:        '#f59e0b',
  noble:       '#eab308',
  peasant:     '#78716c',
  ratmen:      '#10b981',
  chaos_stone: '#14b8a6',
};
const TOKEN_LABELS: Record<TokenType, string> = {
  event: 'Ev', hero: 'He', noble: 'Nb', peasant: 'Pe', ratmen: 'Ra', chaos_stone: 'CS',
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

// ── Figure layout (shared by FigureCluster and corruption fly animations) ────

const FIGURE_POWER_ORDER: Record<string, number> = { xarm: 0, gormen: 1, tenzen: 2, lasha: 3 };
const FIGURE_RANK_ORDER: Record<string, number> = { incarnation: 0, warrior: 1, cultist: 2 };
export const FIGURE_COLS = 10;
export const FIGURE_STEP = 15;
export const FIGURE_MAX = 20;
/** Offset from the figure cluster's base (x, y) to the center of the first shape. */
export const FIGURE_CENTER_OFFSET = 8;

export interface FigurePosition {
  figure: FollowerInstance;
  index: number;
  cx: number;
  cy: number;
}

/**
 * Sort figures (power order, then class rank) and compute on-screen positions
 * within a cluster whose top-left corner is at (baseX, baseY). Only the first
 * FIGURE_MAX figures get positions — the rest overflow.
 */
export function layoutFigureCluster(
  figures: FollowerInstance[],
  baseX: number,
  baseY: number,
): FigurePosition[] {
  const sorted = [...figures].sort((a, b) => {
    const pa = FIGURE_POWER_ORDER[a.power] ?? 99;
    const pb = FIGURE_POWER_ORDER[b.power] ?? 99;
    if (pa !== pb) return pa - pb;
    return (FIGURE_RANK_ORDER[a.class] ?? 0) - (FIGURE_RANK_ORDER[b.class] ?? 0);
  });
  const positions: FigurePosition[] = [];
  const limit = Math.min(sorted.length, FIGURE_MAX);
  for (let i = 0; i < limit; i++) {
    const figure = sorted[i]!;
    const col = i % FIGURE_COLS;
    const row = Math.floor(i / FIGURE_COLS);
    positions.push({
      figure,
      index: i,
      cx: baseX + col * FIGURE_STEP + FIGURE_CENTER_OFFSET,
      cy: baseY + row * FIGURE_STEP + FIGURE_CENTER_OFFSET,
    });
  }
  return positions;
}

// ── Figure cluster ────────────────────────────────────────────────────────────

function FigureCluster({ figures, x, y, powers, highlightSince, animationKilledIds, hideKilled, myPower, summoningAnim }: {
  figures: FollowerInstance[];
  x: number;
  y: number;
  powers: GameState['powers'];
  myPower?: Power | null;
  summoningAnim?: { appearingFigures: Set<string>; movingFigures: Map<string, { fromRegion: string; toRegion: string }>; appearingCards: Set<string> };
  highlightSince: number | null;
  animationKilledIds?: Set<string>;
  hideKilled?: boolean;
}) {
  const [hovered, setHovered] = useState<{ fig: FollowerInstance; mx: number; my: number } | null>(null);
  const filteredFigures = hideKilled && animationKilledIds
    ? figures.filter(f => !animationKilledIds.has(f.id))
    : figures;
  const positions = layoutFigureCluster(filteredFigures, x, y);
  const overflow = filteredFigures.length - positions.length;

  return (
    <g>
      {positions.map(({ figure: fig, cx: fx, cy: fy }) => {
        const color = POWER_COLORS[fig.controlledBy ?? fig.power];
        const isAnimKilled = animationKilledIds?.has(fig.id) ?? false;
        const op = (fig.tipped || isAnimKilled) ? 0.3 : 0.9;
        const isNew = highlightSince !== null && fig.placedAt > highlightSince
          && (fig.controlledBy ?? fig.power) !== myPower;
        const glowStroke = isAnimKilled ? '#ef4444' : fig.protected ? '#facc15' : undefined;
        const sp = { fill: color, opacity: op, stroke: glowStroke ?? '#111', strokeWidth: glowStroke ? 1.5 : 0.5 };
        const isAppearing = summoningAnim?.appearingFigures.has(fig.id) ?? false;
        const isMoving = summoningAnim?.movingFigures.has(fig.id) ?? false;
        const animStyle = (isAppearing || isMoving) ? 'summoning-appear' : undefined;
        return (
          <g key={fig.id}>
            {(isAppearing || isMoving) && (
              <circle
                cx={fx} cy={fy}
                className="summoning-ring"
                fill="none"
                stroke={color}
                strokeWidth={1.5}
              />
            )}
            <g
              className={animStyle}
              style={{ cursor: 'default' }}
              filter={isNew && !fig.protected ? 'url(#new-glow)' : undefined}
              onMouseEnter={e => setHovered({ fig, mx: e.clientX, my: e.clientY })}
              onMouseMove={e => setHovered({ fig, mx: e.clientX, my: e.clientY })}
              onMouseLeave={() => setHovered(null)}
            >
              {fig.class === 'incarnation' && <Square   cx={fx} cy={fy} r={8} {...sp} />}
              {fig.class === 'warrior'     && <Triangle cx={fx} cy={fy} r={6} {...sp} />}
              {fig.class === 'cultist'     && <CultistShape cx={fx} cy={fy} {...sp} />}
            </g>
          </g>
        );
      })}
      {overflow > 0 && (
        <text x={x + FIGURE_COLS * FIGURE_STEP + 2} y={y + 11} fill="#9ca3af" fontSize="8" fontStyle="italic">+{overflow}</text>
      )}
      {hovered && (
        <FollowerTooltip
          power={hovered.fig.power}
          followerClass={hovered.fig.class}
          upgradesInPlay={powers[hovered.fig.power]?.upgradesInPlay ?? []}
          x={hovered.mx}
          y={hovered.my}
        />
      )}
    </g>
  );
}

// ── Mini card ─────────────────────────────────────────────────────────────────

function MiniCard({ cardId, width, height, onHover, isPending, isNew, isAppearing }: {
  cardId: string; width: number; height: number;
  onHover: (id: string | null, x: number, y: number) => void;
  isPending?: boolean;
  isNew?: boolean;
  isAppearing?: boolean;
}) {
  const def = CARD_BY_ID[cardId] ?? WORLD_CARD_BY_ID[cardId];
  if (!def) return null;
  const isChaos = 'power' in def;
  const isPersistent = def.timing === 'persistent' || def.timing === 'constant';
  const accentColor = isChaos ? POWER_COLORS[(def as { power: Power }).power] : '#6366f1';
  const name = shortCardName(('shortName' in def && def.shortName) || def.name);
  const cost = isChaos ? (def as { cost: number }).cost : null;
  const hasMagic = isChaos ? (def as { hasMagicSymbol: boolean }).hasMagicSymbol : false;

  return (
    <g>
      {isAppearing && (
        <circle
          cx={width / 2} cy={height / 2}
          className="summoning-ring"
          fill="none"
          stroke={accentColor}
          strokeWidth={1.5}
        />
      )}
      <g
        className={isAppearing ? 'summoning-card-appear' : undefined}
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
        filter={isNew ? 'url(#new-glow)' : undefined}
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
    </g>
  );
}

// ── Drop zone overlay (HTML div, invisible, DnD droppable) ────────────────────

function RegionDropZone({ regionId, pos, onClick, active }: {
  regionId: RegionId;
  pos: typeof REGION_POSITIONS[RegionId];
  onClick?: () => void;
  active?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: regionId, data: { kind: 'region', regionId } });
  return (
    <div
      ref={setNodeRef}
      onClick={onClick}
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
        pointerEvents: active ? 'all' : 'none',
        cursor: onClick ? 'pointer' : 'default',
      }}
    />
  );
}

// ── Draggable figure overlay ──────────────────────────────────────────────────

// SVG viewBox is 800×615; the Board container has the same aspect ratio.
// Convert SVG coords to percentages for absolute HTML positioning.
function svgPct(svgCoord: number, axis: 'x' | 'y') {
  return `${(svgCoord / (axis === 'x' ? 800 : 615)) * 100}%`;
}

function DraggableFigureOverlay({ fig, fromRegion, svgX, svgY }: {
  fig: FollowerInstance;
  fromRegion: RegionId;
  svgX: number;
  svgY: number;
}) {
  const dragData: DragItem = {
    kind: 'board_follower',
    followerId: fig.id,
    followerClass: fig.class,
    power: fig.controlledBy ?? fig.power,
    fromRegion,
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `board_fig_${fig.id}`,
    data: dragData,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{
        position: 'absolute',
        left: svgPct(svgX, 'x'),
        top:  svgPct(svgY, 'y'),
        width: 18,
        height: 18,
        transform: 'translate(-50%, -50%)',
        cursor: isDragging ? 'grabbing' : 'grab',
        opacity: isDragging ? 0 : 1,
        borderRadius: fig.class === 'cultist' ? '50%' : fig.class === 'incarnation' ? '2px' : '0',
        border: `1.5px solid ${POWER_COLORS[fig.controlledBy ?? fig.power]}`,
        background: 'transparent',
        zIndex: 5,
        touchAction: 'none',
        pointerEvents: 'auto',
      }}
    />
  );
}

// ── Region SVG content ────────────────────────────────────────────────────────

function RegionContent({ regionId, pos, state, isHighlighted, isDimmed, pendingCardSlot, onCardHover, onTokenHover, highlightSince, isAnimationTarget, animationKilledIds, hideKilled, corruptionOverride, myPower, summoningAnim }: {
  regionId: RegionId;
  pos: typeof REGION_POSITIONS[RegionId];
  state: GameState;
  isHighlighted: boolean;
  isDimmed: boolean;
  pendingCardSlot: { slotIndex: number; cardId: string } | null;
  onCardHover: (id: string | null, x: number, y: number) => void;
  onTokenHover: (token: TokenType | null, x: number, y: number) => void;
  highlightSince: number | null;
  isAnimationTarget: boolean;
  animationKilledIds?: Set<string>;
  hideKilled?: boolean;
  corruptionOverride?: Partial<Record<Power, number>>;
  myPower?: Power | null;
  summoningAnim?: { appearingFigures: Set<string>; movingFigures: Map<string, { fromRegion: string; toRegion: string }>; appearingCards: Set<string> };
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

  // Corruption display: if an override is provided (during animation), use
  // it to compute displayed counts relative to the snapshot's base tokens.
  const baseCorruption = region.corruptionTokens;
  const displayCorruption = corruptionOverride
    ? {
        xarm:   baseCorruption.xarm   + (corruptionOverride.xarm   ?? 0),
        gormen: baseCorruption.gormen + (corruptionOverride.gormen ?? 0),
        tenzen: baseCorruption.tenzen + (corruptionOverride.tenzen ?? 0),
        lasha:  baseCorruption.lasha  + (corruptionOverride.lasha  ?? 0),
      }
    : baseCorruption;
  const corruptionEntries = (Object.entries(displayCorruption) as [Power, number][]).filter(([, n]) => n > 0);

  const { x, y, w, h } = pos;
  const cardSlotH = 26;
  const cardSlotW = (w - 8) / 2;
  const cardSlotY = y + h - cardSlotH - 4;

  // Merge pending card slot into display
  const displayCards = [...region.chaosCards] as typeof region.chaosCards;
  if (pendingCardSlot) {
    displayCards[pendingCardSlot.slotIndex] = { cardId: pendingCardSlot.cardId, playedBy: 'xarm' as Power, slotIndex: pendingCardSlot.slotIndex as 0 | 1, persistNextRound: false, placedAt: 0 };
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
        stroke={
          isAnimationTarget ? '#ef4444' :
          isHighlighted ? '#facc15' :
          isRuined ? '#7f1d1d' : '#3a3a6e'
        }
        strokeWidth={isAnimationTarget ? 3 : isHighlighted ? 2.5 : 1}
        style={isAnimationTarget ? { filter: 'drop-shadow(0 0 8px #ef4444)' } : undefined}
      />

      {/* Name */}
      <text x={x + w / 2} y={y + 14} textAnchor="middle"
        fill={isRuined ? '#f87171' : '#e5e7eb'} fontSize="10" fontWeight="700"
        style={{ userSelect: 'none' }}>
        {pos.label}
      </text>

      {/* Stats: R V D C CULT (with red ! if C+CULT ≥ 12) */}
      {(() => {
        const R = getRegionResistance(state, regionId);
        const V = region.conquestValue + (tokenCounts.get('noble') ?? 0);
        const dom = getRegionDomination(state, regionId);
        const corruptionTotal =
          (Object.values(region.corruptionTokens) as number[]).reduce((a, b) => a + b, 0) +
          (tokenCounts.get('chaos_stone') ?? 0);
        const regionFollowers = followersInRegion(state, regionId);
        const cultCount = regionFollowers.filter(f => f.class === 'cultist').length;
        const danger = corruptionTotal + cultCount >= 12;
        // Leading ruiner: most (corruption tokens + cultists) in region
        const ruinerScore: Partial<Record<Power, number>> = { ...region.corruptionTokens };
        for (const f of regionFollowers) {
          if (f.class !== 'cultist') continue;
          const pw = (f.controlledBy ?? f.power) as Power;
          ruinerScore[pw] = (ruinerScore[pw] ?? 0) + 1;
        }
        let topRuiner: Power | null = null;
        let topCount = 0;
        for (const [pw, n] of Object.entries(ruinerScore) as [Power, number][]) {
          if (n > topCount) { topCount = n; topRuiner = pw; }
        }
        const cColor = topRuiner ? POWER_COLORS[topRuiner] : '#64748b';
        const parts: { label: string; color: string; bold?: boolean }[] = [
          { label: `R${R}`, color: '#64748b' },
          { label: `V${V}`, color: '#64748b' },
        ];
        if (isRuined) {
          parts.push({ label: 'RUINED', color: '#f87171', bold: true });
        } else {
          if (dom.leader) parts.push({ label: `D${dom.value}`, color: POWER_COLORS[dom.leader], bold: true });
          parts.push({ label: `C${corruptionTotal}${cultCount > 0 ? `+${cultCount}` : ''}${danger ? '!' : ''}`, color: cColor, bold: danger || !!topRuiner });
        }
        const step = (w / 2) / parts.length;
        return (
          <g>
            {parts.map((p, i) => (
              <text key={i} x={x + 5 + i * step} y={y + 25} fill={p.color} fontSize="8" fontWeight={p.bold ? 700 : 400}
                style={{ userSelect: 'none' }}>
                {p.label}
              </text>
            ))}
          </g>
        );
      })()}
      {region.populous && (
        <text x={x + w - 5} y={y + 25} textAnchor="end" fill="#facc15" fontSize="8" fontWeight="700">POP</text>
      )}

      {/* Tokens */}
      {tokenCounts.size > 0 && (
        <g transform={`translate(${x + 4}, ${y + 30})`}>
          {Array.from(tokenCounts.entries()).map(([token, count], i) => (
            <g
              key={token}
              transform={`translate(${i * 23}, 0)`}
              onMouseEnter={(e) => onTokenHover(token, e.clientX, e.clientY)}
              onMouseMove={(e) => onTokenHover(token, e.clientX, e.clientY)}
              onMouseLeave={() => onTokenHover(null, 0, 0)}
              style={{ cursor: 'help' }}
            >
              <rect width={22} height={13} rx={2} fill={TOKEN_COLORS[token]} opacity={0.85} />
              <text x={11} y={10} textAnchor="middle" fill="#fff" fontSize="7" fontWeight="700">
                {TOKEN_LABELS[token]}{count > 1 ? `×${count}` : ''}
              </text>
            </g>
          ))}
        </g>
      )}

      {/* Corruption (right-aligned, same row as tokens) */}
      {corruptionEntries.length > 0 && (
        <g transform={`translate(${x + w - 4 - corruptionEntries.length * 15}, ${y + 30})`}>
          {corruptionEntries.map(([pw, count], i) => (
            <g key={pw} transform={`translate(${i * 15}, 0)`}>
              <circle cx={7} cy={6} r={6} fill={POWER_COLORS[pw]} opacity={0.75} />
              <text x={7} y={9} textAnchor="middle" fill="#fff" fontSize="7" fontWeight="700">{count}</text>
            </g>
          ))}
        </g>
      )}

      {/* Followers */}
      {(() => { const figures = followersInRegion(state, regionId); return figures.length > 0 && (
        <FigureCluster figures={figures} x={x + 4} y={y + 46} powers={state.powers} highlightSince={highlightSince} animationKilledIds={animationKilledIds} hideKilled={hideKilled} myPower={myPower} summoningAnim={summoningAnim} />
      ); })()}

      {/* Card slots — hidden when region is ruined */}
      {!isRuined && <g transform={`translate(${x + 4}, ${cardSlotY})`}>
        {[0, 1].map((si) => {
          const card = displayCards[si];
          const isPending = pendingCardSlot?.slotIndex === si;
          return (
            <g key={si} transform={`translate(${si * (cardSlotW + 4)}, 0)`}>
              {card ? (
                <MiniCard cardId={card.cardId} width={cardSlotW} height={cardSlotH} onHover={onCardHover} isPending={isPending}
                  isNew={highlightSince !== null && card.placedAt > highlightSince && card.playedBy !== myPower}
                  isAppearing={summoningAnim?.appearingCards.has(`${regionId}-${si}`) ?? false} />
              ) : (
                <rect width={cardSlotW} height={cardSlotH} rx={3}
                  fill="none" stroke="#2a2a4e" strokeWidth={0.75} strokeDasharray="3 2" />
              )}
            </g>
          );
        })}
      </g>}
    </g>
  );
}

// ── World token tooltip ──────────────────────────────────────────────────────

const TOKEN_NAMES: Record<TokenType, string> = {
  event: 'Event Token',
  hero: 'Hero Token',
  noble: 'Noble Token',
  peasant: 'Peasant Token',
  ratmen: 'Ratmen Token',
  chaos_stone: 'Chaos Stone',
};

const TOKEN_DESCRIPTIONS: Record<TokenType, string> = {
  event: 'Placed by World cards. Many events trigger off the presence of Event tokens; they remain on the region until removed by a card or effect.',
  hero: 'At the End Phase, a hero will remove a figure of the highest threat player present. Lasha gains dial advancement when corrupting this region.',
  noble: 'Adds +1 to the region\'s VP reward when conquered. Lasha gains dial advancement when corrupting this region.',
  peasant: 'Potential target of attacks. May tie in with events.',
  ratmen: 'Hostile tokens that consume Peasants and may interfere with player figures. Reduce influence in the region until removed.',
  chaos_stone: 'Counts as +1 corruption in this region during the corruption phase. Tenzen gains dial advancement when corrupting a region with 2 chaos stones/magic symbols.',
};

function TokenTooltip({ token, x, y }: { token: TokenType; x: number; y: number }) {
  const left = Math.min(x + 14, window.innerWidth - 240);
  const top  = Math.min(y + 14, window.innerHeight - 140);
  return createPortal(
    <div style={{
      position: 'fixed', left, top, width: 230,
      background: '#0d0d1f', border: `1px solid ${TOKEN_COLORS[token]}`,
      borderRadius: 8, padding: '8px 10px',
      pointerEvents: 'none', zIndex: 9999,
      boxShadow: `0 0 12px ${TOKEN_COLORS[token]}55`,
      fontSize: '0.78rem', lineHeight: 1.5, color: '#e5e7eb',
    }}>
      <div style={{ fontWeight: 700, color: '#fff', marginBottom: 4 }}>{TOKEN_NAMES[token]}</div>
      <div style={{ color: '#cbd5e1', fontSize: '0.74rem' }}>{TOKEN_DESCRIPTIONS[token]}</div>
    </div>,
    document.body,
  );
}

// ── Region info tooltip ──────────────────────────────────────────────────────

const POWER_LABELS: Record<Power, string> = {
  xarm: 'Xarm', gormen: 'Gormen', tenzen: 'Tenzen', lasha: 'Lasha',
};

function RegionInfoTooltip({ state, regionId, x, y }: {
  state: GameState; regionId: RegionId; x: number; y: number;
}) {
  const region = state.regions[regionId];
  if (!region) return null;
  const def = REGIONS[regionId];
  const tokenCounts = new Map<TokenType, number>();
  for (const t of region.tokens) tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
  const corruptionTotal =
    (Object.values(region.corruptionTokens) as number[]).reduce((a, b) => a + b, 0) +
    (tokenCounts.get('chaos_stone') ?? 0);
  const tooltipFollowers = followersInRegion(state, regionId);
  const cultCount = tooltipFollowers.filter(f => f.class === 'cultist').length;
  const willRuin = corruptionTotal + cultCount >= 12;
  const resistance = getRegionResistance(state, regionId);
  const vp = region.conquestValue + (tokenCounts.get('noble') ?? 0);

  const presentPowers = new Set<Power>();
  for (const f of tooltipFollowers) presentPowers.add((f.controlledBy ?? f.power) as Power);
  for (const slot of region.chaosCards) if (slot) presentPowers.add(slot.playedBy);
  const powers: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
  const domEntries = powers
    .filter(p => presentPowers.has(p))
    .map(p => ({ p, d: getPowerDomination(state, regionId, p) }));

  const left = Math.min(x + 14, window.innerWidth - 240);
  const top  = Math.min(y + 14, window.innerHeight - 200);

  return createPortal(
    <div style={{
      position: 'fixed', left, top, width: 230,
      background: '#0d0d1f', border: '1px solid #3a3a6e',
      borderRadius: 8, padding: '10px 12px',
      pointerEvents: 'none', zIndex: 9999,
      boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
      fontSize: '0.78rem', lineHeight: 1.5, color: '#e5e7eb',
    }}>
      <div style={{ fontWeight: 700, color: '#fff', marginBottom: 6, fontSize: '0.9rem' }}>{def.name}</div>
      {def.populous && (
        <div style={{ color: '#facc15', fontSize: '0.72rem', marginBottom: 4 }}>Populous</div>
      )}
      <div>Resistance: <span style={{ color: '#fff', fontWeight: 600 }}>{resistance}</span></div>
      <div>VP reward: <span style={{ color: '#fff', fontWeight: 600 }}>{vp}</span>
        {(tokenCounts.get('noble') ?? 0) > 0 && (
          <span style={{ color: '#94a3b8' }}> ({region.conquestValue} base + {tokenCounts.get('noble')} noble)</span>
        )}
      </div>
      {region.ruinationCardIndex !== null ? (
        <div style={{ marginTop: 6, color: '#f87171', fontWeight: 700, fontSize: '0.85rem' }}>
          RUINED
        </div>
      ) : (
        <>
          <div style={{ marginTop: 6, color: '#94a3b8', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: 0.3 }}>
            Domination
          </div>
          {domEntries.length === 0 && <div style={{ color: '#64748b' }}>—</div>}
          {domEntries.map(({ p, d }) => (
            <div key={p}>
              <span style={{ color: POWER_COLORS[p], fontWeight: 600 }}>{POWER_LABELS[p]}</span>
              : <span style={{ color: d > resistance ? '#fff' : '#64748b' }}>{d}</span>
            </div>
          ))}
          <div style={{ marginTop: 6 }}>
            Corruption: <span style={{ color: '#fff', fontWeight: 600 }}>{corruptionTotal}</span>
            {cultCount > 0 && <span style={{ color: '#94a3b8' }}> (+{cultCount} incoming)</span>}
          </div>
          {willRuin && (
            <div style={{ marginTop: 6, color: '#ef4444', fontWeight: 700 }}>
              ⚠ This region may ruin this round
            </div>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}

// ── Board ─────────────────────────────────────────────────────────────────────

interface BoardProps {
  state: GameState;
  highlightRegions?: RegionId[];
  dimmedRegions?: RegionId[];
  pendingAction?: Action | null;
  onRegionClick?: (regionId: RegionId) => void;
  myPower?: Power | null;
  animationRegion?: RegionId | null;
  animationKilledIds?: Set<string>;
  hideKilled?: boolean;
  battlePaneEvents?: import('@ruin/engine').GameEvent[];
  dominationLabels?: Map<RegionId, { power: Power; vp: number }>;
  corruptionOverrides?: Map<RegionId, Partial<Record<Power, number>>>;
  corruptionFlies?: Array<{ id: number; regionId: RegionId; power: Power; tokens: number; startedAt: number }>;
  summoningAnim?: { appearingFigures: Set<string>; movingFigures: Map<string, { fromRegion: string; toRegion: string }>; appearingCards: Set<string> };
}

export default function Board({ state, highlightRegions, dimmedRegions, pendingAction, onRegionClick, myPower, animationRegion, animationKilledIds, hideKilled, battlePaneEvents, dominationLabels, corruptionOverrides, corruptionFlies, summoningAnim }: BoardProps) {
  const [tooltip, setTooltip] = useState<{ cardId: string; x: number; y: number } | null>(null);
  const [regionTooltip, setRegionTooltip] = useState<{ regionId: RegionId; x: number; y: number } | null>(null);
  const [tokenTooltip, setTokenTooltip] = useState<{ token: TokenType; x: number; y: number } | null>(null);
  const [hoveredBattleRegion, setHoveredBattleRegion] = useState<RegionId | null>(null);

  // Build the set of regions that had battles (from battlePaneEvents)
  const regionsWithBattles = new Set<RegionId>();
  if (battlePaneEvents) {
    for (const ev of battlePaneEvents) {
      if (ev.type === 'battle_region_start') {
        regionsWithBattles.add(ev.regionId);
      }
    }
  }

  // Decide which region's battle pane to show:
  // - Other tooltips (card, region info, token) take priority — hide pane
  // - Otherwise: active animation region, or hovered region (if it had a battle)
  const hasOtherTooltip = tooltip !== null || regionTooltip !== null || tokenTooltip !== null;
  const displayedBattleRegion: RegionId | null = hasOtherTooltip
    ? null
    : animationRegion ??
      (hoveredBattleRegion && regionsWithBattles.has(hoveredBattleRegion) ? hoveredBattleRegion : null);
  const handleTokenHover = useCallback((token: TokenType | null, x: number, y: number) => {
    setTokenTooltip(token ? { token, x, y } : null);
  }, []);

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

  // During summoning phase, highlight figures/cards placed since the acting power's last turn.
  // The human player's own power is excluded from the glow so their own placements don't flash.
  const actingPower = state.pendingAction?.waitingFor ?? null;
  const highlightSince = (state.phase === 'summoning' && actingPower)
    ? state.powers[actingPower]?.lastSummonTurnAt ?? null
    : null;

  const isDragging = (highlightRegions !== undefined || dimmedRegions !== undefined);

  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: 'calc((100vh - 280px) * 800 / 615)', aspectRatio: '800 / 615' }}>
      {/* SVG board */}
      <svg
        viewBox="0 0 800 615"
        style={{ width: '100%', height: '100%', display: 'block', borderRadius: 8, background: '#0d0d1f' }}
      >
        <defs>
          <filter id="new-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="0" stdDeviation="2" floodColor="#facc15" floodOpacity="0.6" />
          </filter>
        </defs>
        {/* Connection lines between adjacent regions */}
        <g>
          {(() => {
            const drawn = new Set<string>();
            const lines: React.ReactNode[] = [];
            for (const [a, neighbors] of Object.entries(ADJACENCY) as [RegionId, RegionId[]][]) {
              const pa = REGION_POSITIONS[a];
              for (const b of neighbors) {
                const key = a < b ? `${a}|${b}` : `${b}|${a}`;
                if (drawn.has(key)) continue;
                drawn.add(key);
                const pb = REGION_POSITIONS[b];
                const x1 = pa.x + pa.w / 2;
                const y1 = pa.y + pa.h / 2;
                const x2 = pb.x + pb.w / 2;
                const y2 = pb.y + pb.h / 2;
                lines.push(
                  <line key={key} x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke="#3a3a6e" strokeWidth={1.5} opacity={0.35} strokeDasharray="4 3" />
                );
              }
            }
            return lines;
          })()}
        </g>
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
              onTokenHover={handleTokenHover}
              highlightSince={highlightSince}
              isAnimationTarget={animationRegion === regionId}
              animationKilledIds={animationKilledIds}
              hideKilled={hideKilled}
              corruptionOverride={corruptionOverrides?.get(regionId)}
              myPower={myPower}
              summoningAnim={summoningAnim}
            />
          ),
        )}
      </svg>

      {/* Invisible HTML overlays — drop zones during drag, click zones when onRegionClick provided */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: (isDragging || !!onRegionClick) ? 'all' : 'none' }}>
        {(Object.entries(REGION_POSITIONS) as [RegionId, typeof REGION_POSITIONS[RegionId]][]).map(
          ([regionId, pos]) => (
            <RegionDropZone
              key={regionId}
              regionId={regionId}
              pos={pos}
              onClick={onRegionClick ? () => onRegionClick(regionId) : undefined}
              active={isDragging || !!onRegionClick}
            />
          ),
        )}
      </div>

      {/* Draggable HTML overlays for on-board figures belonging to myPower */}
      {myPower && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {(Object.entries(REGION_POSITIONS) as [RegionId, typeof REGION_POSITIONS[RegionId]][]).flatMap(
            ([regionId, pos]) => {
              const region = state.regions[regionId];
              if (!region) return [];
              const POWER_ORDER: Record<string, number> = { xarm: 0, gormen: 1, tenzen: 2, lasha: 3 };
              const RANK_ORDER: Record<string, number> = { incarnation: 0, warrior: 1, cultist: 2 };
              const sorted = [...followersInRegion(state, regionId)].sort((a, b) => {
                const pa = POWER_ORDER[a.power] ?? 99;
                const pb = POWER_ORDER[b.power] ?? 99;
                if (pa !== pb) return pa - pb;
                return (RANK_ORDER[a.class] ?? 9) - (RANK_ORDER[b.class] ?? 9);
              });
              const figX = pos.x + 4;
              const figY = pos.y + 46;
              return sorted.slice(0, 20).flatMap((fig, i) => {
                if ((fig.controlledBy ?? fig.power) !== myPower) return [];
                const col = i % 10;
                const row = Math.floor(i / 10);
                const svgX = figX + col * 15 + 8;
                const svgY = figY + row * 15 + 8;
                return [
                  <DraggableFigureOverlay
                    key={fig.id}
                    fig={fig}
                    fromRegion={regionId}
                    svgX={svgX}
                    svgY={svgY}
                  />,
                ];
              });
            }
          )}
        </div>
      )}

      {/* Region info hover triggers (top ~30px for info tooltip, full region for battle pane) */}
      {!isDragging && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {(Object.entries(REGION_POSITIONS) as [RegionId, typeof REGION_POSITIONS[RegionId]][]).map(
            ([regionId, pos]) => (
              <div key={regionId}>
                {/* Info tooltip trigger — top strip only */}
                <div
                  onMouseEnter={(e) => setRegionTooltip({ regionId, x: e.clientX, y: e.clientY })}
                  onMouseMove={(e) => setRegionTooltip({ regionId, x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => setRegionTooltip(null)}
                  style={{
                    position: 'absolute',
                    left:   `${(pos.x / 800) * 100}%`,
                    top:    `${(pos.y / 615) * 100}%`,
                    width:  `${(pos.w / 800) * 100}%`,
                    height: `${(30 / 615) * 100}%`,
                    pointerEvents: 'auto',
                    cursor: 'help',
                  }}
                />
                {/* Battle pane trigger — full region, only when there are battle events */}
                {battlePaneEvents && regionsWithBattles.has(regionId) && (
                  <div
                    onMouseEnter={() => setHoveredBattleRegion(regionId)}
                    onMouseLeave={() => setHoveredBattleRegion(null)}
                    style={{
                      position: 'absolute',
                      left:   `${(pos.x / 800) * 100}%`,
                      top:    `${(pos.y / 615) * 100}%`,
                      width:  `${(pos.w / 800) * 100}%`,
                      height: `${(pos.h / 615) * 100}%`,
                      pointerEvents: 'auto',
                    }}
                  />
                )}
              </div>
            ),
          )}
        </div>
      )}

      {tooltip && <CardTooltip cardId={tooltip.cardId} x={tooltip.x} y={tooltip.y} />}
      {regionTooltip && (
        <RegionInfoTooltip state={state} regionId={regionTooltip.regionId} x={regionTooltip.x} y={regionTooltip.y} />
      )}
      {tokenTooltip && (
        <TokenTooltip token={tokenTooltip.token} x={tokenTooltip.x} y={tokenTooltip.y} />
      )}

      {/* Battle pane overlay — positioned next to the active or hovered region */}
      {displayedBattleRegion && battlePaneEvents && (() => {
        const pos = REGION_POSITIONS[displayedBattleRegion];
        if (!pos) return null;
        // Center of the region in SVG coords
        const cx = pos.x + pos.w / 2;
        const cy = pos.y + pos.h / 2;
        // Convert to container percentage
        const leftPct = (cx / BOARD_VIEWBOX_W) * 100;
        const topPct = (cy / BOARD_VIEWBOX_H) * 100;
        // Place pane to the right of region center if region is left half, else to the left
        const placeRight = cx < BOARD_VIEWBOX_W / 2;
        return (
          <div style={{
            position: 'absolute',
            left: placeRight ? `${leftPct + (pos.w / BOARD_VIEWBOX_W) * 50}%` : 'auto',
            right: placeRight ? 'auto' : `${100 - leftPct + (pos.w / BOARD_VIEWBOX_W) * 50}%`,
            top: `${topPct}%`,
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
            zIndex: 50,
          }}>
            <BattlePane regionId={displayedBattleRegion} events={battlePaneEvents} />
          </div>
        );
      })()}

      {/* Domination labels — absolute-positioned above each dominated region */}
      {dominationLabels && [...dominationLabels.entries()].map(([regionId, label]) => {
        const pos = REGION_POSITIONS[regionId];
        if (!pos) return null;
        const leftPct = ((pos.x + pos.w / 2) / BOARD_VIEWBOX_W) * 100;
        const topPct = (pos.y / BOARD_VIEWBOX_H) * 100;
        return (
          <div key={`dom-${regionId}`} style={{
            position: 'absolute',
            left: `${leftPct}%`,
            top: `${topPct}%`,
            transform: 'translate(-50%, -100%)',
            pointerEvents: 'none',
            zIndex: 60,
            whiteSpace: 'nowrap',
            padding: '3px 8px',
            borderRadius: 4,
            background: '#0d0d1fee',
            border: `1.5px solid ${POWER_COLORS[label.power]}`,
            fontSize: '0.72rem',
            fontWeight: 700,
            color: '#e5e7eb',
            boxShadow: `0 0 8px ${POWER_COLORS[label.power]}66`,
          }}>
            Domination: <span style={{ color: POWER_COLORS[label.power] }}>{label.power[0]!.toUpperCase() + label.power.slice(1)}</span> <span style={{ color: '#fbbf24' }}>+{label.vp} VP</span>
          </div>
        );
      })}

      {/* Corruption token fly animations — originate from each cultist of the
          placing power in the region. All circles for one event fire at once. */}
      {corruptionFlies && corruptionFlies.flatMap(fly => {
        const region = state.regions[fly.regionId];
        const pos = REGION_POSITIONS[fly.regionId];
        if (!region || !pos) return [];

        const positions = layoutFigureCluster(followersInRegion(state, fly.regionId), pos.x + 4, pos.y + 46);
        const cultistPositions = positions
          .filter(({ figure: f }) => (f.controlledBy ?? f.power) === fly.power && f.class === 'cultist')
          .map(({ cx, cy }) => ({ x: cx, y: cy }));

        // End point: center of corruption counter circles (right side of region)
        const endSvgX = pos.x + pos.w - 12;
        const endSvgY = pos.y + 36;
        const endLeft = (endSvgX / BOARD_VIEWBOX_W) * 100;
        const endTop  = (endSvgY / BOARD_VIEWBOX_H) * 100;

        // One circle per token, sourcing from cultists (repeat if more tokens than cultists)
        const circles = [];
        const source = cultistPositions.length > 0
          ? cultistPositions
          : [{ x: pos.x + 20, y: pos.y + 60 }]; // fallback if no cultists

        for (let i = 0; i < fly.tokens; i++) {
          const start = source[i % source.length]!;
          const startLeft = (start.x / BOARD_VIEWBOX_W) * 100;
          const startTop  = (start.y / BOARD_VIEWBOX_H) * 100;
          const key = `fly-${fly.id}-${i}`;
          const animName = `corr-fly-${fly.id}-${i}`;
          circles.push(
            <div
              key={key}
              style={{
                position: 'absolute',
                left: `${startLeft}%`,
                top: `${startTop}%`,
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: POWER_COLORS[fly.power],
                boxShadow: `0 0 8px ${POWER_COLORS[fly.power]}`,
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
                zIndex: 70,
                animation: `${animName} 2750ms ease-in forwards`,
              }}
            >
              <style>{`
                @keyframes ${animName} {
                  0%   { left: ${startLeft}%; top: ${startTop}%; opacity: 1; transform: translate(-50%, -50%) scale(1); }
                  85%  { opacity: 1; transform: translate(-50%, -50%) scale(1.2); }
                  100% { left: ${endLeft}%; top: ${endTop}%; opacity: 0; transform: translate(-50%, -50%) scale(0.6); }
                }
              `}</style>
            </div>
          );
        }
        return circles;
      })}
    </div>
  );
}
