import { useEffect, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { GameState, Power, Action, FollowerClass } from '@ruin/engine';
import { CARD_BY_ID, CHAOS_CARDS, REGIONS, FOLLOWERS } from '@ruin/engine';
import { POWER_COLORS, POWER_LABELS, shortCardName } from '../lib/display.js';
import { POWER_DIM } from '../lib/gameColors.js';
import { followerArt, godArt } from '../lib/art.js';
import { useSound } from '../contexts/SoundContext.js';
import GameCard from './cards/GameCard.js';
import CardTooltip from './CardTooltip.js';
import FollowerTooltip from './FollowerTooltip.js';
import { PowerSigil } from './PowerSigil.js';
import type { DragItem } from '../types/drag.js';
import './tableau.css';

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
  /** During your summoning turn: what you can legally play/summon right now. */
  playable?: { cards: Set<string>; classes: Set<FollowerClass> };
}

// ── Draggable hand card ───────────────────────────────────────────────────────

function HandCard({ cardId, power, isSelected, isPending, handIndex, handSize, onClick, onHover, isSummoningTurn, unplayable }: {
  unplayable?: boolean;
  cardId: string;
  handIndex: number;
  handSize: number;
  power: Power;
  isSelected: boolean;
  isPending: boolean;
  onClick?: () => void;
  onHover: (cardId: string | null, x: number, y: number) => void;
  isSummoningTurn: boolean;
}) {
  const sound = useSound();
  const dragData: DragItem = { kind: 'hand_card', cardId, power };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `hand_${cardId}_${handIndex}`,
    data: dragData,
    disabled: !isSummoningTurn,
  });
  // Fan: cards rotate around a point below the hand.
  const mid = (handSize - 1) / 2;
  const off = handIndex - mid;
  const angle = off * Math.min(5, 26 / Math.max(1, handSize));
  const drop = Math.abs(off) * Math.abs(off) * 1.6;

  const cls = [
    'hand-card',
    isSelected && !isSummoningTurn ? 'is-selected' : '',
    isPending ? 'is-pending' : '',
    isSummoningTurn ? 'is-live' : '',
    isDragging ? 'is-dragging' : '',
    unplayable ? 'is-unplayable' : '',
  ].join(' ');

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cls}
      style={{
        ['--angle' as string]: `${angle}deg`,
        ['--drop' as string]: `${drop}px`,
        // Bigger hands overlap more so the fan never spills past its area.
        margin: `0 ${-6 - Math.max(0, handSize - 7) * 6}px`,
        zIndex: 10 + handIndex,
      }}
      onClick={onClick}
      onMouseEnter={(e) => { onHover(cardId, e.clientX, e.clientY); sound.hover(); }}
      onMouseMove={(e) => onHover(cardId, e.clientX, e.clientY)}
      onMouseLeave={() => onHover(null, 0, 0)}
    >
      <div className="hand-card-deal" style={{ animationDelay: `${handIndex * 70}ms` }}>
        <GameCard cardId={cardId} size="sm" />
      </div>
      {isPending && <div className="hand-card-staged">Staged</div>}
    </div>
  );
}

// ── Draggable reserve follower ────────────────────────────────────────────────

function ReserveFollower({ followerId, followerClass, power, count, isSummoningTurn, upgradesInPlay, unaffordable }: {
  unaffordable?: boolean;
  followerId: string | null;
  followerClass: FollowerClass;
  power: Power;
  count: number;
  isSummoningTurn: boolean;
  upgradesInPlay: string[];
}) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
  const dragData: DragItem = { kind: 'reserve_follower', followerId: followerId ?? '', followerClass, power };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `reserve_${followerId ?? `${power}_${followerClass}_none`}`,
    data: dragData,
    disabled: !isSummoningTurn || !followerId,
  });
  const art = followerArt(power, followerClass);
  const empty = count === 0;
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`res-fig res-${followerClass} ${empty ? 'is-empty' : ''} ${isSummoningTurn && !empty && !unaffordable ? 'is-live' : ''} ${unaffordable && !empty ? 'is-unaffordable' : ''}`}
      style={{ ['--ring' as string]: POWER_COLORS[power], opacity: isDragging ? 0.35 : undefined }}
      onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => setTooltip({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setTooltip(null)}
    >
      <div className="res-fig-art" style={art ? { backgroundImage: `url(${art})` } : undefined} />
      <span className="res-fig-count">{count}</span>
      <span className="res-fig-name">{FOLLOWERS[power][followerClass].name}</span>
      {tooltip && !isDragging && (
        <FollowerTooltip power={power} followerClass={followerClass} upgradesInPlay={upgradesInPlay} x={tooltip.x} y={tooltip.y} />
      )}
    </div>
  );
}

