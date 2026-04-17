import { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import type { GameState, RegionId, Power, TokenType, FollowerInstance, Action } from '@ruin/engine';
import { CARD_BY_ID, WORLD_CARD_BY_ID, REGIONS, getRegionDomination, getRegionResistance, getPowerDomination, ADJACENCY, followersInRegion } from '@ruin/engine';
import { POWER_COLORS, shortCardName } from '../lib/display.js';
import { INK, SOOT, PARCHMENT, BORDER, PAPER, PAPER_DIM, PAPER_FADE, BRASS, BRASS_HOT, CARD_FACE, CARD_INK, MAGIC, HIGHLIGHT, RUINED, RUINED_TEXT, PENDING, ERROR } from '../lib/gameColors.js';
import CardTooltip from './CardTooltip.js';
import FollowerTooltip from './FollowerTooltip.js';
import BattlePane from './BattlePane.js';
import type { DragItem } from '../types/drag.js';

// ── Region layout ─────────────────────────────────────────────────────────────

// SVG viewBox: 800 × 615
export const BOARD_VIEWBOX_W = 800;
export const BOARD_VIEWBOX_H = 730;
// Canvas is 800×720 — slightly rectangular, with the top 80 of the original
// 800×800 source image cropped so the map sits flush under the status bar.
// Region positions are rotated 90° CW around the board centre (400, 360)
// so they line up with the map image (which is also rotated 90° CW).
// The cards themselves stay axis-aligned (horizontal) — only the centres
// move. For an old centre (cx, cy), the new top-left is (615 - cy, cx - 15).
export const REGION_POSITIONS: Record<RegionId, { x: number; y: number; w: number; h: number; label: string }> = {
  norrsund:    { x: 230,  y: 40, w: 170, h: 120, label: 'Norrsund' },
  talvimaa:    { x: 550, y: 20, w: 170, h: 120, label: 'Talvimaa' },
  volensk:     { x: 615, y: 180, w: 170, h: 120, label: 'Volensk' },
  mittelreich: { x: 425, y: 272, w: 170, h: 120, label: 'Mittelreich' },
  normagne:    { x: 245, y: 382, w: 170, h: 120, label: 'Normagne' },
  almerida:    { x: 80,  y: 550, w: 170, h: 120, label: 'Almerida' },
  toscavar:    { x: 275, y: 600, w: 170, h: 120, label: 'Toscavar' },
  pelascos:    { x: 580, y: 460, w: 170, h: 120, label: 'Pelascos' },
  the_barrens: { x: 610, y: 600, w: 170, h: 120, label: 'The Barrens' },
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
  const sorted = sortFigures(figures);
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

function sortFigures(figures: FollowerInstance[]): FollowerInstance[] {
  return [...figures].sort((a, b) => {
    const pa = FIGURE_POWER_ORDER[a.power] ?? 99;
    const pb = FIGURE_POWER_ORDER[b.power] ?? 99;
    if (pa !== pb) return pa - pb;
    return (FIGURE_RANK_ORDER[a.class] ?? 0) - (FIGURE_RANK_ORDER[b.class] ?? 0);
  });
}

/** A slot in the figure cluster — either a single figure, or a collapsed group
 *  of ≥ 5 identical ones displayed as one symbol plus an "×N" badge. Shielded
 *  or enthralled figures form their own group so they don't hide in the stack. */
export type FigureSlot =
  | { kind: 'single'; figure: FollowerInstance }
  | { kind: 'group'; representative: FollowerInstance; count: number; members: FollowerInstance[] };

const GROUP_THRESHOLD = 3;

function figureGroupKey(f: FollowerInstance): string {
  return `${f.power}|${f.class}|${f.controlledBy ?? ''}|${f.protected ? 1 : 0}|${f.tipped ? 1 : 0}`;
}

/** Build cluster slots, collapsing identical figures into groups when > 4. */
export function buildFigureSlots(figures: FollowerInstance[]): FigureSlot[] {
  const sorted = sortFigures(figures);
  const byKey = new Map<string, FollowerInstance[]>();
  const order: string[] = [];
  for (const f of sorted) {
    const k = figureGroupKey(f);
    if (!byKey.has(k)) { byKey.set(k, []); order.push(k); }
    byKey.get(k)!.push(f);
  }
  const slots: FigureSlot[] = [];
  for (const k of order) {
    const grp = byKey.get(k)!;
    if (grp.length > GROUP_THRESHOLD) {
      slots.push({ kind: 'group', representative: grp[0]!, count: grp.length, members: grp });
    } else {
      for (const f of grp) slots.push({ kind: 'single', figure: f });
    }
  }
  return slots;
}

export interface FigureSlotPosition { slot: FigureSlot; index: number; cx: number; cy: number }

/** A collapsed group reserves two cells so its "×N" badge doesn't overlap
 *  the next figure to the right. */
function slotCellWidth(slot: FigureSlot): 1 | 2 {
  return slot.kind === 'group' ? 2 : 1;
}

/** Total cells occupied by a slot list (used to place the "+" button). */
export function slotsCellCount(slots: FigureSlot[]): number {
  return slots.reduce((acc, s) => acc + slotCellWidth(s), 0);
}

/** Position slots in the grid. Groups claim two adjacent cells and wrap to
 *  the next row if they wouldn't fit on the current one. */
export function layoutFigureSlots(
  slots: FigureSlot[],
  baseX: number,
  baseY: number,
): FigureSlotPosition[] {
  const out: FigureSlotPosition[] = [];
  let cursor = 0;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    const width = slotCellWidth(slot);
    const col = cursor % FIGURE_COLS;
    if (col + width > FIGURE_COLS) {
      // Wrap — skip to start of next row
      cursor = (Math.floor(cursor / FIGURE_COLS) + 1) * FIGURE_COLS;
    }
    if (cursor >= FIGURE_MAX) break;
    const finalCol = cursor % FIGURE_COLS;
    const finalRow = Math.floor(cursor / FIGURE_COLS);
    out.push({
      slot, index: i,
      cx: baseX + finalCol * FIGURE_STEP + FIGURE_CENTER_OFFSET,
      cy: baseY + finalRow * FIGURE_STEP + FIGURE_CENTER_OFFSET,
    });
    cursor += width;
  }
  return out;
}

// ── Figure cluster ────────────────────────────────────────────────────────────

function FigureCluster({ figures, x, y, powers, animationKilledIds, hideKilled, myPower, summoningAnim }: {
  figures: FollowerInstance[];
  x: number;
  y: number;
  powers: GameState['powers'];
  myPower?: Power | null;
  summoningAnim?: { appearingFigures: Set<string>; movingFigures: Map<string, { fromRegion: string; toRegion: string }>; appearingCards: Set<string> };
  animationKilledIds?: Set<string>;
  hideKilled?: boolean;
}) {
  const [hovered, setHovered] = useState<{ fig: FollowerInstance; mx: number; my: number } | null>(null);
  const filteredFigures = hideKilled && animationKilledIds
    ? figures.filter(f => !animationKilledIds.has(f.id))
    : figures;
  const slots = buildFigureSlots(filteredFigures);
  const positions = layoutFigureSlots(slots, x, y);
  const overflow = slots.length - positions.length;
  void myPower;

  return (
    <g>
      {positions.map(({ slot, cx: fx, cy: fy, index }) => {
        const fig = slot.kind === 'single' ? slot.figure : slot.representative;
        const members = slot.kind === 'group' ? slot.members : [fig];
        const color = POWER_COLORS[fig.power];
        const isAnimKilled = members.every((m) => animationKilledIds?.has(m.id) ?? false);
        const op = (fig.tipped || isAnimKilled) ? 0.3 : 0.9;
        const controlledColor = fig.controlledBy ? POWER_COLORS[fig.controlledBy] : undefined;
        const glowStroke = isAnimKilled ? '#ef4444' : fig.protected ? HIGHLIGHT : controlledColor;
        const needsOuterRing = !!controlledColor && glowStroke !== controlledColor;
        const sp = { fill: color, opacity: op, stroke: glowStroke ?? '#111', strokeWidth: glowStroke ? 1.5 : 0.5 };
        const isAppearing = members.some((m) => summoningAnim?.appearingFigures.has(m.id) ?? false);
        const isMoving = members.some((m) => summoningAnim?.movingFigures.has(m.id) ?? false);
        const animStyle = (isAppearing || isMoving) ? 'summoning-appear' : undefined;
        const key = slot.kind === 'single' ? slot.figure.id : `grp-${index}-${figureGroupKey(fig)}`;
        return (
          <g key={key}>
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
              onMouseEnter={e => setHovered({ fig, mx: e.clientX, my: e.clientY })}
              onMouseMove={e => setHovered({ fig, mx: e.clientX, my: e.clientY })}
              onMouseLeave={() => setHovered(null)}
            >
              {needsOuterRing && fig.class === 'incarnation' && <Square   cx={fx} cy={fy} r={10} fill="none" opacity={op} stroke={controlledColor!} strokeWidth={1.5} />}
              {needsOuterRing && fig.class === 'warrior'     && <Triangle cx={fx} cy={fy} r={8}  fill="none" opacity={op} stroke={controlledColor!} strokeWidth={1.5} />}
              {needsOuterRing && fig.class === 'cultist'     && <CultistShape cx={fx} cy={fy}    fill="none" opacity={op} stroke={controlledColor!} strokeWidth={1.5} />}
              {fig.class === 'incarnation' && <Square   cx={fx} cy={fy} r={8} {...sp} />}
              {fig.class === 'warrior'     && <Triangle cx={fx} cy={fy} r={6} {...sp} />}
              {fig.class === 'cultist'     && <CultistShape cx={fx} cy={fy} {...sp} />}
              {slot.kind === 'group' && (
                <text
                  x={fx + 7} y={fy + 3}
                  fill={PAPER} fontSize="8" fontWeight={700}
                  style={{ userSelect: 'none', paintOrder: 'stroke' }}
                  stroke={INK} strokeWidth={2}
                  strokeLinejoin="round"
                >
                  ×{slot.count}
                </text>
              )}
            </g>
          </g>
        );
      })}
      {overflow > 0 && (
        <text x={x + FIGURE_COLS * FIGURE_STEP + 2} y={y + 11} fill={PAPER_DIM} fontSize="8" fontStyle="italic">+{overflow}</text>
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

function MiniCard({ cardId, width, height, onHover, isPending, isAppearing }: {
  cardId: string; width: number; height: number;
  onHover: (id: string | null, x: number, y: number) => void;
  isPending?: boolean;
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
          fill={isPending ? '#1a2a1a' : CARD_FACE}
          stroke={isPending ? PENDING : isPersistent ? accentColor : BORDER}
          strokeWidth={isPending ? 2 : isPersistent ? 1.5 : 0.75}
          strokeDasharray={isPending ? '3 2' : undefined}
        />
      <rect width={width} height={3} rx={1} fill={accentColor} opacity={0.95} />
      <text x={3} y={12} fill={CARD_INK} fontSize="8" fontWeight="600"
        fontFamily="'Cinzel', serif" letterSpacing="0.02em"
        style={{ userSelect: 'none' }}>
        {name.slice(0, 10)}
      </text>
      {cost !== null && (
        <g transform={`translate(${width - 13}, ${height - 13})`}>
          <circle cx={6} cy={6} r={6} fill={accentColor} opacity={0.9} />
          <text x={6} y={9} textAnchor="middle" fill="#fff" fontSize="8" fontWeight="700">{cost}</text>
        </g>
      )}
      {hasMagic && <text x={3} y={height - 3} fill={MAGIC} fontSize="8">✦</text>}
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
        left:   `${(pos.x / BOARD_VIEWBOX_W) * 100}%`,
        top:    `${(pos.y / BOARD_VIEWBOX_H) * 100}%`,
        width:  `${(pos.w / BOARD_VIEWBOX_W) * 100}%`,
        height: `${(pos.h / BOARD_VIEWBOX_H) * 100}%`,
        borderRadius: 6,
        background: isOver ? 'rgba(250,204,21,0.12)' : 'transparent',
        border:    isOver ? `2px solid ${HIGHLIGHT}` : '2px solid transparent',
        boxSizing: 'border-box',
        transition: 'background 0.1s, border-color 0.1s',
        pointerEvents: active ? 'all' : 'none',
        cursor: onClick ? 'pointer' : 'default',
      }}
    />
  );
}

// ── Draggable figure overlay ──────────────────────────────────────────────────

// Board container has the same aspect ratio as the SVG viewBox.
// Convert SVG coords to percentages for absolute HTML positioning.
function svgPct(svgCoord: number, axis: 'x' | 'y') {
  return `${(svgCoord / (axis === 'x' ? BOARD_VIEWBOX_W : BOARD_VIEWBOX_H)) * 100}%`;
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
        background: 'transparent',
        zIndex: 5,
        touchAction: 'none',
        pointerEvents: 'auto',
      }}
    />
  );
}

