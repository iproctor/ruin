import { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { GameState, Power, Action, FollowerClass } from '@ruin/engine';
import { CARD_BY_ID } from '@ruin/engine';
import { POWER_COLORS, POWER_LABELS, shortCardName } from '../lib/display.js';
import CardTooltip from './CardTooltip.js';
import FollowerTooltip from './FollowerTooltip.js';
import type { DragItem } from '../types/drag.js';

interface TableauProps {
  state: GameState;
  displayState?: GameState | null;
  myPower: Power;
  selectedCardId: string | null;
  onSelectCard: (id: string | null) => void;
  pendingAction?: Action | null;
  onUndo?: () => void;
  onEndTurn?: () => void;
  submitError?: string;
  apprenticeChoice?: {
    fromRegion: string;
    toRegion: string;
    onCarry: () => void;
    onLeave: () => void;
  };
}

// ── Draggable hand card ───────────────────────────────────────────────────────

function HandCard({
  cardId,
  power,
  isSelected,
  isPending,
  handIndex,
  onClick,
  onHover,
  isSummoningTurn,
}: {
  cardId: string;
  handIndex: number;
  power: Power;
  isSelected: boolean;
  isPending: boolean;
  onClick?: () => void;
  onHover: (cardId: string | null, x: number, y: number) => void;
  isSummoningTurn: boolean;
}) {
  const def = CARD_BY_ID[cardId];
  const color = POWER_COLORS[power];
  const name = def ? (def.shortName ?? shortCardName(def.name)) : cardId;
  const cost = def?.cost ?? '?';
  const hasMagic = def?.hasMagicSymbol ?? false;

  const dragData: DragItem = { kind: 'hand_card', cardId, power };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `hand_${cardId}_${handIndex}`,
    data: dragData,
    disabled: !isSummoningTurn,
  });

  const showSelected = isSelected && !isSummoningTurn;
  const borderColor = isPending ? '#22c55e' : showSelected ? color : '#3a3a6e';
  const shadow = isPending
    ? '0 0 10px #22c55e88'
    : showSelected
    ? `0 0 10px ${color}88`
    : 'none';

  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onClick}
      onMouseEnter={(e) => onHover(cardId, e.clientX, e.clientY)}
      onMouseMove={(e) => onHover(cardId, e.clientX, e.clientY)}
      onMouseLeave={() => onHover(null, 0, 0)}
      style={{
        position: 'relative',
        width: 71,
        height: 76,
        background: isSelected ? '#1e1433' : '#13121f',
        border: `1.5px ${isPending ? 'dashed' : 'solid'} ${borderColor}`,
        borderRadius: 5,
        cursor: isSummoningTurn ? 'grab' : 'pointer',
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: shadow,
        transition: 'border-color 0.1s, box-shadow 0.1s, transform 0.1s',
        transform: showSelected && !isDragging ? 'translateY(-4px)' : 'none',
        opacity: isDragging ? 0.35 : 1,
        touchAction: 'none',
      }}
    >
      {/* Power color stripe */}
      <div style={{ height: 4, background: color, opacity: 0.9, flexShrink: 0 }} />

      {/* Card name */}
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2px 3px',
        textAlign: 'center',
        fontSize: '0.62rem',
        fontWeight: 700,
        color: '#e5e7eb',
        lineHeight: 1.2,
        wordBreak: 'break-word',
      }}>
        {name}
      </div>

      {/* Bottom row: cost + magic */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '2px 4px 3px',
        borderTop: '1px solid #1e1e3a',
      }}>
        <span style={{
          fontSize: '0.7rem',
          fontWeight: 800,
          color: '#fff',
          background: color,
          borderRadius: 3,
          padding: '0 4px',
          lineHeight: '14px',
        }}>
          {cost}
        </span>
        {hasMagic && (
          <span style={{ fontSize: '0.65rem', color: '#a78bfa' }}>✦</span>
        )}
      </div>
    </button>
  );
}