// ── Pending action summary ────────────────────────────────────────────────────

function regionName(id: string): string {
  return REGIONS[id as keyof typeof REGIONS]?.name ?? id;
}

function followerName(power: Power, followerId: string): string {
  const parts = followerId.split('_');
  const cls = parts[1] as FollowerClass | undefined;
  if (cls && FOLLOWERS[power]?.[cls]) return FOLLOWERS[power][cls].name;
  return followerId;
}

function cardName(cardId: string): string {
  const def = CARD_BY_ID[cardId];
  return def ? (def.shortName ?? shortCardName(def.name)) : cardId;
}

function pendingLabel(action: Action): string {
  if (action.kind === 'summoning_summon_figure') return `${followerName(action.power, action.followerId)} → ${regionName(action.toRegion)}`;
  if (action.kind === 'summoning_play_card') return `${cardName(action.cardId)} → ${regionName(action.toRegion)}`;
  if (action.kind === 'card_on_play_choice') return `${cardName(action.cardId)} → ${regionName(action.regionId)}`;
  if (action.kind === 'world_card_effect' || action.kind === 'world_choice') return cardName(action.cardId);
  if (action.kind === 'upgrade_choice') return `Upgrade: ${cardName(action.upgradeCardId)}`;
  if (action.kind === 'hero_removal') return `Remove hero in ${regionName(action.regionId)}`;
  return action.kind;
}

// ── Tableau ───────────────────────────────────────────────────────────────────