// ── Region SVG content ────────────────────────────────────────────────────────

function RegionContent({ regionId, pos, state, isHighlighted, isDimmed, pendingCardSlot, onCardHover, onTokenHover, isAnimationTarget, animationKilledIds, hideKilled, corruptionOverride, myPower, summoningAnim, onSlotClick, slotPlayable, onSummonClick, canSummon }: {
  regionId: RegionId;
  pos: typeof REGION_POSITIONS[RegionId];
  state: GameState;
  isHighlighted: boolean;
  isDimmed: boolean;
  pendingCardSlot: { slotIndex: number; cardId: string } | null;
  onCardHover: (id: string | null, x: number, y: number) => void;
  onTokenHover: (token: TokenType | null, x: number, y: number) => void;
  isAnimationTarget: boolean;
  animationKilledIds?: Set<string>;
  hideKilled?: boolean;
  corruptionOverride?: Partial<Record<Power, number>>;
  myPower?: Power | null;
  summoningAnim?: { appearingFigures: Set<string>; movingFigures: Map<string, { fromRegion: string; toRegion: string }>; appearingCards: Set<string> };
  onSlotClick?: (regionId: RegionId, slotIndex: 0 | 1, x: number, y: number) => void;
  slotPlayable?: (regionId: RegionId, slotIndex: 0 | 1) => boolean;
  onSummonClick?: (regionId: RegionId, x: number, y: number) => void;
  canSummon?: (regionId: RegionId) => boolean;
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

      {/* Background — 50% transparent so the map shows through */}
      <rect x={x} y={y} width={w} height={h} rx={6}
        fill={isRuined ? '#1a0808' : SOOT}
        fillOpacity={0.85}
        stroke={
          isAnimationTarget ? '#ef4444' :
          isHighlighted ? HIGHLIGHT :
          isRuined ? RUINED : BORDER
        }
        strokeWidth={isAnimationTarget ? 3 : isHighlighted ? 2.5 : 1}
        style={isAnimationTarget ? { filter: 'drop-shadow(0 0 8px #ef4444)' } : undefined}
      />

      {/* Name */}
      <text x={x + w / 2} y={y + 14} textAnchor="middle"
        fill={isRuined ? ERROR : PAPER} fontSize="11" fontWeight="600"
        fontFamily="'Cinzel', serif"
        letterSpacing="0.05em"
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
        const cColor = topRuiner ? POWER_COLORS[topRuiner] : PAPER_FADE;
        const parts: { label: string; color: string; bold?: boolean }[] = [
          { label: `R${R}`, color: PAPER_FADE },
          { label: `V${V}`, color: PAPER_FADE },
        ];
        if (isRuined) {
          parts.push({ label: 'RUINED', color: ERROR, bold: true });
        } else {
          if (dom.leader) {
            parts.push({ label: `D${dom.value}`, color: POWER_COLORS[dom.leader], bold: true });
          } else {
            const allPowers: Power[] = ['xarm', 'gormen', 'tenzen', 'lasha'];
            let bestPw: Power | null = null;
            let bestDom = 0;
            for (const pw of allPowers) {
              const d = getPowerDomination(state, regionId, pw);
              if (d > bestDom) { bestDom = d; bestPw = pw; }
            }
            if (bestPw && bestDom > 0) {
              parts.push({ label: `D${bestDom - R}`, color: POWER_COLORS[bestPw], bold: false });
            }
          }
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
        <text x={x + w - 5} y={y + 25} textAnchor="end" fill={HIGHLIGHT} fontSize="8" fontWeight="700">POP</text>
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
        <FigureCluster figures={figures} x={x + 4} y={y + 46} powers={state.powers} animationKilledIds={animationKilledIds} hideKilled={hideKilled} myPower={myPower} summoningAnim={summoningAnim} />
      ); })()}

      {/* Summon (+) button — placed in the figure cluster after all followers */}
      {!isRuined && onSummonClick && canSummon?.(regionId) && (() => {
        const count = slotsCellCount(buildFigureSlots(followersInRegion(state, regionId)));
        const col = count % FIGURE_COLS;
        const row = Math.floor(count / FIGURE_COLS);
        const cx = (x + 4) + col * FIGURE_STEP + FIGURE_CENTER_OFFSET;
        const cy = (y + 46) + row * FIGURE_STEP + FIGURE_CENTER_OFFSET;
        return (
          <g
            style={{ cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); onSummonClick(regionId, e.clientX, e.clientY); }}
          >
            <circle cx={cx} cy={cy} r={6}
              fill={SOOT} stroke={BRASS} strokeWidth={1.1} />
            <text
              x={cx + 0.25} y={cy-0.6}
              textAnchor="middle" dominantBaseline="central"
              fill={PAPER} fontSize="10" fontWeight={800}
              style={{ userSelect: 'none', pointerEvents: 'none' }}
            >
              +
            </text>
          </g>
        );
      })()}

      {/* Card slots — hidden when region is ruined */}
      {!isRuined && <g transform={`translate(${x + 4}, ${cardSlotY})`}>
        {[0, 1].map((si) => {
          const card = displayCards[si];
          const isPending = pendingCardSlot?.slotIndex === si;
          const slotIdx = si as 0 | 1;
          const canClick = !card && !!onSlotClick && (slotPlayable?.(regionId, slotIdx) ?? false);
          return (
            <g key={si} transform={`translate(${si * (cardSlotW + 4)}, 0)`}>
              {card ? (
                <MiniCard cardId={card.cardId} width={cardSlotW} height={cardSlotH} onHover={onCardHover} isPending={isPending}
                  isAppearing={summoningAnim?.appearingCards.has(`${regionId}-${si}`) ?? false} />
              ) : (
                <rect width={cardSlotW} height={cardSlotH} rx={3}
                  fill={canClick ? SOOT : 'none'}
                  stroke={canClick ? BRASS : BORDER}
                  strokeWidth={canClick ? 1 : 0.75}
                  strokeDasharray="3 2"
                  style={canClick ? { cursor: 'pointer' } : undefined}
                  onClick={canClick ? (e) => {
                    e.stopPropagation();
                    onSlotClick!(regionId, slotIdx, e.clientX, e.clientY);
                  } : undefined}
                />
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
  ratmen: "Lowers the region's resistance by 1 while present.",
  chaos_stone: 'Counts as +1 corruption in this region during the corruption phase. Tenzen gains dial advancement when corrupting a region with 2 chaos stones/magic symbols.',
};

function TokenTooltip({ token, x, y }: { token: TokenType; x: number; y: number }) {
  const left = Math.min(x + 14, window.innerWidth - 240);
  const top  = Math.min(y + 14, window.innerHeight - 140);
  const color = TOKEN_COLORS[token];
  return createPortal(
    <div
      className="gt"
      style={{
        left,
        top,
        width: 240,
        ['--tt-accent' as string]: color,
        ['--tt-glow' as string]: `${color}55`,
      }}
    >
      <div className="gt-title" style={{ margin: 0, marginBottom: 4 }}>{TOKEN_NAMES[token]}</div>
      <div className="gt-body" style={{ fontSize: '0.82rem' }}>{TOKEN_DESCRIPTIONS[token]}</div>
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
    <div className="gt" style={{ left, top, width: 240 }}>
      <div className="gt-title" style={{ margin: 0, marginBottom: 4 }}>{def.name}</div>
      {def.populous && (
        <div className="gt-sublabel" style={{ color: 'var(--game-brass-hot)', marginBottom: 4 }}>Populous</div>
      )}
      <div className="gt-body" style={{ fontSize: '0.85rem' }}>
        <span className="gt-fade">resistance </span><strong style={{ color: 'var(--game-paper)', fontStyle: 'normal' }}>{resistance}</strong>
      </div>
      <div className="gt-body" style={{ fontSize: '0.85rem' }}>
        <span className="gt-fade">VP reward </span><strong style={{ color: 'var(--game-paper)', fontStyle: 'normal' }}>{vp}</strong>
        {(tokenCounts.get('noble') ?? 0) > 0 && (
          <span className="gt-fade"> ({region.conquestValue} base + {tokenCounts.get('noble')} noble)</span>
        )}
      </div>
      {region.ruinationCardIndex !== null ? (
        <div className="gt-divider" style={{ paddingTop: 6, fontFamily: "'Cinzel', serif", fontWeight: 800, letterSpacing: '0.24em', color: RUINED_TEXT, fontSize: '0.85rem' }}>
          RUINED
        </div>
      ) : (
        <>
          <div className="gt-sublabel" style={{ marginTop: 8, marginBottom: 3 }}>Domination</div>
          {domEntries.length === 0 && <div className="gt-fade">—</div>}
          {domEntries.map(({ p, d }) => (
            <div key={p} style={{ fontFamily: "'IM Fell English', serif", fontSize: '0.85rem' }}>
              <span style={{ color: POWER_COLORS[p], fontFamily: "'Cinzel', serif", fontWeight: 700, fontSize: '0.72rem', letterSpacing: '0.16em' }}>{POWER_LABELS[p]}</span>
              <span className="gt-fade"> · </span>
              <span style={{ color: d > resistance ? 'var(--game-paper)' : 'var(--game-paper-fade)' }}>{d}</span>
            </div>
          ))}
          <div className="gt-body" style={{ fontSize: '0.85rem', marginTop: 6 }}>
            <span className="gt-fade">corruption </span><strong style={{ color: 'var(--game-paper)', fontStyle: 'normal' }}>{corruptionTotal}</strong>
            {cultCount > 0 && <span className="gt-fade"> (+{cultCount} incoming)</span>}
          </div>
          {willRuin && (
            <div style={{ marginTop: 6, color: RUINED_TEXT, fontFamily: "'Cinzel', serif", fontWeight: 700, fontSize: '0.72rem', letterSpacing: '0.18em' }}>
              ⚠ May ruin this round
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
  onSlotClick?: (regionId: RegionId, slotIndex: 0 | 1, x: number, y: number) => void;
  slotPlayable?: (regionId: RegionId, slotIndex: 0 | 1) => boolean;
  onSummonClick?: (regionId: RegionId, x: number, y: number) => void;
  canSummon?: (regionId: RegionId) => boolean;
}

export default function Board({ state, highlightRegions, dimmedRegions, pendingAction, onRegionClick, myPower, animationRegion, animationKilledIds, hideKilled, battlePaneEvents, dominationLabels, corruptionOverrides, corruptionFlies, summoningAnim, onSlotClick, slotPlayable, onSummonClick, canSummon }: BoardProps) {
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
  const isDragging = (highlightRegions !== undefined || dimmedRegions !== undefined);

  return (
    <div
      className="board-wrap"
      style={{
        position: 'relative',
        height: '100%',
        aspectRatio: '800 / 730',
        maxWidth: '100%',
        overflow: 'hidden',
        borderRadius: 8,
      }}
    >
      {/* Square board. Map at original orientation, sliced to cover. */}
      <svg
        viewBox="0 0 800 730"
        style={{ position: 'relative', width: '100%', height: '100%', display: 'block', borderRadius: 8, background: 'transparent' }}
      >
        <image
          href="/world_map.jpg"
          x={0}
          y={0}
          width={800}
          height={800}
          preserveAspectRatio="xMidYMid slice"
          opacity={0.9}
        />
        {/* Subtle darken so region boxes stay legible over the map */}
        <rect x={0} y={0} width={800} height={730} fill={INK} opacity={0.22} />
        {/* Connection lines between adjacent regions. Lines run center-to-center
            but are clipped to the gap between the two region rects so they don't
            disappear behind the (now semi-transparent) region backgrounds. */}
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
                const ax = pa.x + pa.w / 2;
                const ay = pa.y + pa.h / 2;
                const bx = pb.x + pb.w / 2;
                const by = pb.y + pb.h / 2;
                const dx = bx - ax;
                const dy = by - ay;
                // Parametric t in [0,1] from A's center to B's center.
                // t_exitA = smallest positive t where ray crosses A's edge.
                // t_enterB = largest t < 1 where ray crosses B's edge.
                let tExitA = 1;
                if (dx > 0) tExitA = Math.min(tExitA, (pa.x + pa.w - ax) / dx);
                if (dx < 0) tExitA = Math.min(tExitA, (pa.x - ax) / dx);
                if (dy > 0) tExitA = Math.min(tExitA, (pa.y + pa.h - ay) / dy);
                if (dy < 0) tExitA = Math.min(tExitA, (pa.y - ay) / dy);
                let tEnterB = 0;
                if (dx > 0) tEnterB = Math.max(tEnterB, (pb.x - ax) / dx);
                if (dx < 0) tEnterB = Math.max(tEnterB, (pb.x + pb.w - ax) / dx);
                if (dy > 0) tEnterB = Math.max(tEnterB, (pb.y - ay) / dy);
                if (dy < 0) tEnterB = Math.max(tEnterB, (pb.y + pb.h - ay) / dy);
                // Pull endpoints slightly inward from the region edges.
                const pad = 0.06 * (tEnterB - tExitA);
                const t1 = tExitA + pad;
                const t2 = tEnterB - pad;
                if (t2 <= t1) continue;  // regions overlap or touch — no gap to draw in
                const darkEdges = new Set(['pelascos|toscavar']);
                const edgeColor = darkEdges.has(key) ? INK : BRASS;
                lines.push(
                  <line key={key}
                    x1={ax + dx * t1} y1={ay + dy * t1}
                    x2={ax + dx * t2} y2={ay + dy * t2}
                    stroke={edgeColor} strokeWidth={2} opacity={0.6}
                    strokeDasharray="6 4" strokeLinecap="round" />
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
              isAnimationTarget={animationRegion === regionId}
              animationKilledIds={animationKilledIds}
              hideKilled={hideKilled}
              corruptionOverride={corruptionOverrides?.get(regionId)}
              myPower={myPower}
              summoningAnim={summoningAnim}
              onSlotClick={onSlotClick}
              slotPlayable={slotPlayable}
              onSummonClick={onSummonClick}
              canSummon={canSummon}
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

      {/* Draggable HTML overlays for on-board figures belonging to myPower.
          Positions mirror the SVG figure cluster — one overlay per cluster
          slot (collapsed groups get a single overlay, dragging spawns the
          representative figure which is equivalent to any member). */}
      {myPower && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {(Object.entries(REGION_POSITIONS) as [RegionId, typeof REGION_POSITIONS[RegionId]][]).flatMap(
            ([regionId, pos]) => {
              const region = state.regions[regionId];
              if (!region) return [];
              const slots = buildFigureSlots(followersInRegion(state, regionId));
              const positions = layoutFigureSlots(slots, pos.x + 4, pos.y + 46);
              return positions.flatMap(({ slot, cx: svgX, cy: svgY }) => {
                const fig = slot.kind === 'single' ? slot.figure : slot.representative;
                if ((fig.controlledBy ?? fig.power) !== myPower) return [];
                return [
                  <DraggableFigureOverlay
                    key={slot.kind === 'single' ? slot.figure.id : `grp-${svgX}-${svgY}`}
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
                    left:   `${(pos.x / BOARD_VIEWBOX_W) * 100}%`,
                    top:    `${(pos.y / BOARD_VIEWBOX_H) * 100}%`,
                    width:  `${(pos.w / BOARD_VIEWBOX_W) * 100}%`,
                    height: `${(30 / BOARD_VIEWBOX_H) * 100}%`,
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
                      left:   `${(pos.x / BOARD_VIEWBOX_W) * 100}%`,
                      top:    `${(pos.y / BOARD_VIEWBOX_H) * 100}%`,
                      width:  `${(pos.w / BOARD_VIEWBOX_W) * 100}%`,
                      height: `${(pos.h / BOARD_VIEWBOX_H) * 100}%`,
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
            background: `${INK}ee`,
            border: `1.5px solid ${POWER_COLORS[label.power]}`,
            fontSize: '0.72rem',
            fontWeight: 700,
            color: PAPER,
            boxShadow: `0 0 8px ${POWER_COLORS[label.power]}66`,
          }}>
            Domination: <span style={{ color: POWER_COLORS[label.power] }}>{label.power[0]!.toUpperCase() + label.power.slice(1)}</span> <span style={{ color: BRASS_HOT }}>+{label.vp} VP</span>
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
                animation: `${animName} 800ms ease-in forwards`,
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