// ── Draggable reserve follower ────────────────────────────────────────────────

function ReserveFollower({
  followerId,
  followerClass,
  power,
  isSummoningTurn,
  upgradesInPlay,
}: {
  followerId: string;
  followerClass: FollowerClass;
  power: Power;
  isSummoningTurn: boolean;
  upgradesInPlay: string[];
}) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
  const color = POWER_COLORS[power];
  const dragData: DragItem = { kind: 'reserve_follower', followerId, followerClass, power };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `reserve_${followerId}`,
    data: dragData,
    disabled: !isSummoningTurn,
  });

  const shape =
    followerClass === 'incarnation' ? (
      <svg width={12} height={12} viewBox="0 0 12 12">
        <rect x={1} y={1} width={10} height={10} fill={color} opacity={0.9} rx={1} />
      </svg>
    ) : followerClass === 'warrior' ? (
      <svg width={14} height={14} viewBox="0 0 14 14">
        <polygon points="7,1 13,13 1,13" fill={color} opacity={0.9} />
      </svg>
    ) : (
      <svg width={8} height={14} viewBox="0 0 8 14">
        <rect x={2} y={1} width={4} height={12} fill={color} opacity={0.9} rx={1} />
      </svg>
    );

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onMouseEnter={e => setTooltip({ x: e.clientX, y: e.clientY })}
      onMouseMove={e => setTooltip({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setTooltip(null)}
      style={{
        cursor: isSummoningTurn ? 'grab' : 'default',
        opacity: isDragging ? 0.35 : 1,
        touchAction: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {shape}
      {tooltip && !isDragging && (
        <FollowerTooltip
          power={power}
          followerClass={followerClass}
          upgradesInPlay={upgradesInPlay}
          x={tooltip.x}
          y={tooltip.y}
        />
      )}
    </div>
  );
}

// ── Stockpile with draggable followers ────────────────────────────────────────

function Stockpile({
  state,
  power,
  isSummoningTurn,
}: {
  state: GameState;
  power: Power;
  isSummoningTurn: boolean;
}) {
  const ps = state.powers[power]!;
  const color = POWER_COLORS[power];

  const reserveFollowers = ps.followers.filter((f) => f.regionId === null);
  const onBoard = ps.followers.filter((f) => f.regionId !== null).length;

  const byClass = (cls: FollowerClass) => reserveFollowers.filter((f) => f.class === cls);

  const incarnations = byClass('incarnation');
  const warriors = byClass('warrior');
  const cultists = byClass('cultist');

  function renderGroup(followers: typeof reserveFollowers, cls: FollowerClass, count: number) {
    if (count === 0) {
      // Show greyed-out count
      const icon =
        cls === 'incarnation' ? (
          <svg width={12} height={12} viewBox="0 0 12 12">
            <rect x={1} y={1} width={10} height={10} fill="#334155" opacity={0.6} rx={1} />
          </svg>
        ) : cls === 'warrior' ? (
          <svg width={14} height={14} viewBox="0 0 14 14">
            <polygon points="7,1 13,13 1,13" fill="#334155" opacity={0.6} />
          </svg>
        ) : (
          <svg width={8} height={14} viewBox="0 0 8 14">
            <rect x={2} y={1} width={4} height={12} fill="#334155" opacity={0.6} rx={1} />
          </svg>
        );
      return (
        <div className="flex flex-col items-center gap-0.5">
          {icon}
          <span style={{ fontSize: '0.7rem', color: '#334155', fontWeight: 700 }}>0</span>
        </div>
      );
    }

    // Show first follower as draggable + count badge
    const first = followers[0]!;
    return (
      <div className="flex flex-col items-center gap-0.5">
        <ReserveFollower
          key={first.id}
          followerId={first.id}
          followerClass={cls}
          power={power}
          isSummoningTurn={isSummoningTurn}
          upgradesInPlay={ps.upgradesInPlay}
        />
        <span style={{ fontSize: '0.7rem', color, fontWeight: 700 }}>{count}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 shrink-0">
      <div className="text-[10px] text-slate-500 uppercase tracking-wide">Reserve</div>
      <div className="flex gap-2 items-end">
        {renderGroup(incarnations, 'incarnation', incarnations.length)}
        {renderGroup(warriors, 'warrior', warriors.length)}
        {renderGroup(cultists, 'cultist', cultists.length)}
      </div>
      <div className="text-[9px] text-slate-500">{onBoard} on board</div>
    </div>
  );
}

// ── Pending action summary ────────────────────────────────────────────────────

function pendingLabel(action: Action): string {
  if (action.kind === 'summoning_summon_figure') {
    return `→ Summon to ${action.toRegion}`;
  }
  if (action.kind === 'summoning_play_card') {
    const def = CARD_BY_ID[action.cardId];
    const name = def ? (def.shortName ?? shortCardName(def.name)) : action.cardId;
    return `→ Play ${name} to ${action.toRegion}`;
  }
  return `→ ${action.kind}`;
}

// ── Tableau ───────────────────────────────────────────────────────────────────

export default function Tableau({
  state,
  displayState,
  myPower,
  selectedCardId,
  onSelectCard,
  pendingAction,
  onUndo,
  onEndTurn,
  submitError,
  apprenticeChoice,
}: TableauProps) {
  const [tooltip, setTooltip] = useState<{ cardId: string; x: number; y: number } | null>(null);

  const ps = state.powers[myPower]!;
  const color = POWER_COLORS[myPower];
  // Use displayState for live preview (PP spend, hand changes)
  const displayPs = displayState?.powers[myPower] ?? ps;
  const hand = [...displayPs.hand.filter((c) => c !== '?')].sort((a, b) => {
    const ca = CARD_BY_ID[a];
    const cb = CARD_BY_ID[b];
    const costA = ca?.cost ?? 0;
    const costB = cb?.cost ?? 0;
    if (costA !== costB) return costA - costB;
    const nameA = ca?.shortName ?? ca?.name ?? a;
    const nameB = cb?.shortName ?? cb?.name ?? b;
    return nameA.localeCompare(nameB);
  });
  const isSummoningTurn = !!onEndTurn;

  // Which card is pending (played to board)
  const pendingCardId =
    pendingAction?.kind === 'summoning_play_card' ? pendingAction.cardId : null;

  function handleHover(cardId: string | null, x: number, y: number) {
    setTooltip(cardId ? { cardId, x, y } : null);
  }

  return (
    <div
      className="flex gap-4 px-4 py-3 shrink-0"
      style={{
        minHeight: 120,
        background: '#0d0d1f',
        borderTop: `2px solid ${isSummoningTurn ? color : '#1e1e3a'}`,
        transition: 'border-color 0.3s',
      }}
    >
      {/* PP counter */}
      <div className="flex flex-col items-center justify-center shrink-0 min-w-[52px]">
        <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">PP</div>
        <div className="text-3xl font-black leading-none" style={{ color }}>
          {displayPs.powerPoints}
        </div>
        <div className="text-[10px] text-slate-500 mt-1">/ {displayPs.basePowerPoints}</div>
      </div>

      <div className="w-px shrink-0" style={{ background: '#1e1e3a' }} />

      {/* Stockpile — use displayState so reserve count drops immediately on drag */}
      <Stockpile state={displayState ?? state} power={myPower} isSummoningTurn={isSummoningTurn} />

      <div className="w-px shrink-0" style={{ background: '#1e1e3a' }} />

      {/* Card counts */}
      <div className="flex flex-col gap-1 shrink-0 justify-center min-w-[56px]">
        <div className="text-[10px] text-slate-500 uppercase tracking-wide">Cards</div>
        <div className="flex flex-col gap-0.5 text-[11px]">
          <span className="text-slate-300">
            <span className="text-slate-500">Hand </span>
            <span className="font-bold" style={{ color }}>{hand.length}</span>
          </span>
          <span className="text-slate-300">
            <span className="text-slate-500">Deck </span>
            <span className="font-bold text-slate-300">{displayPs.deckIds.length}</span>
          </span>
          <span className="text-slate-300">
            <span className="text-slate-500">Disc </span>
            <span className="font-bold text-slate-400">{displayPs.discardIds.length}</span>
          </span>
        </div>
      </div>

      <div className="w-px shrink-0" style={{ background: '#1e1e3a' }} />

      {/* Hand */}
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        <div className="text-[10px] text-slate-500 uppercase tracking-wide">
          Hand {hand.length === 0 && <span className="normal-case text-slate-600">— empty</span>}
          {isSummoningTurn && hand.length > 0 && (
            <span className="normal-case text-slate-600 ml-1">— drag to play</span>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {hand.map((cardId, i) => (
            <HandCard
              key={`${cardId}_${i}`}
              cardId={cardId}
              handIndex={i}
              power={myPower}
              isSelected={selectedCardId === cardId}
              isPending={cardId === pendingCardId}
              onClick={isSummoningTurn ? undefined : () => onSelectCard(selectedCardId === cardId ? null : cardId)}
              onHover={handleHover}
              isSummoningTurn={isSummoningTurn}
            />
          ))}
        </div>
      </div>

      {/* Right side: action buttons + error + power badge */}
      <div className="flex flex-col items-end justify-between shrink-0 gap-2">
        {/* Error */}
        {submitError && (
          <p style={{ color: '#f87171', fontSize: '0.75rem', maxWidth: 160, textAlign: 'right' }}>
            {submitError}
          </p>
        )}

        {/* Pending preview + undo/end turn */}
        {isSummoningTurn && (
          <div className="flex flex-col items-end gap-1">
            {pendingAction && (
              <span style={{ fontSize: '0.7rem', color: '#22c55e', fontStyle: 'italic' }}>
                {pendingLabel(pendingAction)}
              </span>
            )}
            <div className="flex gap-2">
              {pendingAction && onUndo && (
                <button
                  onClick={onUndo}
                  style={{
                    fontSize: '0.75rem',
                    padding: '4px 12px',
                    borderRadius: 4,
                    border: '1px solid #334155',
                    background: 'transparent',
                    color: '#94a3b8',
                    cursor: 'pointer',
                  }}
                >
                  Undo
                </button>
              )}
              {apprenticeChoice && (
                <div style={{ display: 'flex', gap: 4, marginRight: 'auto' }}>
                  <span style={{ fontSize: '0.7rem', color: '#94a3b8', alignSelf: 'center' }}>Chaos Stone?</span>
                  <button
                    onClick={apprenticeChoice.onCarry}
                    style={{ fontSize: '0.7rem', padding: '3px 8px', borderRadius: 4, border: '1px solid #6366f1', background: '#312e81', color: '#c4b5fd', cursor: 'pointer' }}
                  >
                    Carry
                  </button>
                  <button
                    onClick={apprenticeChoice.onLeave}
                    style={{ fontSize: '0.7rem', padding: '3px 8px', borderRadius: 4, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer' }}
                  >
                    Leave
                  </button>
                </div>
              )}
              {onEndTurn && <button
                onClick={onEndTurn}
                style={{
                  fontSize: '0.75rem',
                  padding: '4px 14px',
                  borderRadius: '0 0 0 4px',
                  border: 'none',
                  background: color,
                  color: '#fff',
                  fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: `0 0 8px ${color}66`,
                }}
              >
                {pendingAction ? 'Confirm & End Turn' : 'End Turn'}
              </button>}
            </div>
          </div>
        )}

      </div>

      {tooltip && (
        <CardTooltip cardId={tooltip.cardId} x={tooltip.x} y={tooltip.y} />
      )}
    </div>
  );
}