export default function Tableau({ state, displayState, myPower, selectedCardId, onSelectCard, pendingAction, onUndo, onEndTurn, submitError, playable }: TableauProps) {
  const [tooltip, setTooltip] = useState<{ cardId: string; x: number; y: number } | null>(null);
  const sound = useSound();

  const ps = state.powers[myPower]!;
  const color = POWER_COLORS[myPower];
  const colorDim = POWER_DIM[myPower];
  const displayPs = displayState?.powers[myPower] ?? ps;
  // Free-play humans have a masked hand in the engine. Show the power's
  // full roster so they can drag/click any of their card types.
  const freePlay = !!state.companionOptions?.humanPlaysFree && displayPs.playerType === 'human';
  const rawHand = freePlay
    ? CHAOS_CARDS.filter((c) => c.power === myPower).map((c) => c.id)
    : displayPs.hand.filter((c) => c !== '?');
  const hand = [...rawHand].sort((a, b) => {
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
  // Stable keys (card id + occurrence) so only genuinely new cards animate in.
  const seen = new Map<string, number>();
  const handKeys = hand.map((id) => {
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return `${id}#${n}`;
  });

  // Enter confirms the staged action (never an accidental Pass; ignored while typing).
  useEffect(() => {
    if (!isSummoningTurn || !onEndTurn || !pendingAction) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      onEndTurn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSummoningTurn, onEndTurn, pendingAction]);

  const pendingCardId = pendingAction?.kind === 'summoning_play_card' ? pendingAction.cardId : null;
  const reserveState = (displayState ?? state).powers[myPower]!;
  const reserve = reserveState.followers.filter((f) => f.regionId === null);
  const onBoard = reserveState.followers.length - reserve.length;
  const byClass = (cls: FollowerClass) => reserve.filter((f) => f.class === cls);
  const portrait = godArt(myPower);

  return (
    <div
      className={`tab ${isSummoningTurn ? 'is-turn' : ''}`}
      style={{ ['--accent' as string]: color, ['--accent-dim' as string]: colorDim }}
    >
      {/* God + power points */}
      <div className="tab-god">
        <div className="tab-god-portrait" style={portrait ? { backgroundImage: `url(${portrait})` } : undefined}>
          {!portrait && <span style={{ color }}><PowerSigil power={myPower} size={40} /></span>}
        </div>
        <div className="tab-pp" title="Power points">
          <span className="tab-pp-now">{displayPs.powerPoints}</span>
          <span className="tab-pp-max">/ {displayPs.basePowerPoints}</span>
        </div>
        <div className="tab-god-name">{POWER_LABELS[myPower]}</div>
      </div>

      {/* Reserve */}
      <div className="tab-section tab-reserve">
        <div className="tab-label">Reserve <span>· {onBoard} on board</span></div>
        <div className="tab-reserve-row">
          {(['incarnation', 'warrior', 'cultist'] as FollowerClass[]).map((cls) => {
            const list = byClass(cls);
            return (
              <ReserveFollower
                key={cls}
                followerId={list[0]?.id ?? null}
                followerClass={cls}
                power={myPower}
                count={list.length}
                isSummoningTurn={isSummoningTurn}
                upgradesInPlay={ps.upgradesInPlay}
                unaffordable={!!playable && !playable.classes.has(cls)}
              />
            );
          })}
        </div>
      </div>

      {/* Deck / discard */}
      <div className="tab-section tab-decks">
        <div className="tab-deck" title="Deck">
          <GameCard cardId="back" size="xs" faceDown />
          <span>{displayPs.deckIds.length}</span>
        </div>
        <div className="tab-deck is-discard" title="Discard pile">
          <GameCard cardId="back" size="xs" faceDown />
          <span>{displayPs.discardIds.length}</span>
        </div>
      </div>

      {/* Hand */}
      <div className="tab-hand-wrap">
        <div className="tab-label tab-hand-label">
          {freePlay ? 'Your cards' : 'Hand'}
          {!freePlay && hand.length === 0 && <span> — empty</span>}
          {isSummoningTurn && hand.length > 0 && <span> — drag onto a region</span>}
        </div>
        <div className="tab-hand">
          {hand.map((cardId, i) => (
            <HandCard
              key={handKeys[i]}
              cardId={cardId}
              handIndex={i}
              handSize={hand.length}
              power={myPower}
              isSelected={selectedCardId === cardId}
              isPending={cardId === pendingCardId}
              onClick={isSummoningTurn ? undefined : () => onSelectCard(selectedCardId === cardId ? null : cardId)}
              onHover={(id, x, y) => setTooltip(id ? { cardId: id, x, y } : null)}
              isSummoningTurn={isSummoningTurn}
              unplayable={!!playable && !playable.cards.has(cardId)}
            />
          ))}
        </div>
      </div>

      {/* Commit */}
      <div className="tab-actions">
        {submitError && <p className="tab-error">{submitError}</p>}
        {isSummoningTurn && onEndTurn && (
          <div className="tab-buttons">
            {pendingAction && onUndo && (
              <button className="tab-undo" onClick={() => { sound.click(); onUndo(); }}>Undo</button>
            )}
            <button className={`tab-commit ${pendingAction ? 'is-confirm' : 'is-pass'}`} onClick={() => { sound.click(); onEndTurn(); }}>
              {pendingAction ? (
                <>
                  <span className="tab-commit-main">Confirm</span>
                  <span className="tab-commit-sub">{pendingLabel(pendingAction)}</span>
                </>
              ) : (
                <>
                  <span className="tab-commit-main">Pass</span>
                  <span className="tab-commit-sub">forfeit remaining power</span>
                </>
              )}
            </button>
          </div>
        )}
        {!isSummoningTurn && <div className="tab-waiting">Awaiting the other gods…</div>}
      </div>

      {tooltip && <CardTooltip cardId={tooltip.cardId} x={tooltip.x} y={tooltip.y} />}
    </div>
  );
}
